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

	info, err := m.Create(ctx, creator)
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

	info, err := m.Create(ctx, creator)
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
	first, _ := m.Create(ctx, creator)
	second, _ := m.Create(ctx, creator)
	third, _ := m.Create(ctx, creator)
	setCreatedAt(t, database, first.Slug, "2026-06-29T12:00:00.000000000Z")
	setCreatedAt(t, database, second.Slug, "2026-06-29T12:00:01.000000000Z")
	setCreatedAt(t, database, third.Slug, "2026-06-29T12:00:02.000000000Z")

	// One ended room (must be excluded) and one for another creator (excluded).
	setStatus(t, database, first.Slug, "ended")
	setStatus(t, database, second.Slug, "active")

	insertUser(t, database, "other")
	if _, err := m.Create(ctx, "other"); err != nil {
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

	stale, _ := m.Create(ctx, creator)
	fresh, _ := m.Create(ctx, creator)
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

// stubRoom stands in for *sfu.Room so grace/teardown can be tested without a
// real SFU. fakeTimer captures the grace callback so the test fires it on demand
// instead of waiting wall-clock minutes.
type stubRoom struct{ closed int }

func (s *stubRoom) ServeWS(http.ResponseWriter, *http.Request) {}
func (s *stubRoom) Close()                                     { s.closed++ }

type fakeTimer struct {
	fn      func()
	stopped bool
}

func (f *fakeTimer) Stop() bool {
	was := !f.stopped
	f.stopped = true
	return was
}

// emptyLiveRoom seeds m.live with a stub room holding one peer for an existing
// DB row, and captures every grace timer the manager schedules.
func emptyLiveRoom(t *testing.T, m *Manager) (slug string, room *stubRoom, timers *[]*fakeTimer) {
	t.Helper()
	info, err := m.Create(context.Background(), creator)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	setStatus(t, m.db, info.Slug, "active")
	room = &stubRoom{}
	captured := []*fakeTimer{}
	timers = &captured
	m.afterFunc = func(_ time.Duration, fn func()) stoppable {
		ft := &fakeTimer{fn: fn}
		captured = append(captured, ft)
		*timers = captured
		return ft
	}
	m.live[info.Slug] = &liveRoom{room: room, peers: map[string]struct{}{"p1": {}}}
	return info.Slug, room, timers
}

func TestGracePeriodEndsEmptyRoom(t *testing.T) {
	m, database, _ := newTestManager(t)
	slug, room, timers := emptyLiveRoom(t, m)

	m.peerLeft(slug, "p1")

	// Room is kept alive during grace: not closed, still active, still live.
	if room.closed != 0 {
		t.Fatalf("room closed during grace window (closed=%d)", room.closed)
	}
	if got := statusOf(t, database, slug); got != "active" {
		t.Fatalf("status during grace = %q, want active", got)
	}
	if _, ok := m.live[slug]; !ok {
		t.Fatal("room dropped from live set during grace")
	}
	if len(*timers) != 1 {
		t.Fatalf("expected 1 grace timer scheduled, got %d", len(*timers))
	}

	// Grace lapses with the room still empty → tear down and end the link.
	(*timers)[0].fn()
	if room.closed != 1 {
		t.Fatalf("room not closed after grace (closed=%d)", room.closed)
	}
	if got := statusOf(t, database, slug); got != "ended" {
		t.Fatalf("status after grace = %q, want ended", got)
	}
	if _, ok := m.live[slug]; ok {
		t.Fatal("ended room still in live set")
	}
}

func TestReconnectCancelsGrace(t *testing.T) {
	m, database, _ := newTestManager(t)
	slug, room, timers := emptyLiveRoom(t, m)

	m.peerLeft(slug, "p1")
	grace := (*timers)[0]

	// A reconnect arrives before grace lapses.
	m.peerJoined(slug, "p2")
	if !grace.stopped {
		t.Fatal("grace timer not stopped on reconnect")
	}

	// A late-firing stale timer must not tear down the now-occupied room.
	grace.fn()
	if room.closed != 0 {
		t.Fatalf("room closed despite reconnect (closed=%d)", room.closed)
	}
	if got := statusOf(t, database, slug); got != "active" {
		t.Fatalf("status after reconnect = %q, want active", got)
	}
	if _, ok := m.live[slug]; !ok {
		t.Fatal("room dropped from live set after reconnect")
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
