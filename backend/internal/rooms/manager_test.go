package rooms

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"testing"
	"time"

	"sozvon-hub/backend/internal/testutil"
)

const creator = "creator-user-id"

// newTestManager builds a manager over a real DB with the creator user already
// present (rooms.created_by has a FK to users), and a fixed clock the test owns.
func newTestManager(t *testing.T) (*Manager, *sql.DB, *time.Time) {
	t.Helper()
	database := testutil.NewDB(t)
	insertUser(t, database, creator)
	m := NewManager(database, Config{RoomTTL: time.Hour})
	now := time.Date(2026, 6, 29, 12, 0, 0, 0, time.UTC)
	clock := &now
	m.clock = func() time.Time { return *clock }
	return m, database, clock
}

func insertUser(t *testing.T, database *sql.DB, id string) {
	t.Helper()
	if _, err := database.ExecContext(context.Background(),
		`insert into users (id, username, name, password_hash) values (?, ?, ?, ?)`,
		id, id, id, "x"); err != nil {
		t.Fatalf("insert user %q: %v", id, err)
	}
}

func TestCreate(t *testing.T) {
	m, database, clock := newTestManager(t)
	ctx := context.Background()

	info, err := m.Create(ctx, creator, "")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if info.Slug == "" {
		t.Fatal("expected non-empty slug")
	}
	if info.URL != "/r/"+info.Slug {
		t.Fatalf("unexpected url %q", info.URL)
	}
	wantExpiry := clock.Add(time.Hour).Format(timeFormat)
	if info.ExpiresAt != wantExpiry {
		t.Fatalf("expiresAt %q, want %q", info.ExpiresAt, wantExpiry)
	}

	var status string
	if err := database.QueryRowContext(ctx,
		`select status from rooms where slug = ?`, info.Slug).Scan(&status); err != nil {
		t.Fatalf("read row: %v", err)
	}
	if status != "pending" {
		t.Fatalf("expected pending row, got %q", status)
	}
}

func TestJoinable(t *testing.T) {
	m, database, clock := newTestManager(t)
	ctx := context.Background()

	info, err := m.Create(ctx, creator, "")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	// pending & not expired → true
	joinable, err := m.Joinable(ctx, info.Slug)
	if err != nil || !joinable {
		t.Fatalf("pending not expired: joinable=%v err=%v", joinable, err)
	}

	// pending & past expiry → false
	*clock = clock.Add(2 * time.Hour)
	joinable, err = m.Joinable(ctx, info.Slug)
	if err != nil {
		t.Fatalf("Joinable: %v", err)
	}
	if joinable {
		t.Fatal("expected pending past-expiry room to be unjoinable")
	}

	// active → true (even past expiry: active rooms ignore TTL)
	setStatus(t, database, info.Slug, "active")
	joinable, err = m.Joinable(ctx, info.Slug)
	if err != nil || !joinable {
		t.Fatalf("active room should be joinable: joinable=%v err=%v", joinable, err)
	}

	// ended → false
	setStatus(t, database, info.Slug, "ended")
	joinable, err = m.Joinable(ctx, info.Slug)
	if err != nil {
		t.Fatalf("Joinable ended: %v", err)
	}
	if joinable {
		t.Fatal("expected ended room to be unjoinable")
	}

	// unknown slug → ErrRoomNotFound
	if _, err := m.Joinable(ctx, "does-not-exist"); !errors.Is(err, ErrRoomNotFound) {
		t.Fatalf("expected ErrRoomNotFound, got %v", err)
	}
}

func TestListByCreator(t *testing.T) {
	m, database, _ := newTestManager(t)
	ctx := context.Background()

	// Three rooms for the creator with explicit, distinct created_at so the
	// newest-first ordering is deterministic (created_at is filled by a DB
	// wall-clock default, not the test clock).
	first, _ := m.Create(ctx, creator, "")
	second, _ := m.Create(ctx, creator, "")
	third, _ := m.Create(ctx, creator, "")
	setCreatedAt(t, database, first.Slug, "2026-06-29T12:00:00.000000000Z")
	setCreatedAt(t, database, second.Slug, "2026-06-29T12:00:01.000000000Z")
	setCreatedAt(t, database, third.Slug, "2026-06-29T12:00:02.000000000Z")

	// One ended room (must be excluded) and one for another creator (excluded).
	setStatus(t, database, first.Slug, "ended")
	setStatus(t, database, second.Slug, "active")

	insertUser(t, database, "other")
	if _, err := m.Create(ctx, "other", ""); err != nil {
		t.Fatalf("create other room: %v", err)
	}

	list, err := m.ListByCreator(ctx, creator)
	if err != nil {
		t.Fatalf("ListByCreator: %v", err)
	}
	if len(list) != 2 {
		t.Fatalf("expected 2 rooms (pending+active), got %d: %+v", len(list), list)
	}
	// Newest first: third (pending) then second (active).
	if list[0].Slug != third.Slug || list[1].Slug != second.Slug {
		t.Fatalf("unexpected order: %q, %q", list[0].Slug, list[1].Slug)
	}
	for _, r := range list {
		if r.URL != "/r/"+r.Slug {
			t.Fatalf("url not set on %q: %q", r.Slug, r.URL)
		}
		if r.Status == "ended" {
			t.Fatal("ended room leaked into list")
		}
	}
}

