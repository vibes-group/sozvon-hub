package ratelimit

import (
	"testing"
	"time"

	"golang.org/x/time/rate"
)

// clockAt returns a controllable clock starting at a fixed instant, plus an
// advance function — so tests drive time without sleeping.
func clockAt() (now func() time.Time, advance func(time.Duration)) {
	t := time.Unix(1_700_000_000, 0).UTC()
	return func() time.Time { return t }, func(d time.Duration) { t = t.Add(d) }
}

func TestLimiterBurstThenThrottle(t *testing.T) {
	now, advance := clockAt()
	l := New(Config{Rate: rate.Every(time.Second), Burst: 3})
	l.clock = now

	for i := 0; i < 3; i++ {
		if ok, _ := l.Allow("ip"); !ok {
			t.Fatalf("request %d within burst should be allowed", i)
		}
	}
	ok, retry := l.Allow("ip")
	if ok {
		t.Fatal("4th request over burst should be denied")
	}
	if retry <= 0 || retry > time.Second {
		t.Fatalf("retry-after = %v, want (0, 1s]", retry)
	}

	// A different key has its own bucket.
	if ok, _ := l.Allow("other"); !ok {
		t.Fatal("a fresh key should be allowed")
	}

	// After the bucket refills, the throttled key is allowed again.
	advance(time.Second)
	if ok, _ := l.Allow("ip"); !ok {
		t.Fatal("after refill the key should be allowed again")
	}
}

func TestLimiterEvictsOldestAtCap(t *testing.T) {
	now, advance := clockAt()
	l := New(Config{Rate: rate.Every(time.Second), Burst: 1, MaxKeys: 2, TTL: time.Hour})
	l.clock = now

	l.Allow("a")
	advance(time.Minute)
	l.Allow("b")
	advance(time.Minute)
	l.Allow("c") // over cap → evicts the oldest live key ("a")

	l.mu.Lock()
	_, hasA := l.buckets["a"]
	_, hasB := l.buckets["b"]
	_, hasC := l.buckets["c"]
	n := len(l.buckets)
	l.mu.Unlock()
	if n != 2 {
		t.Fatalf("bucket count = %d, want 2", n)
	}
	if hasA {
		t.Fatal("oldest key 'a' should have been evicted")
	}
	if !hasB || !hasC {
		t.Fatal("'b' and 'c' should remain")
	}
}

func TestLockoutThresholdAndBackoff(t *testing.T) {
	now, advance := clockAt()
	l := NewLockout(LockoutConfig{Threshold: 3, BaseDelay: time.Minute, MaxDelay: 10 * time.Minute})
	l.clock = now

	// Under the threshold: no lock yet.
	for i := 0; i < 2; i++ {
		if wait := l.Fail("alice"); wait != 0 {
			t.Fatalf("fail %d should not lock, got %v", i, wait)
		}
		if wait := l.Retry("alice"); wait != 0 {
			t.Fatalf("retry %d should be allowed, got %v", i, wait)
		}
	}
	// Crossing the threshold locks for BaseDelay.
	if wait := l.Fail("alice"); wait != time.Minute {
		t.Fatalf("3rd fail lock = %v, want 1m", wait)
	}
	if wait := l.Retry("alice"); wait <= 0 {
		t.Fatal("should be locked now")
	}

	// While locked, the lock decays with time.
	advance(30 * time.Second)
	if wait := l.Retry("alice"); wait != 30*time.Second {
		t.Fatalf("remaining lock = %v, want 30s", wait)
	}
	// After it lapses, allowed again; the next fail doubles the back-off.
	advance(30 * time.Second)
	if wait := l.Retry("alice"); wait != 0 {
		t.Fatalf("lock should have lapsed, got %v", wait)
	}
	if wait := l.Fail("alice"); wait != 2*time.Minute {
		t.Fatalf("4th fail lock = %v, want 2m (doubled)", wait)
	}
}

func TestLockoutResetClearsFailures(t *testing.T) {
	now, _ := clockAt()
	l := NewLockout(LockoutConfig{Threshold: 2, BaseDelay: time.Minute, MaxDelay: time.Hour})
	l.clock = now

	l.Fail("bob")
	l.Reset("bob") // a successful login clears the count
	if wait := l.Fail("bob"); wait != 0 {
		t.Fatalf("after reset a single fail should not lock, got %v", wait)
	}
}

func TestLockoutBackoffCapped(t *testing.T) {
	now, _ := clockAt()
	l := NewLockout(LockoutConfig{Threshold: 1, BaseDelay: time.Minute, MaxDelay: 4 * time.Minute})
	l.clock = now

	var last time.Duration
	for i := 0; i < 20; i++ {
		last = l.Fail("x")
	}
	if last != 4*time.Minute {
		t.Fatalf("back-off should cap at MaxDelay 4m, got %v", last)
	}
}
