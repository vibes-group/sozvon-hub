// Package rooms manages dynamic ephemeral video rooms. Each room is a row in the
// SQLite rooms table plus, while in use, a live SFU room created lazily on first
// join and torn down when the last participant leaves. A background sweeper ends
// unused links past their TTL and reaps any live room that has emptied.
package rooms

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/base32"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/pion/webrtc/v4"

	"sozvon-hub/backend/internal/filestore"
	"sozvon-hub/backend/internal/sfu"
	"sozvon-hub/backend/internal/sfu/protocol"
)

const timeFormat = "2006-01-02T15:04:05.000000000Z"

// slugAlphabet is Crockford-ish base32 without padding; lowercase, no ambiguous
// characters, URL-safe. 16 chars over 32 symbols ≈ 80 bits of entropy — the slug
// is the access control (Jitsi-style), so it must be unguessable.
var slugEncoding = base32.NewEncoding("abcdefghijkmnpqrstuvwxyz23456789").WithPadding(base32.NoPadding)

const slugBytes = 10 // 10 bytes → 16 base32 chars

// Config carries the SFU and TURN parameters the manager needs to build each
// live room, plus the link TTL and sweep cadence.
type Config struct {
	ICEServers  []webrtc.ICEServer
	NAT1To1IPs  []string
	UDPPortMin  uint16
	UDPPortMax  uint16
	AppHostname string
	FileStore   *filestore.Store

	RoomTTL       time.Duration
	SweepInterval time.Duration
}

// Manager owns the room table and the set of currently-live SFU rooms.
type Manager struct {
	db  *sql.DB
	cfg Config

	mu    sync.Mutex
	live  map[string]*liveRoom
	clock func() time.Time
}

// liveRoom couples an in-memory SFU room with a participant counter so the
// manager can detect the moment the room empties and end it.
type liveRoom struct {
	room  *sfu.Room
	peers map[string]struct{}
}

func NewManager(database *sql.DB, cfg Config) *Manager {
	if cfg.SweepInterval <= 0 {
		cfg.SweepInterval = time.Minute
	}
	if cfg.RoomTTL <= 0 {
		cfg.RoomTTL = 24 * time.Hour
	}
	return &Manager{
		db:    database,
		cfg:   cfg,
		live:  make(map[string]*liveRoom),
		clock: time.Now,
	}
}

// RoomInfo is the API view of a freshly minted room.
type RoomInfo struct {
	Slug      string `json:"slug"`
	URL       string `json:"url"`
	ExpiresAt string `json:"expiresAt"`
}

// Create mints a new pending room owned by createdBy and returns its shareable
// link. The slug is unguessable and the link is joinable until expiry or until
// the call ends.
func (m *Manager) Create(ctx context.Context, createdBy string) (RoomInfo, error) {
	slug, err := newSlug()
	if err != nil {
		return RoomInfo{}, err
	}
	expiresAt := m.clock().UTC().Add(m.cfg.RoomTTL).Format(timeFormat)
	if _, err := m.db.ExecContext(ctx, `
		insert into rooms (slug, created_by, status, expires_at)
		values (?, ?, 'pending', ?)
	`, slug, createdBy, expiresAt); err != nil {
		return RoomInfo{}, fmt.Errorf("insert room: %w", err)
	}
	return RoomInfo{Slug: slug, URL: "/r/" + slug, ExpiresAt: expiresAt}, nil
}

// RoomSummary is the API view of a room in its creator's list.
type RoomSummary struct {
	Slug      string `json:"slug"`
	URL       string `json:"url"`
	Status    string `json:"status"`
	CreatedAt string `json:"createdAt"`
	ExpiresAt string `json:"expiresAt"`
}

// ListByCreator returns the caller's still-usable rooms (pending or active),
// newest first. Ended rooms are omitted — their links are dead.
func (m *Manager) ListByCreator(ctx context.Context, createdBy string) ([]RoomSummary, error) {
	rows, err := m.db.QueryContext(ctx, `
		select slug, status, created_at, expires_at
		from rooms
		where created_by = ? and status != 'ended'
		order by created_at desc
		limit 100
	`, createdBy)
	if err != nil {
		return nil, fmt.Errorf("list rooms: %w", err)
	}
	defer rows.Close()

	result := []RoomSummary{}
	for rows.Next() {
		var r RoomSummary
		if err := rows.Scan(&r.Slug, &r.Status, &r.CreatedAt, &r.ExpiresAt); err != nil {
			return nil, fmt.Errorf("scan room: %w", err)
		}
		r.URL = "/r/" + r.Slug
		result = append(result, r)
	}
	return result, rows.Err()
}

// Joinable reports whether a slug can currently be joined: it must exist, not be
// ended, and (if still pending) not be past its TTL. Returns ErrRoomNotFound for
// missing slugs so callers can 404.
func (m *Manager) Joinable(ctx context.Context, slug string) (bool, error) {
	var status, expiresAt string
	err := m.db.QueryRowContext(ctx,
		`select status, expires_at from rooms where slug = ?`, slug,
	).Scan(&status, &expiresAt)
	if errors.Is(err, sql.ErrNoRows) {
		return false, ErrRoomNotFound
	}
	if err != nil {
		return false, fmt.Errorf("select room: %w", err)
	}
	return m.statusJoinable(status, expiresAt), nil
}