func TestSweep(t *testing.T) {
	m, database, clock := newTestManager(t)
	ctx := context.Background()

	stale, _ := m.Create(ctx, creator, "")
	fresh, _ := m.Create(ctx, creator, "")
	setStatus(t, database, fresh.Slug, "active")

	// Move time past the pending room's TTL and sweep.
	*clock = clock.Add(2 * time.Hour)
	m.sweep(ctx)

	if got := statusOf(t, database, stale.Slug); got != "ended" {
		t.Fatalf("expected stale pending room ended, got %q", got)
	}
	if got := statusOf(t, database, fresh.Slug); got != "active" {
		t.Fatalf("expected active room untouched, got %q", got)
	}
}

func TestSweepPrunesOldEndedRooms(t *testing.T) {
	m, database, clock := newTestManager(t)
	ctx := context.Background()

	old, _ := m.Create(ctx, creator, "")
	setStatus(t, database, old.Slug, "ended")
	setEndedAt(t, database, old.Slug, clock.Add(-8*24*time.Hour).Format(timeFormat))

	recent, _ := m.Create(ctx, creator, "")
	setStatus(t, database, recent.Slug, "ended")
	setEndedAt(t, database, recent.Slug, clock.Add(-time.Hour).Format(timeFormat))

	m.sweep(ctx)

	if roomExists(t, database, old.Slug) {
		t.Fatal("ended room past retention not pruned")
	}
	if !roomExists(t, database, recent.Slug) {
		t.Fatal("recently ended room wrongly pruned")
	}
}

func TestReconcileActiveOnStartup(t *testing.T) {
	m, database, clock := newTestManager(t)
	ctx := context.Background()

	pending, _ := m.Create(ctx, creator, "")
	occupied, _ := m.Create(ctx, creator, "") // active, was occupied at the crash
	setStatus(t, database, occupied.Slug, "active")

	if err := m.ReconcileActiveOnStartup(ctx); err != nil {
		t.Fatalf("ReconcileActiveOnStartup: %v", err)
	}

	// The active room's empty countdown is started; the pending room is untouched.
	if emptySinceOf(t, database, occupied.Slug) == "" {
		t.Fatal("empty countdown not started for active room")
	}
	if emptySinceOf(t, database, pending.Slug) != "" {
		t.Fatal("pending room got an empty countdown")
	}

	// Nobody reconnects: once the grace period lapses, the sweeper ends it.
	*clock = clock.Add(2 * m.cfg.GracePeriod)
	m.sweep(ctx)
	if got := statusOf(t, database, occupied.Slug); got != "ended" {
		t.Fatalf("unreclaimed active room status = %q, want ended", got)
	}
	if got := statusOf(t, database, pending.Slug); got != "pending" {
		t.Fatalf("pending room status = %q, want pending", got)
	}
}

// stubRoom stands in for *sfu.Room so the teardown path can be tested without a
// real SFU.
type stubRoom struct{ closed int }

func (s *stubRoom) ServeWS(http.ResponseWriter, *http.Request) {}
func (s *stubRoom) Close()                                     { s.closed++ }

// seedLiveRoom creates an active DB row plus an in-memory live room holding the
// given peers — what acquire + peerJoined produce, without a real SFU.
func seedLiveRoom(t *testing.T, m *Manager, peers ...string) (string, *stubRoom) {
	t.Helper()
	info, err := m.Create(context.Background(), creator, "")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	setStatus(t, m.db, info.Slug, "active")
	room := &stubRoom{}
	p := map[string]struct{}{}
	for _, id := range peers {
		p[id] = struct{}{}
	}
	m.mu.Lock()
	m.live[info.Slug] = &liveRoom{room: room, peers: p}
	m.mu.Unlock()
	return info.Slug, room
}

func isLive(m *Manager, slug string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	_, ok := m.live[slug]
	return ok
}

