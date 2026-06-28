// Package api wires the sozvon-hub REST + WebSocket HTTP surface: auth, invites,
// dynamic rooms, ICE config, and the call signaling WebSocket.
package api

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"strings"
	"time"

	"sozvon-hub/backend/internal/auth"
	"sozvon-hub/backend/internal/rooms"
	turnsrv "sozvon-hub/backend/internal/turn"
)

// turnCredsTTL is long enough to cover a typical call and brief reconnects, short
// enough to limit exposure if a credential leaks.
const turnCredsTTL = 6 * time.Hour

// Deps bundles everything the handlers need.
type Deps struct {
	Auth             *auth.Service
	Rooms            *rooms.Manager
	StunURL          string
	TurnURL          string
	TurnSharedSecret string
}

// Routes registers every HTTP route on a fresh mux and returns it.
func Routes(d Deps, webHandler http.Handler) *http.ServeMux {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		_, _ = w.Write([]byte("ok"))
	})

	mux.HandleFunc("GET /api/auth/me", d.authMe)
	mux.HandleFunc("POST /api/auth/register", d.authRegister)
	mux.HandleFunc("POST /api/auth/login", d.authLogin)
	mux.HandleFunc("POST /api/auth/logout", d.authLogout)
	mux.HandleFunc("PATCH /api/account", d.accountUpdate)

	mux.HandleFunc("POST /api/invites", d.inviteCreate)
	mux.HandleFunc("GET /api/invites", d.invitesList)
	mux.HandleFunc("DELETE /api/invites/{id}", d.inviteDelete)

	mux.HandleFunc("POST /api/rooms", d.roomCreate)
	mux.HandleFunc("GET /api/rooms/{slug}", d.roomGet)
	mux.HandleFunc("GET /api/config", d.config)

	mux.HandleFunc("GET /ws/{slug}", d.serveWS)

	mux.Handle("/", webHandler)
	return mux
}

// --- Auth ---

type registerRequest struct {
	InviteToken string `json:"inviteToken"`
	Username    string `json:"username"`
	Password    string `json:"password"`
}

type loginRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

func (d Deps) authMe(w http.ResponseWriter, r *http.Request) {
	user, err := d.Auth.CurrentUser(r.Context(), d.Auth.CookieToken(r))
	if err != nil {
		writeAuthError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, auth.SessionResponse{User: user})
}

func (d Deps) authRegister(w http.ResponseWriter, r *http.Request) {
	var body registerRequest
	if !readJSON(w, r, &body) {
		return
	}
	token, user, err := d.Auth.RegisterWithInvite(withSessionMeta(r), body.InviteToken, body.Username, body.Password)
	if err != nil {
		writeAuthError(w, err)
		return
	}
	http.SetCookie(w, d.Auth.SessionCookie(token))
	writeJSON(w, http.StatusCreated, auth.SessionResponse{User: user})
}

func (d Deps) authLogin(w http.ResponseWriter, r *http.Request) {
	var body loginRequest
	if !readJSON(w, r, &body) {
		return
	}
	token, user, err := d.Auth.Login(withSessionMeta(r), body.Username, body.Password)
	if err != nil {
		writeAuthError(w, err)
		return
	}
	http.SetCookie(w, d.Auth.SessionCookie(token))
	writeJSON(w, http.StatusOK, auth.SessionResponse{User: user})
}

func (d Deps) authLogout(w http.ResponseWriter, r *http.Request) {
	if err := d.Auth.Logout(r.Context(), d.Auth.CookieToken(r)); err != nil {
		log.Printf("auth logout: %v", err)
		writeJSON(w, http.StatusInternalServerError, errorResponse{Error: "internal_error"})
		return
	}
	http.SetCookie(w, d.Auth.ClearCookie())
	w.WriteHeader(http.StatusNoContent)
}

type accountUpdateRequest struct {
	Username *string `json:"username"`
	Name     *string `json:"name"`
}

func (d Deps) accountUpdate(w http.ResponseWriter, r *http.Request) {
	user, err := d.Auth.CurrentUser(r.Context(), d.Auth.CookieToken(r))
	if err != nil {
		writeAuthError(w, err)
		return
	}
	var body accountUpdateRequest
	if !readJSON(w, r, &body) {
		return
	}
	updated, err := d.Auth.UpdateAccount(r.Context(), user.ID, body.Username, body.Name)
	if err != nil {
		writeAuthError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, auth.SessionResponse{User: updated})
}

// --- Invites ---

func (d Deps) inviteCreate(w http.ResponseWriter, r *http.Request) {
	user, err := d.Auth.CurrentUser(r.Context(), d.Auth.CookieToken(r))
	if err != nil {
		writeAuthError(w, err)
		return
	}
	invite, err := d.Auth.CreateInvite(r.Context(), user.ID)
	if err != nil {
		writeAuthError(w, err)
		return
	}
	invite.URL = "/?invite=" + invite.Token
	writeJSON(w, http.StatusCreated, map[string]any{"invite": invite})
}

func (d Deps) invitesList(w http.ResponseWriter, r *http.Request) {
	user, err := d.Auth.CurrentUser(r.Context(), d.Auth.CookieToken(r))
	if err != nil {
		writeAuthError(w, err)
		return
	}
	invites, err := d.Auth.ListActiveInvites(r.Context(), user.ID)
	if err != nil {
		writeAuthError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"invites": invites})
}

