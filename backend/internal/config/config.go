package config

import (
	"errors"
	"log"
	"os"
	"strconv"
	"time"
)

type Config struct {
	Addr          string
	WebDir        string
	AppHostname   string
	PublicIP      string
	TurnRealm     string
	CookieSecure  bool
	AllowInsecure bool

	DBPath          string
	BootstrapInvite bool

	SessionTTL time.Duration
	InviteTTL  time.Duration
	RoomTTL    time.Duration
	RoomGrace  time.Duration

	TurnPort     uint16
	UDPPortMin   uint16
	UDPPortMax   uint16
	TurnRelayMin uint16
	TurnRelayMax uint16
}

// Tuning values that are never overridden per-deploy are constants, not env
// knobs — fewer moving parts than envs nobody sets.
const (
	sessionTTL = 720 * time.Hour // 30 days
	inviteTTL  = 168 * time.Hour // 7 days
	roomTTL    = 24 * time.Hour
	roomGrace  = 5 * time.Minute
)

func Load() Config {
	hostname := env("APP_HOSTNAME", "localhost")
	return Config{
		Addr:          env("APP_ADDR", ":8080"),
		WebDir:        env("APP_WEB_DIR", "./web"),
		AppHostname:   hostname,
		PublicIP:      os.Getenv("PUBLIC_IP"),
		TurnRealm:     hostname,
		CookieSecure:  envBool("APP_COOKIE_SECURE", true),
		AllowInsecure: envBool("APP_ALLOW_INSECURE", false),

		DBPath:          env("APP_DB_PATH", "./data/sozvon-hub.db"),
		BootstrapInvite: envBool("APP_BOOTSTRAP_INVITE", false),

		SessionTTL: sessionTTL,
		InviteTTL:  inviteTTL,
		RoomTTL:    roomTTL,
		RoomGrace:  roomGrace,

		TurnPort:     envUint16("TURN_PORT", 3478),
		UDPPortMin:   envUint16("UDP_PORT_MIN", 10101),
		UDPPortMax:   envUint16("UDP_PORT_MAX", 10200),
		TurnRelayMin: envUint16("TURN_RELAY_PORT_MIN", 49160),
		TurnRelayMax: envUint16("TURN_RELAY_PORT_MAX", 49199),
	}
}

// Validate refuses combinations that are only acceptable in local dev. In
// production (AllowInsecure=false) PUBLIC_IP is required for SFU NAT mapping and
// TURN relay, and a non-secure session cookie is rejected.
func (c Config) Validate() error {
	if !c.CookieSecure && !c.AllowInsecure {
		return errors.New("APP_COOKIE_SECURE=false requires APP_ALLOW_INSECURE=true")
	}
	if c.PublicIP == "" && !c.AllowInsecure {
		return errors.New("PUBLIC_IP must be set (used by SFU NAT mapping and TURN relay address)")
	}
	return nil
}

func env(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func envBool(key string, fallback bool) bool {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}
	parsed, err := strconv.ParseBool(value)
	if err != nil {
		log.Printf("config: bad %s=%q (%v), using default %v", key, value, err, fallback)
		return fallback
	}
	return parsed
}

func envUint16(key string, fallback uint16) uint16 {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}
	parsed, err := strconv.ParseUint(value, 10, 16)
	if err != nil {
		log.Printf("config: bad %s=%q (%v), using default %d", key, value, err, fallback)
		return fallback
	}
	return uint16(parsed)
}
