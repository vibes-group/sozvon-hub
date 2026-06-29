// Package auth implements invite-only account registration, password login, and
// cookie-backed sessions over SQLite. It is the auth slice adapted from
// message-hub, stripped of profiles, contacts, devices, and messaging.
package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
)

const DefaultCookieName = "sh_session"
const timeFormat = "2006-01-02T15:04:05.000000000Z"

type Config struct {
	CookieName     string
	CookieSecure   bool
	SessionTTL     time.Duration
	InviteTTL      time.Duration
	PasswordParams PasswordParams
}

type Service struct {
	db  *sql.DB
	cfg Config
}

type sessionMetaKey struct{}

// SessionMeta is the device/network fingerprint stored alongside a session so
// the user can recognise a login. IPHash is opaque and never returned to clients.
type SessionMeta struct {
	UserAgent string
	IPHash    []byte
}

// WithSessionMeta carries the login fingerprint into Login/Register, which read
// it off the context so their signatures stay narrow.
func WithSessionMeta(ctx context.Context, meta SessionMeta) context.Context {
	return context.WithValue(ctx, sessionMetaKey{}, meta)
}

func sessionMetaFrom(ctx context.Context) (userAgent any, ipHash any) {
	meta, _ := ctx.Value(sessionMetaKey{}).(SessionMeta)
	if meta.UserAgent != "" {
		userAgent = meta.UserAgent
	}
	if len(meta.IPHash) > 0 {
		ipHash = meta.IPHash
	}
	return userAgent, ipHash
}

type User struct {
	ID        string `json:"id"`
	Username  string `json:"username"`
	Name      string `json:"name"`
	IsAdmin   bool   `json:"isAdmin"`
	CanInvite bool   `json:"canInvite"`
}

type SessionResponse struct {
	User User `json:"user"`
}

type Invite struct {
	ID        string  `json:"id"`
	Token     string  `json:"token,omitempty"`
	URL       string  `json:"url,omitempty"`
	ExpiresAt string  `json:"expiresAt"`
	UsedAt    *string `json:"usedAt"`
}

var (
	ErrInvalidCredentials = errors.New("invalid_credentials")
	ErrNotAuthenticated   = errors.New("not_authenticated")
	ErrUsernameTaken      = errors.New("username_taken")
	ErrInvalidInvite      = errors.New("invalid_invite")
	ErrInviteRequired     = errors.New("invite_required")
	ErrForbidden          = errors.New("forbidden_auth")
)

func NewService(database *sql.DB, cfg Config) *Service {
	if cfg.CookieName == "" {
		cfg.CookieName = DefaultCookieName
	}
	if cfg.SessionTTL == 0 {
		cfg.SessionTTL = 30 * 24 * time.Hour
	}
	if cfg.InviteTTL == 0 {
		cfg.InviteTTL = 7 * 24 * time.Hour
	}
	if cfg.PasswordParams.MemoryKiB == 0 {
		cfg.PasswordParams = DefaultPasswordParams()
	}
	return &Service{db: database, cfg: cfg}
}

func (s *Service) RegisterWithInvite(ctx context.Context, inviteToken, username, password string) (string, User, error) {
	if inviteToken == "" {
		return "", User{}, ErrInviteRequired
	}
	inviteTokenHash := sha256.Sum256([]byte(inviteToken))
	return s.createUserSession(ctx, username, password, func(ctx context.Context, tx *sql.Tx, _ string) (bool, string, error) {
		now := time.Now().UTC().Format(timeFormat)
		// Consume the invite and read what it grants in one atomic step.
		var grant int
		var note string
		err := tx.QueryRowContext(ctx, `
			update account_invites
			set used_at = ?
			where token_hash = ?
			  and used_at is null
			  and expires_at > ?
			returning grant_can_invite, admin_note
		`, now, inviteTokenHash[:], now).Scan(&grant, &note)
		if errors.Is(err, sql.ErrNoRows) {
			return false, "", ErrInvalidInvite
		}
		if err != nil {
			return false, "", fmt.Errorf("consume invite: %w", err)
		}
		return grant == 1, note, nil
	})
}

