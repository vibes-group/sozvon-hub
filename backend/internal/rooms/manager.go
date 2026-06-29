// Package rooms manages dynamic ephemeral video rooms. Each room is a row in the
// SQLite rooms table plus, while in use, a live SFU room created lazily on first
// join. When the last participant leaves, the room is kept alive for a short
// grace period so a reload or brief drop reconnects to the same call; only if it
// is still empty when the grace lapses is it torn down and the link ended.
//
// Liveness is tracked durably via the rooms.empty_since column rather than an
// in-memory timer: the last leaver stamps it, a (re)join clears it, and the
// background sweeper ends rooms empty past the grace period — and pending links
// past their TTL. Because the column survives a restart, rooms left 'active' by
// a crash are reconciled and reaped instead of lingering forever.
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

	RoomTTL     time.Duration
	GracePeriod time.Duration
}

// liveSFU is the slice of *sfu.Room the manager drives. Narrowing it to an
// interface lets the teardown logic be tested without a real SFU.
type liveSFU interface {
	ServeWS(w http.ResponseWriter, r *http.Request)
	Close()
}

// Manager owns the room table and the set of currently-live SFU rooms.
type Manager struct {
	db  *sql.DB
	cfg Config

	mu    sync.Mutex
	live  map[string]*liveRoom
	clock func() time.Time
}

// liveRoom couples an in-memory SFU room with its set of connected peers so the
// manager can detect when the room empties. The empty/teardown countdown itself
// lives in the rooms.empty_since column, not here, so it survives a restart.
type liveRoom struct {
	room  liveSFU
	peers map[string]struct{}
}