func TestEmptyRoomEndedAfterGrace(t *testing.T) {
	m, database, clock := newTestManager(t)
	ctx := context.Background()
	slug, room := seedLiveRoom(t, m, "p1")

	m.peerLeft(slug, "p1")

	// Room is kept alive during the grace window: empty_since stamped, still
	// active, still live, not closed.
	if room.closed != 0 {
		t.Fatalf("room closed during grace window (closed=%d)", room.closed)
	}
	if got := statusOf(t, database, slug); got != "active" {
		t.Fatalf("status during grace = %q, want active", got)
	}
	if emptySinceOf(t, database, slug) == "" {
		t.Fatal("empty_since not stamped when room emptied")
	}
	if !isLive(m, slug) {
		t.Fatal("room dropped from live set during grace")
	}

	// A sweep before the grace lapses leaves it alone.
	*clock = clock.Add(m.cfg.GracePeriod - time.Minute)
	m.sweep(ctx)
	if got := statusOf(t, database, slug); got != "active" {
		t.Fatalf("room ended before grace lapsed: %q", got)
	}

	// Once grace lapses with the room still empty → tear down and end the link.
	*clock = clock.Add(2 * time.Minute)
	m.sweep(ctx)
	if got := statusOf(t, database, slug); got != "ended" {
		t.Fatalf("status after grace = %q, want ended", got)
	}
	if room.closed != 1 {
		t.Fatalf("room not closed after grace (closed=%d)", room.closed)
	}
	if isLive(m, slug) {
		t.Fatal("ended room still in live set")
	}
}

func TestReconnectClearsEmptyCountdown(t *testing.T) {
	m, database, clock := newTestManager(t)
	ctx := context.Background()
	slug, room := seedLiveRoom(t, m, "p1")

	m.peerLeft(slug, "p1")
	if emptySinceOf(t, database, slug) == "" {
		t.Fatal("empty_since not stamped when room emptied")
	}

	// A reconnect arrives before grace lapses: acquire clears the countdown.
	if _, err := m.acquire(slug); err != nil {
		t.Fatalf("acquire: %v", err)
	}
	if es := emptySinceOf(t, database, slug); es != "" {
		t.Fatalf("empty_since not cleared on reconnect: %q", es)
	}

	// Even well past the grace period, the sweeper leaves the reclaimed room.
	*clock = clock.Add(2 * m.cfg.GracePeriod)
	m.sweep(ctx)
	if got := statusOf(t, database, slug); got != "active" {
		t.Fatalf("reclaimed room ended: %q", got)
	}
	if room.closed != 0 {
		t.Fatalf("reclaimed room closed (closed=%d)", room.closed)
	}
	if !isLive(m, slug) {
		t.Fatal("reclaimed room dropped from live set")
	}
}

func setStatus(t *testing.T, database *sql.DB, slug, status string) {
	t.Helper()
	if _, err := database.ExecContext(context.Background(),
		`update rooms set status = ? where slug = ?`, status, slug); err != nil {
		t.Fatalf("set status %q: %v", status, err)
	}
}

func setCreatedAt(t *testing.T, database *sql.DB, slug, ts string) {
	t.Helper()
	if _, err := database.ExecContext(context.Background(),
		`update rooms set created_at = ? where slug = ?`, ts, slug); err != nil {
		t.Fatalf("set created_at: %v", err)
	}
}

func statusOf(t *testing.T, database *sql.DB, slug string) string {
	t.Helper()
	var status string
	if err := database.QueryRowContext(context.Background(),
		`select status from rooms where slug = ?`, slug).Scan(&status); err != nil {
		t.Fatalf("status of %q: %v", slug, err)
	}
	return status
}

func emptySinceOf(t *testing.T, database *sql.DB, slug string) string {
	t.Helper()
	var es sql.NullString
	if err := database.QueryRowContext(context.Background(),
		`select empty_since from rooms where slug = ?`, slug).Scan(&es); err != nil {
		t.Fatalf("empty_since of %q: %v", slug, err)
	}
	return es.String
}

func setEndedAt(t *testing.T, database *sql.DB, slug, ts string) {
	t.Helper()
	if _, err := database.ExecContext(context.Background(),
		`update rooms set ended_at = ? where slug = ?`, ts, slug); err != nil {
		t.Fatalf("set ended_at: %v", err)
	}
}

func roomExists(t *testing.T, database *sql.DB, slug string) bool {
	t.Helper()
	var n int
	if err := database.QueryRowContext(context.Background(),
		`select count(*) from rooms where slug = ?`, slug).Scan(&n); err != nil {
		t.Fatalf("exists %q: %v", slug, err)
	}
	return n > 0
}