func (s *Service) createUserSession(
	ctx context.Context,
	username, password string,
	prep func(context.Context, *sql.Tx, string) (canInvite bool, adminNote string, err error),
) (string, User, error) {
	normalizedUsername, err := normalizeUsername(username)
	if err != nil {
		return "", User{}, err
	}
	if err := validatePassword(password); err != nil {
		return "", User{}, err
	}

	passwordHash, err := HashPassword(password, s.cfg.PasswordParams)
	if err != nil {
		return "", User{}, err
	}

	userID := uuid.NewString()
	sessionID := uuid.NewString()
	token, tokenHash, err := newOpaqueToken()
	if err != nil {
		return "", User{}, err
	}
	expiresAt := time.Now().UTC().Add(s.cfg.SessionTTL).Format(timeFormat)

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return "", User{}, fmt.Errorf("begin register: %w", err)
	}
	defer tx.Rollback()

	var canInvite bool
	var adminNote string
	if prep != nil {
		canInvite, adminNote, err = prep(ctx, tx, userID)
		if err != nil {
			return "", User{}, err
		}
	}

	canInviteInt := 0
	if canInvite {
		canInviteInt = 1
	}
	if _, err := tx.ExecContext(ctx,
		`insert into users (id, username, name, password_hash, can_invite, admin_note) values (?, ?, ?, ?, ?, ?)`,
		userID, normalizedUsername, normalizedUsername, passwordHash, canInviteInt, adminNote,
	); err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "unique") {
			return "", User{}, ErrUsernameTaken
		}
		return "", User{}, fmt.Errorf("insert user: %w", err)
	}

	userAgent, ipHash := sessionMetaFrom(ctx)
	if _, err := tx.ExecContext(ctx,
		`insert into sessions (id, user_id, token_hash, user_agent, ip_hash, expires_at) values (?, ?, ?, ?, ?, ?)`,
		sessionID, userID, tokenHash[:], userAgent, ipHash, expiresAt,
	); err != nil {
		return "", User{}, fmt.Errorf("insert session: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return "", User{}, fmt.Errorf("commit register: %w", err)
	}

	return token, User{ID: userID, Username: normalizedUsername, Name: normalizedUsername, CanInvite: canInvite}, nil
}

// CreateInvite mints a one-time registration token. An empty inviterUserID is
// only allowed to bootstrap the first account, while no users exist.
func (s *Service) CreateInvite(ctx context.Context, inviterUserID string, grantCanInvite bool, adminNote string) (Invite, error) {
	// Only the admin can pre-grant invite rights or attach a private note via the
	// invite; for everyone else these are forced off/empty.
	isAdmin := false
	if inviterUserID == "" {
		empty, err := s.noUsers(ctx)
		if err != nil {
			return Invite{}, err
		}
		if !empty {
			return Invite{}, ErrForbidden
		}
	} else {
		inviter, err := s.userByID(ctx, inviterUserID)
		if err != nil {
			return Invite{}, ErrForbidden
		}
		if !inviter.CanInvite && !inviter.IsAdmin {
			return Invite{}, ErrForbidden
		}
		isAdmin = inviter.IsAdmin
	}
	if !isAdmin {
		grantCanInvite = false
		adminNote = ""
	}
	note, err := normalizeAdminNote(adminNote)
	if err != nil {
		return Invite{}, err
	}

	token, tokenHash, err := newOpaqueToken()
	if err != nil {
		return Invite{}, err
	}
	inviteID := uuid.NewString()
	expiresAt := time.Now().UTC().Add(s.cfg.InviteTTL).Format(timeFormat)

	var invitedBy any
	if inviterUserID != "" {
		invitedBy = inviterUserID
	}
	grantInt := 0
	if grantCanInvite {
		grantInt = 1
	}
	if _, err := s.db.ExecContext(ctx, `
		insert into account_invites (id, token_hash, invited_by, expires_at, grant_can_invite, admin_note)
		values (?, ?, ?, ?, ?, ?)
	`, inviteID, tokenHash[:], invitedBy, expiresAt, grantInt, note); err != nil {
		return Invite{}, fmt.Errorf("insert invite: %w", err)
	}

	return Invite{ID: inviteID, Token: token, ExpiresAt: expiresAt}, nil
}

func (s *Service) ListActiveInvites(ctx context.Context, inviterUserID string) ([]Invite, error) {
	if _, err := s.userByID(ctx, inviterUserID); err != nil {
		return nil, ErrForbidden
	}

	now := time.Now().UTC().Format(timeFormat)
	rows, err := s.db.QueryContext(ctx, `
		select id, expires_at, used_at
		from account_invites
		where invited_by = ?
		  and used_at is null
		  and expires_at > ?
		order by created_at desc
	`, inviterUserID, now)
	if err != nil {
		return nil, fmt.Errorf("select active invites: %w", err)
	}
	defer rows.Close()

	result := []Invite{}
	for rows.Next() {
		var invite Invite
		var usedAt sql.NullString
		if err := rows.Scan(&invite.ID, &invite.ExpiresAt, &usedAt); err != nil {
			return nil, fmt.Errorf("scan invite: %w", err)
		}
		if usedAt.Valid {
			invite.UsedAt = &usedAt.String
		}
		result = append(result, invite)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate active invites: %w", err)
	}
	return result, nil
}