func NewManager(database *sql.DB, cfg Config) *Manager {
	if cfg.RoomTTL <= 0 {
		cfg.RoomTTL = 24 * time.Hour
	}
	if cfg.GracePeriod <= 0 {
		cfg.GracePeriod = 5 * time.Minute
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
	Name      string `json:"name"`
	ExpiresAt string `json:"expiresAt"`
}

// Create mints a new pending room owned by createdBy and returns its shareable
// link. The slug is unguessable and the link is joinable until expiry or until
// the call ends. A blank name gets a generated friendly one.
func (m *Manager) Create(ctx context.Context, createdBy, name string) (RoomInfo, error) {
	slug, err := newSlug()
	if err != nil {
		return RoomInfo{}, err
	}
	if name == "" {
		name = generateName()
	}
	expiresAt := m.clock().UTC().Add(m.cfg.RoomTTL).Format(timeFormat)
	if _, err := m.db.ExecContext(ctx, `
		insert into rooms (slug, created_by, name, status, expires_at)
		values (?, ?, ?, 'pending', ?)
	`, slug, createdBy, name, expiresAt); err != nil {
		return RoomInfo{}, fmt.Errorf("insert room: %w", err)
	}
	return RoomInfo{Slug: slug, URL: "/r/" + slug, Name: name, ExpiresAt: expiresAt}, nil
}

// Rename changes a room's display name. Only the creator may rename, so the
// update is scoped by created_by; an empty result means the room is missing or
// not owned by the caller, reported as ErrRoomNotFound.
func (m *Manager) Rename(ctx context.Context, createdBy, slug, name string) error {
	now := m.clock().UTC().Format(timeFormat)
	res, err := m.db.ExecContext(ctx, `
		update rooms set name = ?, updated_at = ?
		where slug = ? and created_by = ? and status != 'ended'
	`, name, now, slug, createdBy)
	if err != nil {
		return fmt.Errorf("rename room: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return fmt.Errorf("rename room rows: %w", err)
	}
	if n == 0 {
		return ErrRoomNotFound
	}
	return nil
}

// RoomSummary is the API view of a room in a user's list (created or joined).
// Participants is the live in-memory count of who is in the call right now;
// ClosesAt, derived from empty_since, is when an emptied room's grace lapses and
// it is torn down (absent while the room is occupied).
type RoomSummary struct {
	Slug         string `json:"slug"`
	URL          string `json:"url"`
	Name         string `json:"name"`
	Status       string `json:"status"`
	Participants int    `json:"participants"`
	CreatedAt    string `json:"createdAt"`
	ExpiresAt    string `json:"expiresAt"`
	ClosesAt     string `json:"closesAt,omitempty"`
}

// liveParticipants reports how many peers are connected to a slug's live room
// right now. A slug with no live room (pending, ended, or not yet rebuilt after
// a restart) reports zero.
func (m *Manager) liveParticipants(slug string) int {
	m.mu.Lock()
	defer m.mu.Unlock()
	if lr, ok := m.live[slug]; ok {
		return len(lr.peers)
	}
	return 0
}

// closesAt turns a room's empty_since into the time its grace period lapses
// (empty_since + grace). It returns "" when the room is occupied (empty_since
// null) or the stored value is unparseable.
func (m *Manager) closesAt(emptySince sql.NullString) string {
	if !emptySince.Valid || emptySince.String == "" {
		return ""
	}
	t, err := time.Parse(timeFormat, emptySince.String)
	if err != nil {
		return ""
	}
	return t.Add(m.cfg.GracePeriod).UTC().Format(timeFormat)
}

// ListByCreator returns the caller's still-usable rooms (pending or active),
// newest first. Ended rooms are omitted — their links are dead.
func (m *Manager) ListByCreator(ctx context.Context, createdBy string) ([]RoomSummary, error) {
	now := m.clock().UTC().Format(timeFormat)
	rows, err := m.db.QueryContext(ctx, `
		select slug, name, status, created_at, expires_at, empty_since
		from rooms
		where created_by = ? and status != 'ended'
		  and (status = 'active' or expires_at > ?)
		order by created_at desc
		limit 100
	`, createdBy, now)
	if err != nil {
		return nil, fmt.Errorf("list rooms: %w", err)
	}
	defer rows.Close()

	result := []RoomSummary{}
	for rows.Next() {
		var r RoomSummary
		var emptySince sql.NullString
		if err := rows.Scan(&r.Slug, &r.Name, &r.Status, &r.CreatedAt, &r.ExpiresAt, &emptySince); err != nil {
			return nil, fmt.Errorf("scan room: %w", err)
		}
		r.URL = "/r/" + r.Slug
		r.Participants = m.liveParticipants(r.Slug)
		r.ClosesAt = m.closesAt(emptySince)
		result = append(result, r)
	}
	return result, rows.Err()
}

// ListJoined returns still-usable rooms the user has joined but did not create,
// most recently joined first. Mirrors ListByCreator's "no ended rooms" rule.
func (m *Manager) ListJoined(ctx context.Context, userID string) ([]RoomSummary, error) {
	now := m.clock().UTC().Format(timeFormat)
	rows, err := m.db.QueryContext(ctx, `
		select r.slug, r.name, r.status, r.created_at, r.expires_at, r.empty_since
		from room_participants p
		join rooms r on r.slug = p.slug
		where p.user_id = ? and r.created_by != ? and r.status != 'ended'
		  and (r.status = 'active' or r.expires_at > ?)
		order by p.last_joined_at desc
		limit 100
	`, userID, userID, now)
	if err != nil {
		return nil, fmt.Errorf("list joined rooms: %w", err)
	}
	defer rows.Close()

	result := []RoomSummary{}
	for rows.Next() {
		var r RoomSummary
		var emptySince sql.NullString
		if err := rows.Scan(&r.Slug, &r.Name, &r.Status, &r.CreatedAt, &r.ExpiresAt, &emptySince); err != nil {
			return nil, fmt.Errorf("scan joined room: %w", err)
		}
		r.URL = "/r/" + r.Slug
		r.Participants = m.liveParticipants(r.Slug)
		r.ClosesAt = m.closesAt(emptySince)
		result = append(result, r)
	}
	return result, rows.Err()
}

// recordJoin upserts a participation row so the room shows up in the user's
// "joined" list. Best-effort: a failure here must not block joining the call.
func (m *Manager) recordJoin(ctx context.Context, slug, userID string) {
	now := m.clock().UTC().Format(timeFormat)
	if _, err := m.db.ExecContext(ctx, `
		insert into room_participants (slug, user_id, first_joined_at, last_joined_at)
		values (?, ?, ?, ?)
		on conflict(slug, user_id) do update set last_joined_at = excluded.last_joined_at
	`, slug, userID, now, now); err != nil {
		log.Printf("rooms: record join %q/%q: %v", slug, userID, err)
	}
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

// RoomView is the public view of a single room by slug: its display name and
// whether it can currently be joined.
type RoomView struct {
	Slug     string `json:"slug"`
	Name     string `json:"name"`
	Joinable bool   `json:"joinable"`
}

// Get returns a room's name and joinability by slug, for the join screen.
// Returns ErrRoomNotFound for missing slugs so callers can 404.
func (m *Manager) Get(ctx context.Context, slug string) (RoomView, error) {
	var name, status, expiresAt string
	err := m.db.QueryRowContext(ctx,
		`select name, status, expires_at from rooms where slug = ?`, slug,
	).Scan(&name, &status, &expiresAt)
	if errors.Is(err, sql.ErrNoRows) {
		return RoomView{}, ErrRoomNotFound
	}
	if err != nil {
		return RoomView{}, fmt.Errorf("select room: %w", err)
	}
	return RoomView{Slug: slug, Name: name, Joinable: m.statusJoinable(status, expiresAt)}, nil
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
func (m *Manager) ServeWS(w http.ResponseWriter, r *http.Request, slug, userID string) {
	joinable, err := m.Joinable(r.Context(), slug)
	if err != nil || !joinable {
		http.Error(w, "room not available", http.StatusForbidden)
		return
	}

	// Logged-in joiners are recorded so the room shows in their "joined" list;
	// guests (empty userID) keep their history client-side instead.
	if userID != "" {
		m.recordJoin(r.Context(), slug, userID)
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
// the DB row active. It also clears empty_since so a (re)join cancels any pending
// empty teardown. Idempotent under concurrent first joins.
func (m *Manager) acquire(slug string) (*liveRoom, error) {
	m.mu.Lock()
	if lr, ok := m.live[slug]; ok {
		m.mu.Unlock()
		m.markOccupied(slug) // reconnect during the grace window: abort teardown
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
		m.markOccupied(slug)
		return lr, nil
	}
	lr := &liveRoom{room: room, peers: make(map[string]struct{})}
	m.live[slug] = lr
	m.mu.Unlock()

	m.markActive(slug)   // pending → active on first join
	m.markOccupied(slug) // also covers rebuilding a room left 'active' by a restart
	return lr, nil
}

func (m *Manager) peerJoined(slug, id string) {
	m.mu.Lock()
	if lr, ok := m.live[slug]; ok {
		lr.peers[id] = struct{}{}
	}
	m.mu.Unlock()
}

// peerLeft removes a peer and, when the room empties, stamps empty_since so the
// sweeper ends it once the grace period lapses — rather than ending it now. A
// reconnect within the window clears the stamp (acquire), so reloading the page
// rejoins the same call instead of killing the room. The live room is kept in
// memory through the window so the reconnect reuses it.
func (m *Manager) peerLeft(slug, id string) {
	m.mu.Lock()
	lr, ok := m.live[slug]
	if !ok {
		m.mu.Unlock()
		return
	}
	delete(lr.peers, id)
	empty := len(lr.peers) == 0
	m.mu.Unlock()
	if empty {
		m.markEmpty(slug)
	}
}

// markOccupied clears the empty countdown: the room has, or is about to have, a
// connected peer, so the sweeper must not end it. No-op once ended.
func (m *Manager) markOccupied(slug string) {
	if _, err := m.db.ExecContext(context.Background(), `
		update rooms set empty_since = null
		where slug = ? and status = 'active'
	`, slug); err != nil {
		log.Printf("rooms: mark occupied %q: %v", slug, err)
	}
}

// markEmpty starts the empty countdown: the last peer left, so the sweeper ends
// the room once empty_since is older than the grace period unless a peer rejoins
// first (clearing it via markOccupied). No-op once ended.
func (m *Manager) markEmpty(slug string) {
	now := m.clock().UTC().Format(timeFormat)
	if _, err := m.db.ExecContext(context.Background(), `
		update rooms set empty_since = ?
		where slug = ? and status = 'active'
	`, now, slug); err != nil {
		log.Printf("rooms: mark empty %q: %v", slug, err)
	}
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

// ReconcileActiveOnStartup restarts the empty countdown for rooms left 'active'
// by a previous process. Their live peers were lost on restart, so none is
// occupied now; stamping empty_since starts each one's grace window. A client
// that was mid-call reconnects within the window and clears the stamp (acquire),
// while the sweeper ends any still empty when the grace period lapses. Without
// this, a room occupied at the moment of the crash keeps empty_since null and
// would never be swept — lingering in users' lists and joinable forever. Rooms
// already counting down (empty_since set) keep their original deadline.
// Run once at startup, before serving joins.
func (m *Manager) ReconcileActiveOnStartup(ctx context.Context) error {
	now := m.clock().UTC().Format(timeFormat)
	res, err := m.db.ExecContext(ctx, `
		update rooms set empty_since = ?
		where status = 'active' and empty_since is null
	`, now)
	if err != nil {
		return fmt.Errorf("reconcile active rooms: %w", err)
	}
	if n, _ := res.RowsAffected(); n > 0 {
		log.Printf("rooms: started empty countdown for %d active room(s) from a previous run", n)
	}
	return nil
}

// Run starts the background sweeper until ctx is cancelled.
func (m *Manager) Run(ctx context.Context) {
	t := time.NewTicker(time.Minute)
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

// endedRetention is how long an ended room's row is kept before the sweeper
// deletes it. Ended links are dead — never joinable, never listed — so the row
// only serves short-term history/debugging; past this window it's pruned to
// bound table growth. room_participants rows go with it via ON DELETE CASCADE.
const endedRetention = 7 * 24 * time.Hour

// sweep ends pending rooms past their TTL, ends active rooms empty past the grace
// period, and prunes ended rooms past the retention window.
func (m *Manager) sweep(ctx context.Context) {
	now := m.clock().UTC()
	nowStr := now.Format(timeFormat)
	if _, err := m.db.ExecContext(ctx, `
		update rooms
		set status = 'ended', ended_at = ?, updated_at = ?
		where status = 'pending' and expires_at <= ?
	`, nowStr, nowStr, nowStr); err != nil {
		log.Printf("rooms: sweep: %v", err)
	}

	graceCutoff := now.Add(-m.cfg.GracePeriod).Format(timeFormat)
	m.endRoomsEmptyPast(ctx, graceCutoff, nowStr)

	retentionCutoff := now.Add(-endedRetention).Format(timeFormat)
	if _, err := m.db.ExecContext(ctx, `
		delete from rooms
		where status = 'ended' and ended_at is not null and ended_at <= ?
	`, retentionCutoff); err != nil {
		log.Printf("rooms: prune ended: %v", err)
	}
}

// endRoomsEmptyPast ends active rooms that have sat empty longer than the grace
// period, tearing down any live SFU room and deleting the room's files. Each end
// is a guarded UPDATE: if a reconnect cleared empty_since after the room was
// selected, the row no longer matches and the room is left alone.
func (m *Manager) endRoomsEmptyPast(ctx context.Context, cutoff, now string) {
	rows, err := m.db.QueryContext(ctx, `
		select slug from rooms
		where status = 'active' and empty_since is not null and empty_since <= ?
	`, cutoff)
	if err != nil {
		log.Printf("rooms: sweep empty: %v", err)
		return
	}
	var slugs []string
	for rows.Next() {
		var slug string
		if err := rows.Scan(&slug); err != nil {
			rows.Close()
			log.Printf("rooms: sweep empty scan: %v", err)
			return
		}
		slugs = append(slugs, slug)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		log.Printf("rooms: sweep empty rows: %v", err)
		return
	}

	for _, slug := range slugs {
		res, err := m.db.ExecContext(ctx, `
			update rooms set status = 'ended', ended_at = ?, updated_at = ?
			where slug = ? and status = 'active' and empty_since is not null and empty_since <= ?
		`, now, now, slug, cutoff)
		if err != nil {
			log.Printf("rooms: end empty %q: %v", slug, err)
			continue
		}
		if n, _ := res.RowsAffected(); n == 0 {
			continue // reconnected since selection — empty_since cleared
		}
		m.teardownLive(slug)
		if m.cfg.FileStore != nil {
			m.cfg.FileStore.DeleteRoom(slug)
		}
		log.Printf("rooms: %q empty past grace, ended", slug)
	}
}

// teardownLive removes a slug's live SFU room, if this process holds one, and
// closes it. Safe to call for a slug with no live room.
func (m *Manager) teardownLive(slug string) {
	m.mu.Lock()
	lr, ok := m.live[slug]
	if ok {
		delete(m.live, slug)
	}
	m.mu.Unlock()
	if ok {
		lr.room.Close()
	}
}

// Close tears down every live SFU room. Called on shutdown. Active rooms keep
// their status; the next startup's ReconcileActiveOnStartup restarts their empty
// countdown.
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
	return slugEncoding.EncodeToString(b), nil
}
