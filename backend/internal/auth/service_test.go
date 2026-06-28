package auth

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"testing"
	"time"

	"sozvon-hub/backend/internal/testutil"
)

// fastParams keep argon2 cheap so the suite runs quickly; correctness of the
// KDF itself is covered in password_test.go with the real defaults.
func fastParams() PasswordParams {
	return PasswordParams{MemoryKiB: 8, Iterations: 1, Parallelism: 1, SaltBytes: 16, KeyBytes: 32}
}

func newTestService(t *testing.T) (*Service, *sql.DB) {
	t.Helper()
	database := testutil.NewDB(t)
	svc := NewService(database, Config{PasswordParams: fastParams()})
	return svc, database
}

// makeAdmin promotes a user to administrator via direct SQL, mirroring the only
// way the application itself grants admin (no service method exists).
func makeAdmin(t *testing.T, database *sql.DB, userID string) {
	t.Helper()
	if _, err := database.ExecContext(context.Background(),
		`update users set is_admin = 1 where id = ?`, userID); err != nil {
		t.Fatalf("make admin: %v", err)
	}
}

// bootstrapUser creates the first account via the bootstrap invite path and
// returns its session token and User.
func bootstrapUser(t *testing.T, svc *Service, username, password string) (string, User) {
	t.Helper()
	invite, err := svc.CreateInvite(context.Background(), "", false, "")
	if err != nil {
		t.Fatalf("bootstrap CreateInvite: %v", err)
	}
	token, user, err := svc.RegisterWithInvite(context.Background(), invite.Token, username, password)
	if err != nil {
		t.Fatalf("bootstrap RegisterWithInvite: %v", err)
	}
	return token, user
}

func TestCreateInviteBootstrap(t *testing.T) {
	svc, _ := newTestService(t)
	ctx := context.Background()

	invite, err := svc.CreateInvite(ctx, "", false, "")
	if err != nil {
		t.Fatalf("bootstrap invite: %v", err)
	}
	if invite.Token == "" || invite.ID == "" {
		t.Fatal("expected non-empty invite token and id")
	}

	if _, _, err := svc.RegisterWithInvite(ctx, invite.Token, "alice", "password123"); err != nil {
		t.Fatalf("register first user: %v", err)
	}

	// Once a user exists, anonymous bootstrap is forbidden.
	if _, err := svc.CreateInvite(ctx, "", false, ""); !errors.Is(err, ErrForbidden) {
		t.Fatalf("expected ErrForbidden after first user, got %v", err)
	}
}

func TestRegisterWithInvite(t *testing.T) {
	svc, _ := newTestService(t)
	ctx := context.Background()

	invite, _ := svc.CreateInvite(ctx, "", false, "")
	token, user, err := svc.RegisterWithInvite(ctx, invite.Token, "alice", "password123")
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	if token == "" {
		t.Fatal("expected session token")
	}
	if user.Username != "alice" || user.Name != "alice" {
		t.Fatalf("unexpected user: %+v", user)
	}

	// A session row was created — the returned token resolves to the user.
	got, err := svc.CurrentUser(ctx, token)
	if err != nil {
		t.Fatalf("CurrentUser after register: %v", err)
	}
	if got.ID != user.ID {
		t.Fatalf("session resolves to %q, want %q", got.ID, user.ID)
	}
}

func TestChangePassword(t *testing.T) {
	svc, _ := newTestService(t)
	ctx := context.Background()
	invite, _ := svc.CreateInvite(ctx, "", false, "")
	_, user, err := svc.RegisterWithInvite(ctx, invite.Token, "alice", "password123")
	if err != nil {
		t.Fatalf("register: %v", err)
	}

	// Wrong current password is rejected.
	if err := svc.ChangePassword(ctx, user.ID, "wrong-password", "newpassword456"); !errors.Is(err, ErrInvalidCredentials) {
		t.Fatalf("expected ErrInvalidCredentials, got %v", err)
	}
	// New password that fails policy is rejected.
	if err := svc.ChangePassword(ctx, user.ID, "password123", "short"); err == nil || err.Error() != "invalid_password" {
		t.Fatalf("expected invalid_password, got %v", err)
	}
	// Correct current + valid new password succeeds.
	if err := svc.ChangePassword(ctx, user.ID, "password123", "newpassword456"); err != nil {
		t.Fatalf("change password: %v", err)
	}
	// Old password no longer logs in; the new one does.
	if _, _, err := svc.Login(ctx, "alice", "password123"); !errors.Is(err, ErrInvalidCredentials) {
		t.Fatalf("old password should fail, got %v", err)
	}
	if _, _, err := svc.Login(ctx, "alice", "newpassword456"); err != nil {
		t.Fatalf("login with new password: %v", err)
	}
}