func (s *Service) DeleteInvite(ctx context.Context, inviterUserID, inviteID string) error {
	if inviterUserID == "" || inviteID == "" {
		return ErrForbidden
	}
	result, err := s.db.ExecContext(ctx, `
		delete from account_invites
		where id = ?
		  and invited_by = ?
		  and used_at is null
	`, inviteID, inviterUserID)
	if err != nil {
		return fmt.Errorf("delete invite: %w", err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("delete invite rows affected: %w", err)
	}
	if affected == 0 {
		return ErrForbidden
	}
	return nil
}

// AdminUserView is the admin-only projection of an account: it includes the
// private admin note and activity timestamps that never reach a normal /me.
type AdminUserView struct {
	ID         string `json:"id"`
	Username   string `json:"username"`
	Name       string `json:"name"`
	IsAdmin    bool   `json:"isAdmin"`
	CanInvite  bool   `json:"canInvite"`
	AdminNote  string `json:"adminNote"`
	CreatedAt  string `json:"createdAt"`
	LastSeenAt string `json:"lastSeenAt"`
}

// ListUsers returns every account for the admin console, with the admin's private
// note, registration time, and last-seen (latest non-revoked session activity).
func (s *Service) ListUsers(ctx context.Context) ([]AdminUserView, error) {
	rows, err := s.db.QueryContext(ctx, `
		select u.id, u.username, u.name, u.is_admin, u.can_invite, u.admin_note, u.created_at,
		       (select max(coalesce(sx.last_used_at, sx.created_at))
		          from sessions sx where sx.user_id = u.id and sx.revoked_at is null)
		from users u
		order by u.username collate nocase
	`)
	if err != nil {
		return nil, fmt.Errorf("list users: %w", err)
	}
	defer rows.Close()
	result := []AdminUserView{}
	for rows.Next() {
		var v AdminUserView
		var lastSeen sql.NullString
		if err := rows.Scan(&v.ID, &v.Username, &v.Name, &v.IsAdmin, &v.CanInvite, &v.AdminNote, &v.CreatedAt, &lastSeen); err != nil {
			return nil, fmt.Errorf("scan user: %w", err)
		}
		if lastSeen.Valid {
			v.LastSeenAt = lastSeen.String
		}
		result = append(result, v)
	}
	return result, rows.Err()
}

// AdminUpdateUser sets a user's invite permission and/or the admin's private
// note. A nil field is left unchanged.
func (s *Service) AdminUpdateUser(ctx context.Context, userID string, canInvite *bool, adminNote *string) error {
	if userID == "" {
		return ErrForbidden
	}
	now := time.Now().UTC().Format(timeFormat)
	if canInvite != nil {
		v := 0
		if *canInvite {
			v = 1
		}
		if _, err := s.db.ExecContext(ctx,
			`update users set can_invite = ?, updated_at = ? where id = ?`, v, now, userID); err != nil {
			return fmt.Errorf("set can_invite: %w", err)
		}
	}
	if adminNote != nil {
		note, err := normalizeAdminNote(*adminNote)
		if err != nil {
			return err
		}
		if _, err := s.db.ExecContext(ctx,
			`update users set admin_note = ?, updated_at = ? where id = ?`, note, now, userID); err != nil {
			return fmt.Errorf("set admin_note: %w", err)
		}
	}
	return nil
}

func (s *Service) Login(ctx context.Context, username, password string) (string, User, error) {
	normalizedUsername, err := normalizeUsername(username)
	if err != nil {
		return "", User{}, ErrInvalidCredentials
	}

	var userID, passwordHash, name string
	var isAdmin, canInvite bool
	err = s.db.QueryRowContext(ctx,
		`select id, password_hash, name, is_admin, can_invite from users where username = ? collate nocase and disabled_at is null`,
		normalizedUsername,
	).Scan(&userID, &passwordHash, &name, &isAdmin, &canInvite)
	if errors.Is(err, sql.ErrNoRows) {
		return "", User{}, ErrInvalidCredentials
	}
	if err != nil {
		return "", User{}, fmt.Errorf("select user credentials: %w", err)
	}

	ok, err := VerifyPassword(password, passwordHash)
	if err != nil || !ok {
		return "", User{}, ErrInvalidCredentials
	}

	token, tokenHash, err := newOpaqueToken()
	if err != nil {
		return "", User{}, err
	}

	userAgent, ipHash := sessionMetaFrom(ctx)
	if _, err := s.db.ExecContext(ctx,
		`insert into sessions (id, user_id, token_hash, user_agent, ip_hash, expires_at) values (?, ?, ?, ?, ?, ?)`,
		uuid.NewString(), userID, tokenHash[:], userAgent, ipHash,
		time.Now().UTC().Add(s.cfg.SessionTTL).Format(timeFormat),
	); err != nil {
		return "", User{}, fmt.Errorf("insert session: %w", err)
	}

	return token, User{ID: userID, Username: normalizedUsername, Name: name, IsAdmin: isAdmin, CanInvite: canInvite}, nil
}

// UpdateAccount changes the caller's display name and/or username. A nil field is
// left unchanged. Username uniqueness is enforced (ErrUsernameTaken).
func (s *Service) UpdateAccount(ctx context.Context, userID string, newUsername, newName *string) (User, error) {
	if userID == "" {
		return User{}, ErrForbidden
	}
	now := time.Now().UTC().Format(timeFormat)
	if newName != nil {
		name, err := validateDisplayName(*newName)
		if err != nil {
			return User{}, err
		}
		if _, err := s.db.ExecContext(ctx,
			`update users set name = ?, updated_at = ? where id = ?`, name, now, userID,
		); err != nil {
			return User{}, fmt.Errorf("update name: %w", err)
		}
	}
	if newUsername != nil {
		username, err := normalizeUsername(*newUsername)
		if err != nil {
			return User{}, err
		}
		if _, err := s.db.ExecContext(ctx,
			`update users set username = ?, updated_at = ? where id = ?`, username, now, userID,
		); err != nil {
			if strings.Contains(strings.ToLower(err.Error()), "unique") {
				return User{}, ErrUsernameTaken
			}
			return User{}, fmt.Errorf("update username: %w", err)
		}
	}
	return s.userByID(ctx, userID)
}

// ChangePassword verifies the caller's current password and replaces it.
// Returns ErrInvalidCredentials when the current password is wrong and
// "invalid_password" when the new one fails policy.
func (s *Service) ChangePassword(ctx context.Context, userID, currentPassword, newPassword string) error {
	if userID == "" {
		return ErrForbidden
	}
	var passwordHash string
	err := s.db.QueryRowContext(ctx,
		`select password_hash from users where id = ? and disabled_at is null`, userID,
	).Scan(&passwordHash)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrForbidden
	}
	if err != nil {
		return fmt.Errorf("select password: %w", err)
	}
	ok, err := VerifyPassword(currentPassword, passwordHash)
	if err != nil {
		return fmt.Errorf("verify password: %w", err)
	}
	if !ok {
		return ErrInvalidCredentials
	}
	if err := validatePassword(newPassword); err != nil {
		return err
	}
	newHash, err := HashPassword(newPassword, s.cfg.PasswordParams)
	if err != nil {
		return fmt.Errorf("hash password: %w", err)
	}
	now := time.Now().UTC().Format(timeFormat)
	if _, err := s.db.ExecContext(ctx,
		`update users set password_hash = ?, updated_at = ? where id = ?`, newHash, now, userID,
	); err != nil {
		return fmt.Errorf("update password: %w", err)
	}
	return nil
}

