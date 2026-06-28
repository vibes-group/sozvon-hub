package api_test

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"strings"
	"testing"

	"sozvon-hub/backend/internal/api"
	"sozvon-hub/backend/internal/auth"
	"sozvon-hub/backend/internal/rooms"
	"sozvon-hub/backend/internal/testutil"
)

func fastParams() auth.PasswordParams {
	return auth.PasswordParams{MemoryKiB: 8, Iterations: 1, Parallelism: 1, SaltBytes: 16, KeyBytes: 32}
}

func newEnv(t *testing.T) (*httptest.Server, *auth.Service, execer) {
	t.Helper()
	database := testutil.NewDB(t)
	authSvc := auth.NewService(database, auth.Config{PasswordParams: fastParams()})
	roomMgr := rooms.NewManager(database, rooms.Config{})
	handler := api.Routes(api.Deps{
		Auth:             authSvc,
		Rooms:            roomMgr,
		StunURL:          "stun:stun.example.com:3478",
		TurnURL:          "turn:turn.example.com:3478",
		TurnSharedSecret: "shared-secret",
	}, http.NotFoundHandler())
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	return srv, authSvc, execer{database}
}

// execer performs the direct-SQL setup the HTTP surface intentionally has no
// route for: promoting a user to admin or granting invite permission.
type execer struct {
	db *sql.DB
}

func (e execer) makeAdmin(t *testing.T, userID string) {
	t.Helper()
	if _, err := e.db.ExecContext(context.Background(),
		`update users set is_admin = 1 where id = ?`, userID); err != nil {
		t.Fatalf("make admin: %v", err)
	}
}

func (e execer) grantCanInvite(t *testing.T, userID string) {
	t.Helper()
	if _, err := e.db.ExecContext(context.Background(),
		`update users set can_invite = 1 where id = ?`, userID); err != nil {
		t.Fatalf("grant can_invite: %v", err)
	}
}

// client returns an http.Client with a cookie jar so the session cookie set by
// register/login is carried on subsequent requests.
func client(t *testing.T) *http.Client {
	t.Helper()
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatalf("cookiejar: %v", err)
	}
	return &http.Client{Jar: jar}
}

func doJSON(t *testing.T, c *http.Client, method, url string, body any) *http.Response {
	t.Helper()
	var rdr io.Reader
	if body != nil {
		buf, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("marshal body: %v", err)
		}
		rdr = bytes.NewReader(buf)
	}
	req, err := http.NewRequest(method, url, rdr)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", method, url, err)
	}
	return resp
}

func decode(t *testing.T, resp *http.Response, dst any) {
	t.Helper()
	defer resp.Body.Close()
	if err := json.NewDecoder(resp.Body).Decode(dst); err != nil {
		t.Fatalf("decode body: %v", err)
	}
}

func mustStatus(t *testing.T, resp *http.Response, want int) {
	t.Helper()
	if resp.StatusCode != want {
		b, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		t.Fatalf("status = %d, want %d (body: %s)", resp.StatusCode, want, string(b))
	}
}

// bootstrapToken mints the first-user invite directly through the auth service
// (the HTTP surface has no anonymous invite path).
func bootstrapToken(t *testing.T, svc *auth.Service) string {
	t.Helper()
	invite, err := svc.CreateInvite(context.Background(), "", false, "")
	if err != nil {
		t.Fatalf("bootstrap invite: %v", err)
	}
	return invite.Token
}

// registerUser registers a fresh user over HTTP using a fresh client (so its
// cookie jar is isolated) and returns that authenticated client plus the user.
func registerUser(t *testing.T, srv *httptest.Server, token, username, password string) (*http.Client, auth.User) {
	t.Helper()
	c := client(t)
	resp := doJSON(t, c, http.MethodPost, srv.URL+"/api/auth/register", map[string]string{
		"inviteToken": token, "username": username, "password": password,
	})
	mustStatus(t, resp, http.StatusCreated)
	if !hasSessionCookie(resp) {
		t.Fatal("expected sh_session cookie on register")
	}
	var sr auth.SessionResponse
	decode(t, resp, &sr)
	return c, sr.User
}

func hasSessionCookie(resp *http.Response) bool {
	for _, ck := range resp.Cookies() {
		if ck.Name == auth.DefaultCookieName && ck.Value != "" {
			return true
		}
	}
	return false
}

func TestHealthz(t *testing.T) {
	srv, _, _ := newEnv(t)
	resp, err := http.Get(srv.URL + "/healthz")
	if err != nil {
		t.Fatalf("get healthz: %v", err)
	}
	mustStatus(t, resp, http.StatusOK)
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if string(body) != "ok" {
		t.Fatalf("healthz body = %q, want ok", string(body))
	}
}