func TestRegisterEmptyTokenRequiresInvite(t *testing.T) {
	svc, _ := newTestService(t)
	if _, _, err := svc.RegisterWithInvite(context.Background(), "", "alice", "password123"); !errors.Is(err, ErrInviteRequired) {
		t.Fatalf("expected ErrInviteRequired, got %v", err)
	}
}

func TestRegisterUnknownInvite(t *testing.T) {
	svc, _ := newTestService(t)
	if _, _, err := svc.RegisterWithInvite(context.Background(), "totally-unknown", "alice", "password123"); !errors.Is(err, ErrInvalidInvite) {
		t.Fatalf("expected ErrInvalidInvite, got %v", err)
	}
}

func TestRegisterUsedInvite(t *testing.T) {
	svc, _ := newTestService(t)
	ctx := context.Background()
	invite, _ := svc.CreateInvite(ctx, "", false, "")
	if _, _, err := svc.RegisterWithInvite(ctx, invite.Token, "alice", "password123"); err != nil {
		t.Fatalf("first register: %v", err)
	}
	if _, _, err := svc.RegisterWithInvite(ctx, invite.Token, "bob", "password123"); !errors.Is(err, ErrInvalidInvite) {
		t.Fatalf("expected ErrInvalidInvite for reused token, got %v", err)
	}
}

func TestRegisterExpiredInvite(t *testing.T) {
	svc, database := newTestService(t)
	ctx := context.Background()
	invite, _ := svc.CreateInvite(ctx, "", false, "")

	past := time.Now().UTC().Add(-time.Hour).Format(timeFormat)
	if _, err := database.ExecContext(ctx,
		`update account_invites set expires_at = ? where id = ?`, past, invite.ID); err != nil {
		t.Fatalf("expire invite: %v", err)
	}
	if _, _, err := svc.RegisterWithInvite(ctx, invite.Token, "alice", "password123"); !errors.Is(err, ErrInvalidInvite) {
		t.Fatalf("expected ErrInvalidInvite for expired token, got %v", err)
	}
}

func TestRegisterUsernameTaken(t *testing.T) {
	svc, _ := newTestService(t)
	ctx := context.Background()
	invite1, _ := svc.CreateInvite(ctx, "", false, "")
	creator, _, err := svc.RegisterWithInvite(ctx, invite1.Token, "alice", "password123")
	if err != nil {
		t.Fatalf("register first: %v", err)
	}

	user, err := svc.CurrentUser(ctx, creator)
	if err != nil {
		t.Fatalf("CurrentUser: %v", err)
	}
	makeAdminCanInvite(t, svc, user.ID)

	invite2, err := svc.CreateInvite(ctx, user.ID, false, "")
	if err != nil {
		t.Fatalf("create second invite: %v", err)
	}
	if _, _, err := svc.RegisterWithInvite(ctx, invite2.Token, "alice", "password123"); !errors.Is(err, ErrUsernameTaken) {
		t.Fatalf("expected ErrUsernameTaken, got %v", err)
	}
}

func makeAdminCanInvite(t *testing.T, svc *Service, userID string) {
	t.Helper()
	if _, err := svc.db.ExecContext(context.Background(),
		`update users set can_invite = 1 where id = ?`, userID); err != nil {
		t.Fatalf("grant can_invite: %v", err)
	}
}

func TestRegisterInvalidUsernameAndPassword(t *testing.T) {
	svc, _ := newTestService(t)
	ctx := context.Background()

	invite, _ := svc.CreateInvite(ctx, "", false, "")
	if _, _, err := svc.RegisterWithInvite(ctx, invite.Token, "  ", "password123"); err == nil || err.Error() != "invalid_username" {
		t.Fatalf("expected invalid_username, got %v", err)
	}

	invite2, _ := svc.CreateInvite(ctx, "", false, "")
	if _, _, err := svc.RegisterWithInvite(ctx, invite2.Token, "alice", "short"); err == nil || err.Error() != "invalid_password" {
		t.Fatalf("expected invalid_password, got %v", err)
	}
}