func (m *Manager) statusJoinable(status, expiresAt string) bool {
	switch status {
	case "active":
		return true
	case "pending":
		exp, err := time.Parse(timeFormat, expiresAt)
		if err != nil {
			return false
		}
		return m.clock().UTC().Before(exp)
	default: // ended
		return false
	}
}

// ErrRoomNotFound is returned by Joinable when no row matches the slug.
var ErrRoomNotFound = errors.New("room not found")

// ServeWS validates joinability, lazily creates the live SFU room, and serves
// the peer's WebSocket session. On first join the room is promoted to active; on
// the last leave it is ended and torn down.
func (m *Manager) ServeWS(w http.ResponseWriter, r *http.Request, slug string) {
	joinable, err := m.Joinable(r.Context(), slug)
	if err != nil || !joinable {
		http.Error(w, "room not available", http.StatusForbidden)
		return
	}

	lr, err := m.acquire(slug)
	if err != nil {
		log.Printf("rooms: acquire %q: %v", slug, err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	lr.room.ServeWS(w, r)
}

// acquire returns the live room for slug, building it on first use and marking
// the DB row active. Idempotent under concurrent first joins.
func (m *Manager) acquire(slug string) (*liveRoom, error) {
	m.mu.Lock()
	if lr, ok := m.live[slug]; ok {
		m.mu.Unlock()
		return lr, nil
	}
	m.mu.Unlock()

	room, err := sfu.NewRoom(sfu.Config{
		ICEServers:   m.cfg.ICEServers,
		NAT1To1IPs:   m.cfg.NAT1To1IPs,
		UDPPortMin:   m.cfg.UDPPortMin,
		UDPPortMax:   m.cfg.UDPPortMax,
		AppHostname:  m.cfg.AppHostname,
		RoomID:       slug,
		FileStore:    m.cfg.FileStore,
		OnPeerJoined: func(p protocol.PeerInfo) { m.peerJoined(slug, p.ID) },
		OnPeerLeft:   func(id string) { m.peerLeft(slug, id) },
	})
	if err != nil {
		return nil, fmt.Errorf("sfu init %q: %w", slug, err)
	}

	m.mu.Lock()
	// Re-check after the unlocked build: a concurrent acquire may have won.
	if lr, ok := m.live[slug]; ok {
		m.mu.Unlock()
		room.Close()
		return lr, nil
	}
	lr := &liveRoom{room: room, peers: make(map[string]struct{})}
	m.live[slug] = lr
	m.mu.Unlock()

	m.markActive(slug)
	return lr, nil
}

func (m *Manager) peerJoined(slug, id string) {
	m.mu.Lock()
	if lr, ok := m.live[slug]; ok {
		lr.peers[id] = struct{}{}
	}
	m.mu.Unlock()
}

// peerLeft removes a peer and, if the room is now empty, ends it: closes the SFU
// room, drops it from the live set, and marks the DB row ended so the link stops
// working.
func (m *Manager) peerLeft(slug, id string) {
	m.mu.Lock()
	lr, ok := m.live[slug]
	if !ok {
		m.mu.Unlock()
		return
	}
	delete(lr.peers, id)
	if len(lr.peers) > 0 {
		m.mu.Unlock()
		return
	}
	delete(m.live, slug)
	m.mu.Unlock()

	lr.room.Close()
	m.markEnded(slug)
	log.Printf("rooms: %q emptied, ended", slug)
}

func (m *Manager) markActive(slug string) {
	now := m.clock().UTC().Format(timeFormat)
	if _, err := m.db.ExecContext(context.Background(), `
		update rooms
		set status = 'active',
		    first_joined_at = coalesce(first_joined_at, ?),
		    updated_at = ?
		where slug = ? and status = 'pending'
	`, now, now, slug); err != nil {
		log.Printf("rooms: mark active %q: %v", slug, err)
	}
}

func (m *Manager) markEnded(slug string) {
	now := m.clock().UTC().Format(timeFormat)
	if _, err := m.db.ExecContext(context.Background(), `
		update rooms
		set status = 'ended', ended_at = ?, updated_at = ?
		where slug = ? and status != 'ended'
	`, now, now, slug); err != nil {
		log.Printf("rooms: mark ended %q: %v", slug, err)
	}
}

// Run starts the background sweeper until ctx is cancelled. The sweeper ends
// unused links past their TTL.
func (m *Manager) Run(ctx context.Context) {
	t := time.NewTicker(m.cfg.SweepInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			m.sweep(ctx)
		}
	}
}

// sweep ends every pending room whose TTL has lapsed. Active rooms are not swept
// by TTL — they end when they empty (handled by peerLeft).
func (m *Manager) sweep(ctx context.Context) {
	now := m.clock().UTC().Format(timeFormat)
	if _, err := m.db.ExecContext(ctx, `
		update rooms
		set status = 'ended', ended_at = ?, updated_at = ?
		where status = 'pending' and expires_at <= ?
	`, now, now, now); err != nil {
		log.Printf("rooms: sweep: %v", err)
	}
}

// Close tears down every live SFU room. Called on shutdown.
func (m *Manager) Close() {
	m.mu.Lock()
	rooms := make([]*liveRoom, 0, len(m.live))
	for _, lr := range m.live {
		rooms = append(rooms, lr)
	}
	m.live = make(map[string]*liveRoom)
	m.mu.Unlock()
	for _, lr := range rooms {
		lr.room.Close()
	}
}

func newSlug() (string, error) {
	b := make([]byte, slugBytes)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("generate slug: %w", err)
	}
	return strings.ToLower(slugEncoding.EncodeToString(b)), nil
}