func TestAuthFlow(t *testing.T) {
	srv, svc, _ := newEnv(t)
	token := bootstrapToken(t, svc)

	c, user := registerUser(t, srv, token, "alice", "password123")
	if user.Username != "alice" {
		t.Fatalf("unexpected user: %+v", user)
	}

	// me with cookie → 200
	resp := doJSON(t, c, http.MethodGet, srv.URL+"/api/auth/me", nil)
	mustStatus(t, resp, http.StatusOK)
	resp.Body.Close()

	// me without cookie → 401
	resp = doJSON(t, client(t), http.MethodGet, srv.URL+"/api/auth/me", nil)
	mustStatus(t, resp, http.StatusUnauthorized)
	resp.Body.Close()

	// login wrong password → 401
	resp = doJSON(t, client(t), http.MethodPost, srv.URL+"/api/auth/login", map[string]string{
		"username": "alice", "password": "nope-wrong",
	})
	mustStatus(t, resp, http.StatusUnauthorized)
	resp.Body.Close()

	// logout → 204, then me → 401
	resp = doJSON(t, c, http.MethodPost, srv.URL+"/api/auth/logout", nil)
	mustStatus(t, resp, http.StatusNoContent)
	resp.Body.Close()

	resp = doJSON(t, c, http.MethodGet, srv.URL+"/api/auth/me", nil)
	mustStatus(t, resp, http.StatusUnauthorized)
	resp.Body.Close()
}

func TestInvites(t *testing.T) {
	srv, svc, ex := newEnv(t)
	token := bootstrapToken(t, svc)
	c, user := registerUser(t, srv, token, "alice", "password123")

	// Without can_invite/admin → 403.
	resp := doJSON(t, c, http.MethodPost, srv.URL+"/api/invites", map[string]any{})
	mustStatus(t, resp, http.StatusForbidden)
	resp.Body.Close()

	// Grant can_invite directly, then create succeeds with token+url.
	ex.grantCanInvite(t, user.ID)
	resp = doJSON(t, c, http.MethodPost, srv.URL+"/api/invites", map[string]any{})
	mustStatus(t, resp, http.StatusCreated)
	var created struct {
		Invite auth.Invite `json:"invite"`
	}
	decode(t, resp, &created)
	if created.Invite.Token == "" {
		t.Fatal("expected invite token")
	}
	if !strings.HasPrefix(created.Invite.URL, "/?invite=") {
		t.Fatalf("unexpected invite url %q", created.Invite.URL)
	}

	// List shows the active invite.
	resp = doJSON(t, c, http.MethodGet, srv.URL+"/api/invites", nil)
	mustStatus(t, resp, http.StatusOK)
	var listed struct {
		Invites []auth.Invite `json:"invites"`
	}
	decode(t, resp, &listed)
	if len(listed.Invites) != 1 {
		t.Fatalf("expected 1 active invite, got %d", len(listed.Invites))
	}

	// Delete it.
	resp = doJSON(t, c, http.MethodDelete, srv.URL+"/api/invites/"+listed.Invites[0].ID, nil)
	mustStatus(t, resp, http.StatusNoContent)
	resp.Body.Close()

	resp = doJSON(t, c, http.MethodGet, srv.URL+"/api/invites", nil)
	mustStatus(t, resp, http.StatusOK)
	decode(t, resp, &listed)
	if len(listed.Invites) != 0 {
		t.Fatalf("expected 0 invites after delete, got %d", len(listed.Invites))
	}
}

func TestRooms(t *testing.T) {
	srv, svc, _ := newEnv(t)
	token := bootstrapToken(t, svc)
	c, _ := registerUser(t, srv, token, "alice", "password123")

	// POST without auth → 401.
	resp := doJSON(t, client(t), http.MethodPost, srv.URL+"/api/rooms", nil)
	mustStatus(t, resp, http.StatusUnauthorized)
	resp.Body.Close()

	// POST with auth → 201 with slug/url.
	resp = doJSON(t, c, http.MethodPost, srv.URL+"/api/rooms", nil)
	mustStatus(t, resp, http.StatusCreated)
	var created struct {
		Room rooms.RoomInfo `json:"room"`
	}
	decode(t, resp, &created)
	if created.Room.Slug == "" || created.Room.URL != "/r/"+created.Room.Slug {
		t.Fatalf("unexpected room: %+v", created.Room)
	}
	slug := created.Room.Slug

	// GET /api/rooms (auth) lists it.
	resp = doJSON(t, c, http.MethodGet, srv.URL+"/api/rooms", nil)
	mustStatus(t, resp, http.StatusOK)
	var list struct {
		Rooms []rooms.RoomSummary `json:"rooms"`
	}
	decode(t, resp, &list)
	if len(list.Rooms) != 1 || list.Rooms[0].Slug != slug {
		t.Fatalf("expected room in list, got %+v", list.Rooms)
	}

	// GET /api/rooms/{slug} (no auth) → 200 joinable.
	resp = doJSON(t, client(t), http.MethodGet, srv.URL+"/api/rooms/"+slug, nil)
	mustStatus(t, resp, http.StatusOK)
	var got struct {
		Room struct {
			Slug     string `json:"slug"`
			Joinable bool   `json:"joinable"`
		} `json:"room"`
	}
	decode(t, resp, &got)
	if got.Room.Slug != slug || !got.Room.Joinable {
		t.Fatalf("expected joinable room, got %+v", got.Room)
	}

	// Unknown slug → 404.
	resp = doJSON(t, client(t), http.MethodGet, srv.URL+"/api/rooms/nope", nil)
	mustStatus(t, resp, http.StatusNotFound)
	resp.Body.Close()
}