func TestInvitePreGrantByAdmin(t *testing.T) {
	svc, database := newTestService(t)
	ctx := context.Background()

	_, admin := bootstrapUser(t, svc, "admin", "password123")
	makeAdmin(t, database, admin.ID)

	invite, err := svc.CreateInvite(ctx, admin.ID, true, "trusted colleague")
	if err != nil {
		t.Fatalf("admin CreateInvite: %v", err)
	}
	if _, newUser, err := svc.RegisterWithInvite(ctx, invite.Token, "bob", "password123"); err != nil {
		t.Fatalf("register invited: %v", err)
	} else if !newUser.CanInvite {
		t.Fatal("expected pre-granted user to have can_invite=true")
	}

	users, err := svc.ListUsers(ctx)
	if err != nil {
		t.Fatalf("ListUsers: %v", err)
	}
	bob := findUser(t, users, "bob")
	if !bob.CanInvite {
		t.Fatal("expected bob.CanInvite=true")
	}
	if bob.AdminNote != "trusted colleague" {
		t.Fatalf("expected admin note carried over, got %q", bob.AdminNote)
	}
}

func TestInvitePreGrantIgnoredForNonAdmin(t *testing.T) {
	svc, database := newTestService(t)
	ctx := context.Background()

	// First account (admin) creates an inviter with can_invite but not admin.
	_, admin := bootstrapUser(t, svc, "admin", "password123")
	makeAdmin(t, database, admin.ID)
	inviterInvite, _ := svc.CreateInvite(ctx, admin.ID, true, "")
	_, inviter, err := svc.RegisterWithInvite(ctx, inviterInvite.Token, "inviter", "password123")
	if err != nil {
		t.Fatalf("register inviter: %v", err)
	}
	if inviter.IsAdmin {
		t.Fatal("inviter must not be admin")
	}

	// Non-admin requests grant + note; both must be forced off.
	invite, err := svc.CreateInvite(ctx, inviter.ID, true, "should be dropped")
	if err != nil {
		t.Fatalf("non-admin CreateInvite: %v", err)
	}
	_, newUser, err := svc.RegisterWithInvite(ctx, invite.Token, "bob", "password123")
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	if newUser.CanInvite {
		t.Fatal("expected can_invite forced to false for non-admin invite")
	}

	bob := findUser(t, mustListUsers(t, svc), "bob")
	if bob.CanInvite {
		t.Fatal("expected bob.CanInvite=false")
	}
	if bob.AdminNote != "" {
		t.Fatalf("expected empty admin note, got %q", bob.AdminNote)
	}
}

func TestCreateInviteGating(t *testing.T) {
	svc, database := newTestService(t)
	ctx := context.Background()

	_, admin := bootstrapUser(t, svc, "admin", "password123")
	makeAdmin(t, database, admin.ID)

	// A user with can_invite=false and is_admin=false → forbidden.
	noPermInvite, _ := svc.CreateInvite(ctx, admin.ID, false, "")
	_, noPerm, _ := svc.RegisterWithInvite(ctx, noPermInvite.Token, "noperm", "password123")
	if _, err := svc.CreateInvite(ctx, noPerm.ID, false, ""); !errors.Is(err, ErrForbidden) {
		t.Fatalf("expected ErrForbidden for non-inviter, got %v", err)
	}

	// can_invite=true → ok.
	canInvite, _ := svc.CreateInvite(ctx, admin.ID, true, "")
	_, granted, _ := svc.RegisterWithInvite(ctx, canInvite.Token, "granted", "password123")
	if _, err := svc.CreateInvite(ctx, granted.ID, false, ""); err != nil {
		t.Fatalf("expected can_invite user to create invite, got %v", err)
	}

	// is_admin=true even with can_invite=false → ok.
	canFalse := false
	if err := svc.AdminUpdateUser(ctx, admin.ID, &canFalse, nil); err != nil {
		t.Fatalf("AdminUpdateUser: %v", err)
	}
	if _, err := svc.CreateInvite(ctx, admin.ID, false, ""); err != nil {
		t.Fatalf("expected admin to create invite even with can_invite=false, got %v", err)
	}
}

func TestLogin(t *testing.T) {
	svc, database := newTestService(t)
	ctx := context.Background()

	_, user := bootstrapUser(t, svc, "alice", "password123")
	makeAdmin(t, database, user.ID)
	makeAdminCanInvite(t, svc, user.ID)

	token, logged, err := svc.Login(ctx, "alice", "password123")
	if err != nil {
		t.Fatalf("Login: %v", err)
	}
	if token == "" {
		t.Fatal("expected session token from login")
	}
	if logged.Name != "alice" || !logged.IsAdmin || !logged.CanInvite {
		t.Fatalf("unexpected logged-in user: %+v", logged)
	}

	if _, _, err := svc.Login(ctx, "alice", "wrong-password"); !errors.Is(err, ErrInvalidCredentials) {
		t.Fatalf("expected ErrInvalidCredentials for wrong password, got %v", err)
	}
	if _, _, err := svc.Login(ctx, "nobody", "password123"); !errors.Is(err, ErrInvalidCredentials) {
		t.Fatalf("expected ErrInvalidCredentials for unknown user, got %v", err)
	}
}

