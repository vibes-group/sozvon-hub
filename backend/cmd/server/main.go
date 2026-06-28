package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/pion/webrtc/v4"

	"sozvon-hub/backend/internal/api"
	"sozvon-hub/backend/internal/auth"
	"sozvon-hub/backend/internal/config"
	"sozvon-hub/backend/internal/db"
	"sozvon-hub/backend/internal/rooms"
	turnsrv "sozvon-hub/backend/internal/turn"
	"sozvon-hub/backend/internal/web"
	"sozvon-hub/backend/migrations"
)

func main() {
	cfg := config.Load()
	if err := cfg.Validate(); err != nil {
		log.Fatalf("config: %v", err)
	}
	if cfg.AllowInsecure {
		log.Printf("WARNING: APP_ALLOW_INSECURE=true — insecure dev mode, do not expose publicly")
	}

	ctx := context.Background()

	database, err := db.OpenSQLite(ctx, db.SQLiteConfig{
		Path:       cfg.DBPath,
		Migrations: migrations.FS,
	})
	if err != nil {
		log.Fatalf("db: %v", err)
	}
	defer database.Close()

	dataDir := filepath.Dir(cfg.DBPath)
	turnSecret, err := loadOrCreateSecret(dataDir, "turn.secret", 32)
	if err != nil {
		log.Fatalf("turn secret: %v", err)
	}
	turnSharedSecret := hex.EncodeToString(turnSecret)

	authService := auth.NewService(database, auth.Config{
		CookieSecure: cfg.CookieSecure,
		SessionTTL:   cfg.SessionTTL,
		InviteTTL:    cfg.InviteTTL,
	})

	if cfg.BootstrapInvite {
		invite, err := authService.CreateInvite(ctx, "", false, "")
		if errors.Is(err, auth.ErrForbidden) {
			log.Printf("bootstrap invite skipped: users already exist")
		} else if err != nil {
			log.Fatalf("bootstrap invite: %v", err)
		} else {
			log.Printf("bootstrap invite created; token=%s", invite.Token)
		}
	}

	// Literal IP, not hostname: the hostname may proxy through a CDN that drops
	// UDP. The IP only reaches clients via /api/config.
	var stunURL, turnURL string
	var iceServers []webrtc.ICEServer
	var nat1To1 []string
	if cfg.PublicIP != "" {
		stunURL = fmt.Sprintf("stun:%s:%d", cfg.PublicIP, cfg.TurnPort)
		turnURL = fmt.Sprintf("turn:%s:%d?transport=udp", cfg.PublicIP, cfg.TurnPort)
		iceServers = []webrtc.ICEServer{{URLs: []string{stunURL}}}
		nat1To1 = []string{cfg.PublicIP}
	}

	roomManager := rooms.NewManager(database, rooms.Config{
		ICEServers:    iceServers,
		NAT1To1IPs:    nat1To1,
		UDPPortMin:    cfg.UDPPortMin,
		UDPPortMax:    cfg.UDPPortMax,
		AppHostname:   cfg.AppHostname,
		RoomTTL:       cfg.RoomTTL,
		SweepInterval: time.Minute,
	})
	sweepCtx, sweepCancel := context.WithCancel(ctx)
	defer sweepCancel()
	go roomManager.Run(sweepCtx)

	var turnServer *turnsrv.Server
	if cfg.PublicIP != "" {
		turnServer, err = turnsrv.Start(turnsrv.Config{
			Realm:        cfg.TurnRealm,
			SharedSecret: turnSharedSecret,
			PublicIP:     cfg.PublicIP,
			ListenAddr:   fmt.Sprintf("0.0.0.0:%d", cfg.TurnPort),
			MinRelayPort: cfg.TurnRelayMin,
			MaxRelayPort: cfg.TurnRelayMax,
		})
		if err != nil {
			log.Fatalf("turn init: %v", err)
		}
	} else {
		log.Printf("PUBLIC_IP unset (dev) — TURN server and ICE config disabled")
	}

	mux := api.Routes(api.Deps{
		Auth:             authService,
		Rooms:            roomManager,
		StunURL:          stunURL,
		TurnURL:          turnURL,
		TurnSharedSecret: turnSharedSecret,
	}, web.Handler(cfg.WebDir))

	server := &http.Server{
		Addr:    cfg.Addr,
		Handler: accessLog(mux),
		// ReadTimeout/WriteTimeout intentionally unset: /ws is a long-lived
		// WebSocket and per-request timeouts would terminate it.
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	srvErr := make(chan error, 1)
	go func() {
		log.Printf("listening on %s, serving web from %s", cfg.Addr, cfg.WebDir)
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			srvErr <- err
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)

	select {
	case err := <-srvErr:
		log.Fatalf("http server: %v", err)
	case sig := <-stop:
		log.Printf("shutdown: received %s, draining...", sig)
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := server.Shutdown(shutdownCtx); err != nil {
		log.Printf("shutdown: http: %v", err)
	}
	roomManager.Close()
	if turnServer != nil {
		if err := turnServer.Close(); err != nil {
			log.Printf("shutdown: turn: %v", err)
		}
	}
	log.Printf("shutdown: done")
}

// loadOrCreateSecret reads dataDir/name, creating it with size random bytes on
// first run. Wiping the data dir invalidates all TURN credentials, which is fine.
func loadOrCreateSecret(dataDir, name string, size int) ([]byte, error) {
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return nil, fmt.Errorf("create data dir: %w", err)
	}
	path := filepath.Join(dataDir, name)
	if b, err := os.ReadFile(path); err == nil && len(b) >= size {
		return b, nil
	}
	b := make([]byte, size)
	if _, err := rand.Read(b); err != nil {
		return nil, fmt.Errorf("generate secret: %w", err)
	}
	if err := os.WriteFile(path, b, 0o600); err != nil {
		return nil, fmt.Errorf("write secret %s: %w", name, err)
	}
	return b, nil
}

// accessLog logs one line per request, skipping the WebSocket (hijacks the
// connection) and health probe.
func accessLog(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/healthz" || strings.HasPrefix(r.URL.Path, "/ws/") {
			next.ServeHTTP(w, r)
			return
		}
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rec, r)
		log.Printf("http %s %q %d %s", r.Method, r.URL.Path, rec.status, time.Since(start).Round(time.Millisecond))
	})
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (s *statusRecorder) WriteHeader(code int) {
	s.status = code
	s.ResponseWriter.WriteHeader(code)
}