func TestConfig(t *testing.T) {
	srv, _, _ := newEnv(t)
	resp, err := http.Get(srv.URL + "/api/config")
	if err != nil {
		t.Fatalf("get config: %v", err)
	}
	mustStatus(t, resp, http.StatusOK)
	var cfg struct {
		ICEServers []struct {
			URLs       []string `json:"urls"`
			Username   string   `json:"username"`
			Credential string   `json:"credential"`
		} `json:"iceServers"`
	}
	decode(t, resp, &cfg)
	if len(cfg.ICEServers) != 2 {
		t.Fatalf("expected stun + turn servers, got %d", len(cfg.ICEServers))
	}
	var sawTurn bool
	for _, s := range cfg.ICEServers {
		if len(s.URLs) == 1 && strings.HasPrefix(s.URLs[0], "turn:") {
			sawTurn = true
			if s.Username == "" || s.Credential == "" {
				t.Fatalf("turn server missing credentials: %+v", s)
			}
		}
	}
	if !sawTurn {
		t.Fatal("expected a turn server entry")
	}
}

func TestAdmin(t *testing.T) {
	srv, svc, ex := newEnv(t)
	token := bootstrapToken(t, svc)
	adminClient, admin := registerUser(t, srv, token, "admin", "password123")
	ex.makeAdmin(t, admin.ID)

	// Create a second (non-admin) user via an admin-minted invite.
	inv, err := svc.CreateInvite(context.Background(), admin.ID, false, "")
	if err != nil {
		t.Fatalf("admin invite: %v", err)
	}
	bobClient, bob := registerUser(t, srv, inv.Token, "bob", "password123")

	// Non-admin → 403 on list.
	resp := doJSON(t, bobClient, http.MethodGet, srv.URL+"/api/admin/users", nil)
	mustStatus(t, resp, http.StatusForbidden)
	resp.Body.Close()

	// Admin → 200 list.
	resp = doJSON(t, adminClient, http.MethodGet, srv.URL+"/api/admin/users", nil)
	mustStatus(t, resp, http.StatusOK)
	var users struct {
		Users []auth.AdminUserView `json:"users"`
	}
	decode(t, resp, &users)
	if len(users.Users) != 2 {
		t.Fatalf("expected 2 users, got %d", len(users.Users))
	}

	// Non-admin PATCH → 403.
	resp = doJSON(t, bobClient, http.MethodPatch, srv.URL+"/api/admin/users/"+bob.ID, map[string]any{"canInvite": true})
	mustStatus(t, resp, http.StatusForbidden)
	resp.Body.Close()

	// Admin PATCH canInvite → 204, and effect is visible.
	resp = doJSON(t, adminClient, http.MethodPatch, srv.URL+"/api/admin/users/"+bob.ID, map[string]any{"canInvite": true})
	mustStatus(t, resp, http.StatusNoContent)
	resp.Body.Close()

	// Bob can now create an invite.
	resp = doJSON(t, bobClient, http.MethodPost, srv.URL+"/api/invites", map[string]any{})
	mustStatus(t, resp, http.StatusCreated)
	resp.Body.Close()
}

func TestAccountUpdate(t *testing.T) {
	srv, svc, _ := newEnv(t)
	token := bootstrapToken(t, svc)
	c, _ := registerUser(t, srv, token, "alice", "password123")

	resp := doJSON(t, c, http.MethodPatch, srv.URL+"/api/account", map[string]any{"name": "Alice L"})
	mustStatus(t, resp, http.StatusOK)
	var sr auth.SessionResponse
	decode(t, resp, &sr)
	if sr.User.Name != "Alice L" {
		t.Fatalf("expected updated name, got %q", sr.User.Name)
	}
}