func TestCurrentUserAndLogout(t *testing.T) {
	svc, _ := newTestService(t)
	ctx := context.Background()
	token, user := bootstrapUser(t, svc, "alice", "password123")

	if _, err := svc.CurrentUser(ctx, ""); !errors.Is(err, ErrNotAuthenticated) {
		t.Fatalf("expected ErrNotAuthenticated for empty token, got %v", err)
	}

	got, err := svc.CurrentUser(ctx, token)
	if err != nil {
		t.Fatalf("CurrentUser: %v", err)
	}
	if got.ID != user.ID {
		t.Fatalf("CurrentUser returned %q, want %q", got.ID, user.ID)
	}

	if err := svc.Logout(ctx, token); err != nil {
		t.Fatalf("Logout: %v", err)
	}
	if _, err := svc.CurrentUser(ctx, token); !errors.Is(err, ErrNotAuthenticated) {
		t.Fatalf("expected ErrNotAuthenticated after logout, got %v", err)
	}
}

func TestCurrentUserExpiredSession(t *testing.T) {
	svc, database := newTestService(t)
	ctx := context.Background()
	token, _ := bootstrapUser(t, svc, "alice", "password123")

	past := time.Now().UTC().Add(-time.Hour).Format(timeFormat)
	if _, err := database.ExecContext(ctx,
		`update sessions set expires_at = ?`, past); err != nil {
		t.Fatalf("expire session: %v", err)
	}
	if _, err := svc.CurrentUser(ctx, token); !errors.Is(err, ErrNotAuthenticated) {
		t.Fatalf("expected ErrNotAuthenticated for expired session, got %v", err)
	}
}

func TestUpdateAccount(t *testing.T) {
	svc, _ := newTestService(t)
	ctx := context.Background()
	_, user := bootstrapUser(t, svc, "alice", "password123")

	// Change display name.
	newName := "Alice Liddell"
	updated, err := svc.UpdateAccount(ctx, user.ID, nil, &newName)
	if err != nil {
		t.Fatalf("UpdateAccount name: %v", err)
	}
	if updated.Name != "Alice Liddell" {
		t.Fatalf("name not updated: %+v", updated)
	}

	// Change username.
	newUsername := "alice2"
	updated, err = svc.UpdateAccount(ctx, user.ID, &newUsername, nil)
	if err != nil {
		t.Fatalf("UpdateAccount username: %v", err)
	}
	if updated.Username != "alice2" {
		t.Fatalf("username not updated: %+v", updated)
	}

	// nil fields → no-op, returns current user unchanged.
	noop, err := svc.UpdateAccount(ctx, user.ID, nil, nil)
	if err != nil {
		t.Fatalf("UpdateAccount no-op: %v", err)
	}
	if noop.Username != "alice2" || noop.Name != "Alice Liddell" {
		t.Fatalf("no-op changed user: %+v", noop)
	}
}

func TestUpdateAccountUsernameCollision(t *testing.T) {
	svc, database := newTestService(t)
	ctx := context.Background()

	_, admin := bootstrapUser(t, svc, "admin", "password123")
	makeAdmin(t, database, admin.ID)
	invite, _ := svc.CreateInvite(ctx, admin.ID, false, "")
	_, bob, _ := svc.RegisterWithInvite(ctx, invite.Token, "bob", "password123")

	taken := "admin"
	if _, err := svc.UpdateAccount(ctx, bob.ID, &taken, nil); !errors.Is(err, ErrUsernameTaken) {
		t.Fatalf("expected ErrUsernameTaken, got %v", err)
	}
}

func TestUpdateAccountInvalidFields(t *testing.T) {
	svc, _ := newTestService(t)
	ctx := context.Background()
	_, user := bootstrapUser(t, svc, "alice", "password123")

	bad := "   "
	if _, err := svc.UpdateAccount(ctx, user.ID, nil, &bad); err == nil || err.Error() != "invalid_name" {
		t.Fatalf("expected invalid_name, got %v", err)
	}
	if _, err := svc.UpdateAccount(ctx, user.ID, &bad, nil); err == nil || err.Error() != "invalid_username" {
		t.Fatalf("expected invalid_username, got %v", err)
	}
}