func (s *Service) CurrentUser(ctx context.Context, token string) (User, error) {
	if token == "" {
		return User{}, ErrNotAuthenticated
	}

	tokenHash := sha256.Sum256([]byte(token))
	now := time.Now().UTC()
	var user User
	var sessionID string
	var lastUsedAt sql.NullString
	err := s.db.QueryRowContext(ctx, `
		select users.id, users.username, users.name, users.is_admin, users.can_invite, sessions.id, sessions.last_used_at
		from sessions
		join users on users.id = sessions.user_id
		where sessions.token_hash = ?
		  and sessions.revoked_at is null
		  and sessions.expires_at > ?
		  and users.disabled_at is null
	`, tokenHash[:], now.Format(timeFormat)).Scan(&user.ID, &user.Username, &user.Name, &user.IsAdmin, &user.CanInvite, &sessionID, &lastUsedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return User{}, ErrNotAuthenticated
	}
	if err != nil {
		return User{}, fmt.Errorf("select current user: %w", err)
	}

	s.touchSession(ctx, sessionID, lastUsedAt, now)
	return user, nil
}

const sessionTouchInterval = 5 * time.Minute

// touchSession refreshes last_used_at, throttled so the auth hot path does not
// write on every request (SQLite is a single writer).
func (s *Service) touchSession(ctx context.Context, sessionID string, lastUsedAt sql.NullString, now time.Time) {
	if lastUsedAt.Valid {
		if prev, err := time.Parse(timeFormat, lastUsedAt.String); err == nil && now.Sub(prev) < sessionTouchInterval {
			return
		}
	}
	_, _ = s.db.ExecContext(ctx,
		`update sessions set last_used_at = ? where id = ?`,
		now.Format(timeFormat), sessionID,
	)
}