func (d Deps) inviteDelete(w http.ResponseWriter, r *http.Request) {
	user, err := d.Auth.CurrentUser(r.Context(), d.Auth.CookieToken(r))
	if err != nil {
		writeAuthError(w, err)
		return
	}
	if err := d.Auth.DeleteInvite(r.Context(), user.ID, r.PathValue("id")); err != nil {
		writeAuthError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// --- Rooms ---

func (d Deps) roomCreate(w http.ResponseWriter, r *http.Request) {
	user, err := d.Auth.CurrentUser(r.Context(), d.Auth.CookieToken(r))
	if err != nil {
		writeAuthError(w, err)
		return
	}
	room, err := d.Rooms.Create(r.Context(), user.ID)
	if err != nil {
		log.Printf("rooms create: %v", err)
		writeJSON(w, http.StatusInternalServerError, errorResponse{Error: "internal_error"})
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"room": room})
}

func (d Deps) roomGet(w http.ResponseWriter, r *http.Request) {
	slug := r.PathValue("slug")
	joinable, err := d.Rooms.Joinable(r.Context(), slug)
	if errors.Is(err, rooms.ErrRoomNotFound) {
		writeJSON(w, http.StatusNotFound, errorResponse{Error: "room_not_found"})
		return
	}
	if err != nil {
		log.Printf("rooms get: %v", err)
		writeJSON(w, http.StatusInternalServerError, errorResponse{Error: "internal_error"})
		return
	}
	if !joinable {
		// Expired or ended links 404 too: an unjoinable link is indistinguishable
		// from a missing one to a would-be guest.
		writeJSON(w, http.StatusNotFound, errorResponse{Error: "room_not_found"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"room": map[string]any{"slug": slug, "joinable": true}})
}

// --- ICE config ---

type iceServer struct {
	URLs       []string `json:"urls"`
	Username   string   `json:"username,omitempty"`
	Credential string   `json:"credential,omitempty"`
}

type iceConfigResponse struct {
	ICEServers []iceServer `json:"iceServers"`
}

// config returns STUN + short-lived TURN credentials. No auth: guests joining a
// room by link need ICE config too, and the slug is the access control.
func (d Deps) config(w http.ResponseWriter, r *http.Request) {
	servers := []iceServer{}
	if d.StunURL != "" {
		servers = append(servers, iceServer{URLs: []string{d.StunURL}})
	}
	if d.TurnURL != "" && d.TurnSharedSecret != "" {
		username, credential := turnsrv.GenerateCredentials(d.TurnSharedSecret, "guest", turnCredsTTL)
		servers = append(servers, iceServer{
			URLs:       []string{d.TurnURL},
			Username:   username,
			Credential: credential,
		})
	}
	writeJSON(w, http.StatusOK, iceConfigResponse{ICEServers: servers})
}

// --- WebSocket ---

// serveWS hands the connection to the room manager, which rejects non-joinable
// rooms. No account is required — the unguessable slug is the access control.
func (d Deps) serveWS(w http.ResponseWriter, r *http.Request) {
	d.Rooms.ServeWS(w, r, r.PathValue("slug"))
}

// --- Helpers ---

type errorResponse struct {
	Error string `json:"error"`
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(body); err != nil {
		log.Printf("http: encode response: %v", err)
	}
}

func readJSON(w http.ResponseWriter, r *http.Request, dst any) bool {
	defer r.Body.Close()
	dec := json.NewDecoder(io.LimitReader(r.Body, 1<<20))
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse{Error: "invalid_request"})
		return false
	}
	return true
}

func writeAuthError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, auth.ErrNotAuthenticated):
		writeJSON(w, http.StatusUnauthorized, errorResponse{Error: "not_authenticated"})
	case errors.Is(err, auth.ErrInvalidCredentials):
		writeJSON(w, http.StatusUnauthorized, errorResponse{Error: "invalid_credentials"})
	case errors.Is(err, auth.ErrUsernameTaken):
		writeJSON(w, http.StatusConflict, errorResponse{Error: "username_taken"})
	case errors.Is(err, auth.ErrInviteRequired):
		writeJSON(w, http.StatusBadRequest, errorResponse{Error: "invite_required"})
	case errors.Is(err, auth.ErrInvalidInvite):
		writeJSON(w, http.StatusForbidden, errorResponse{Error: "invalid_invite"})
	case errors.Is(err, auth.ErrForbidden):
		writeJSON(w, http.StatusForbidden, errorResponse{Error: "forbidden"})
	case err != nil && (err.Error() == "invalid_username" || err.Error() == "invalid_password" || err.Error() == "invalid_name"):
		writeJSON(w, http.StatusBadRequest, errorResponse{Error: err.Error()})
	default:
		log.Printf("auth: %v", err)
		writeJSON(w, http.StatusInternalServerError, errorResponse{Error: "internal_error"})
	}
}

func withSessionMeta(r *http.Request) context.Context {
	userAgent := r.UserAgent()
	if len(userAgent) > 256 {
		userAgent = userAgent[:256]
	}
	ipHash := sha256.Sum256([]byte(clientIP(r)))
	return auth.WithSessionMeta(r.Context(), auth.SessionMeta{UserAgent: userAgent, IPHash: ipHash[:]})
}

// clientIP trusts X-Forwarded-For: the backend binds loopback behind the proxy.
func clientIP(r *http.Request) string {
	if forwarded := r.Header.Get("X-Forwarded-For"); forwarded != "" {
		if comma := strings.IndexByte(forwarded, ','); comma >= 0 {
			return strings.TrimSpace(forwarded[:comma])
		}
		return strings.TrimSpace(forwarded)
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