func TestListUsersProjection(t *testing.T) {
	svc, database := newTestService(t)
	ctx := context.Background()

	_, admin := bootstrapUser(t, svc, "admin", "password123")
	makeAdmin(t, database, admin.ID)
	invite, _ := svc.CreateInvite(ctx, admin.ID, true, "the note")
	_, bob, _ := svc.RegisterWithInvite(ctx, invite.Token, "bob", "password123")

	if _, _, err := svc.Login(ctx, "bob", "password123"); err != nil {
		t.Fatalf("login bob: %v", err)
	}

	users := mustListUsers(t, svc)
	a := findUser(t, users, "admin")
	if !a.IsAdmin {
		t.Fatal("expected admin.IsAdmin=true")
	}
	if a.CreatedAt == "" {
		t.Fatal("expected admin.CreatedAt populated")
	}

	b := findUser(t, users, "bob")
	if b.IsAdmin {
		t.Fatal("expected bob.IsAdmin=false")
	}
	if !b.CanInvite {
		t.Fatal("expected bob.CanInvite=true")
	}
	if b.AdminNote != "the note" {
		t.Fatalf("expected bob.AdminNote, got %q", b.AdminNote)
	}
	if b.LastSeenAt == "" {
		t.Fatal("expected bob.LastSeenAt populated after login")
	}
	_ = bob
}

func TestAdminUpdateUser(t *testing.T) {
	svc, database := newTestService(t)
	ctx := context.Background()

	_, admin := bootstrapUser(t, svc, "admin", "password123")
	makeAdmin(t, database, admin.ID)
	invite, _ := svc.CreateInvite(ctx, admin.ID, false, "")
	_, bob, _ := svc.RegisterWithInvite(ctx, invite.Token, "bob", "password123")

	// set canInvite alone
	canInvite := true
	if err := svc.AdminUpdateUser(ctx, bob.ID, &canInvite, nil); err != nil {
		t.Fatalf("set canInvite: %v", err)
	}
	if !findUser(t, mustListUsers(t, svc), "bob").CanInvite {
		t.Fatal("canInvite not applied")
	}

	// set adminNote alone
	note := "promoted"
	if err := svc.AdminUpdateUser(ctx, bob.ID, nil, &note); err != nil {
		t.Fatalf("set adminNote: %v", err)
	}
	if findUser(t, mustListUsers(t, svc), "bob").AdminNote != "promoted" {
		t.Fatal("adminNote not applied")
	}

	// set both
	canInvite = false
	note = "demoted"
	if err := svc.AdminUpdateUser(ctx, bob.ID, &canInvite, &note); err != nil {
		t.Fatalf("set both: %v", err)
	}
	b := findUser(t, mustListUsers(t, svc), "bob")
	if b.CanInvite || b.AdminNote != "demoted" {
		t.Fatalf("both not applied: %+v", b)
	}
}

func TestSingleAdminConstraint(t *testing.T) {
	svc, database := newTestService(t)
	ctx := context.Background()

	_, admin := bootstrapUser(t, svc, "admin", "password123")
	makeAdmin(t, database, admin.ID)

	invite, _ := svc.CreateInvite(ctx, admin.ID, false, "")
	_, bob, _ := svc.RegisterWithInvite(ctx, invite.Token, "bob", "password123")

	// The migration 0004 partial unique index allows only one row with is_admin=1.
	_, err := database.ExecContext(ctx, `update users set is_admin = 1 where id = ?`, bob.ID)
	if err == nil {
		t.Fatal("expected UNIQUE constraint error promoting a second admin")
	}
	if !strings.Contains(strings.ToLower(err.Error()), "unique") {
		t.Fatalf("expected unique constraint error, got %v", err)
	}
}

func TestNormalizeAdminNote(t *testing.T) {
	if note, err := normalizeAdminNote("  hello  "); err != nil || note != "hello" {
		t.Fatalf("expected trimmed note, got %q err=%v", note, err)
	}
	if _, err := normalizeAdminNote(strings.Repeat("x", 100)); err != nil {
		t.Fatalf("100 runes should be allowed: %v", err)
	}
	if _, err := normalizeAdminNote(strings.Repeat("x", 101)); err == nil {
		t.Fatal("expected error for >100 runes")
	}
}

func mustListUsers(t *testing.T, svc *Service) []AdminUserView {
	t.Helper()
	users, err := svc.ListUsers(context.Background())
	if err != nil {
		t.Fatalf("ListUsers: %v", err)
	}
	return users
}

func findUser(t *testing.T, users []AdminUserView, username string) AdminUserView {
	t.Helper()
	for _, u := range users {
		if u.Username == username {
			return u
		}
	}
	t.Fatalf("user %q not found in %d users", username, len(users))
	return AdminUserView{}
}