func (s *Service) Logout(ctx context.Context, token string) error {
	if token == "" {
		return nil
	}
	tokenHash := sha256.Sum256([]byte(token))
	_, err := s.db.ExecContext(ctx,
		`update sessions set revoked_at = ? where token_hash = ? and revoked_at is null`,
		time.Now().UTC().Format(timeFormat), tokenHash[:],
	)
	if err != nil {
		return fmt.Errorf("revoke session: %w", err)
	}
	return nil
}

func (s *Service) SessionCookie(token string) *http.Cookie {
	return &http.Cookie{
		Name:     s.cfg.CookieName,
		Value:    token,
		Path:     "/",
		Expires:  time.Now().UTC().Add(s.cfg.SessionTTL),
		MaxAge:   int(s.cfg.SessionTTL.Seconds()),
		HttpOnly: true,
		Secure:   s.cfg.CookieSecure,
		SameSite: http.SameSiteLaxMode,
	}
}

func (s *Service) ClearCookie() *http.Cookie {
	return &http.Cookie{
		Name:     s.cfg.CookieName,
		Value:    "",
		Path:     "/",
		Expires:  time.Unix(0, 0).UTC(),
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   s.cfg.CookieSecure,
		SameSite: http.SameSiteLaxMode,
	}
}

func (s *Service) CookieToken(r *http.Request) string {
	cookie, err := r.Cookie(s.cfg.CookieName)
	if err != nil {
		return ""
	}
	return cookie.Value
}

func (s *Service) userByID(ctx context.Context, userID string) (User, error) {
	var user User
	err := s.db.QueryRowContext(ctx,
		`select id, username, name, is_admin, can_invite from users where id = ? and disabled_at is null`,
		userID,
	).Scan(&user.ID, &user.Username, &user.Name, &user.IsAdmin, &user.CanInvite)
	if err != nil {
		return User{}, fmt.Errorf("select user: %w", err)
	}
	return user, nil
}

func (s *Service) noUsers(ctx context.Context) (bool, error) {
	var count int
	if err := s.db.QueryRowContext(ctx, `select count(*) from users`).Scan(&count); err != nil {
		return false, fmt.Errorf("count users: %w", err)
	}
	return count == 0, nil
}

func normalizeUsername(username string) (string, error) {
	normalized := strings.TrimSpace(username)
	if normalized == "" || len(normalized) > 64 {
		return "", errors.New("invalid_username")
	}
	for _, r := range normalized {
		if r < '!' || r > '~' {
			return "", errors.New("invalid_username")
		}
	}
	return normalized, nil
}

func validateDisplayName(name string) (string, error) {
	normalized := strings.TrimSpace(name)
	if normalized == "" || utf8.RuneCountInString(normalized) > 64 {
		return "", errors.New("invalid_name")
	}
	for _, r := range normalized {
		if r < 0x20 || r == 0x7f {
			return "", errors.New("invalid_name")
		}
	}
	return normalized, nil
}

func normalizeAdminNote(note string) (string, error) {
	normalized := strings.TrimSpace(note)
	if utf8.RuneCountInString(normalized) > 100 {
		return "", errors.New("invalid_note")
	}
	return normalized, nil
}

func validatePassword(password string) error {
	if len(password) < 8 || len(password) > 256 {
		return errors.New("invalid_password")
	}
	return nil
}

func newOpaqueToken() (string, [32]byte, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", [32]byte{}, fmt.Errorf("generate token: %w", err)
	}
	token := base64.RawURLEncoding.EncodeToString(b)
	return token, sha256.Sum256([]byte(token)), nil
}
