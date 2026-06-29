// Package ratelimit provides in-memory, per-key throttles for the HTTP surface:
// a token-bucket Limiter (one bucket per client IP) and a Lockout (a failure
// counter per username). Both are process-local — this app runs as a single
// process (embedded SFU, local SQLite), so nothing needs to be shared across
// instances or survive a restart; counters reset on restart, which is fine for
// throttling. Memory is bounded by evicting idle keys on access (past TTL, or
// the oldest once MaxKeys is reached) rather than by a background sweeper.
package ratelimit

import (
	"sync"
	"time"

	"golang.org/x/time/rate"
)

const (
	defaultTTL     = time.Hour
	defaultMaxKeys = 1 << 16
)

// Config tunes a Limiter. Rate and Burst are the token-bucket parameters; TTL is
// how long an idle key is kept before it may be evicted; MaxKeys caps the number
// of live keys (the oldest is evicted past the cap).
type Config struct {
	Rate    rate.Limit
	Burst   int
	TTL     time.Duration
	MaxKeys int
}

// Limiter is a keyed token bucket: one rate.Limiter per key, created on first
// use and evicted once idle.
type Limiter struct {
	cfg     Config
	mu      sync.Mutex
	buckets map[string]*bucket
	clock   func() time.Time
}

type bucket struct {
	lim      *rate.Limiter
	lastSeen time.Time
}

func New(cfg Config) *Limiter {
	if cfg.TTL <= 0 {
		cfg.TTL = defaultTTL
	}
	if cfg.MaxKeys <= 0 {
		cfg.MaxKeys = defaultMaxKeys
	}
	return &Limiter{cfg: cfg, buckets: make(map[string]*bucket), clock: time.Now}
}

// Allow reports whether an event for key is permitted now. When it is not, the
// second return is how long until a retry would succeed (suitable for a
// Retry-After header).
func (l *Limiter) Allow(key string) (bool, time.Duration) {
	now := l.clock()
	l.mu.Lock()
	b := l.bucketLocked(key, now)
	l.mu.Unlock()

	r := b.lim.ReserveN(now, 1)
	if !r.OK() {
		return false, 0
	}
	if delay := r.DelayFrom(now); delay > 0 {
		r.CancelAt(now)
		return false, delay
	}
	return true, 0
}

func (l *Limiter) bucketLocked(key string, now time.Time) *bucket {
	if b, ok := l.buckets[key]; ok {
		b.lastSeen = now
		return b
	}
	if len(l.buckets) >= l.cfg.MaxKeys {
		evictOldest(l.buckets, func(b *bucket) time.Time { return b.lastSeen }, l.cfg.TTL, now)
	}
	b := &bucket{lim: rate.NewLimiter(l.cfg.Rate, l.cfg.Burst), lastSeen: now}
	l.buckets[key] = b
	return b
}

// evictOldest drops every key idle past ttl and, if that freed nothing, the
// single oldest key — guaranteeing room for one more under the cap. Caller holds
// the lock. seen extracts each entry's last-seen time.
func evictOldest[V any](m map[string]V, seen func(V) time.Time, ttl time.Duration, now time.Time) {
	var oldestKey string
	var oldestSeen time.Time
	freed := false
	for k, v := range m {
		ls := seen(v)
		if now.Sub(ls) > ttl {
			delete(m, k)
			freed = true
			continue
		}
		if oldestKey == "" || ls.Before(oldestSeen) {
			oldestKey, oldestSeen = k, ls
		}
	}
	if !freed && oldestKey != "" {
		delete(m, oldestKey)
	}
}

// LockoutConfig tunes a Lockout. After Threshold consecutive failures a key is
// locked for a delay that doubles from BaseDelay up to MaxDelay; TTL/MaxKeys
// bound memory as in Config.
type LockoutConfig struct {
	Threshold int
	BaseDelay time.Duration
	MaxDelay  time.Duration
	TTL       time.Duration
	MaxKeys   int
}

// Lockout tracks consecutive failures per key (a username) and blocks a key once
// it crosses the threshold, with an exponential back-off. A success Resets the
// key. It guards a single account against distributed credential stuffing that a
// per-IP Limiter alone would miss.
type Lockout struct {
	cfg     LockoutConfig
	mu      sync.Mutex
	entries map[string]*failure
	clock   func() time.Time
}

type failure struct {
	fails       int
	lockedUntil time.Time
	lastSeen    time.Time
}

func NewLockout(cfg LockoutConfig) *Lockout {
	if cfg.TTL <= 0 {
		cfg.TTL = defaultTTL
	}
	if cfg.MaxKeys <= 0 {
		cfg.MaxKeys = defaultMaxKeys
	}
	return &Lockout{cfg: cfg, entries: make(map[string]*failure), clock: time.Now}
}

// Retry returns how long key is locked for, or 0 if an attempt is allowed now.
func (l *Lockout) Retry(key string) time.Duration {
	now := l.clock()
	l.mu.Lock()
	defer l.mu.Unlock()
	e, ok := l.entries[key]
	if !ok {
		return 0
	}
	e.lastSeen = now
	if now.Before(e.lockedUntil) {
		return e.lockedUntil.Sub(now)
	}
	return 0
}

// Fail records one failure for key and returns the resulting lock duration (0
// while still under the threshold).
func (l *Lockout) Fail(key string) time.Duration {
	now := l.clock()
	l.mu.Lock()
	defer l.mu.Unlock()
	e, ok := l.entries[key]
	if !ok {
		if len(l.entries) >= l.cfg.MaxKeys {
			evictOldest(l.entries, func(e *failure) time.Time { return e.lastSeen }, l.cfg.TTL, now)
		}
		e = &failure{}
		l.entries[key] = e
	}
	e.fails++
	e.lastSeen = now
	if e.fails >= l.cfg.Threshold {
		e.lockedUntil = now.Add(l.lockDuration(e.fails))
		return e.lockedUntil.Sub(now)
	}
	return 0
}

// Reset clears any failure record for key, called after a successful auth.
func (l *Lockout) Reset(key string) {
	l.mu.Lock()
	delete(l.entries, key)
	l.mu.Unlock()
}

// lockDuration doubles BaseDelay once per failure past the threshold, capped at
// MaxDelay. The loop halts as soon as the cap is reached, so it never overflows.
func (l *Lockout) lockDuration(fails int) time.Duration {
	d := l.cfg.BaseDelay
	for i := 0; i < fails-l.cfg.Threshold && d < l.cfg.MaxDelay; i++ {
		d *= 2
	}
	if d > l.cfg.MaxDelay {
		d = l.cfg.MaxDelay
	}
	return d
}
