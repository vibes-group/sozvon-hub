//! In-memory per-key throttles: a token bucket per client IP (`Limiter`) and a
//! failure counter per username (`Lockout`). Process-local: counters reset on
//! restart, which is fine for throttling. Memory is bounded by evicting idle
//! keys on access instead of a background sweeper.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

const DEFAULT_TTL: Duration = Duration::from_secs(3600);
const DEFAULT_MAX_KEYS: usize = 1 << 16;

pub struct Config {
    /// Tokens per second.
    pub rate: f64,
    pub burst: f64,
    pub ttl: Duration,
    pub max_keys: usize,
}

impl Config {
    pub fn new(rate: f64, burst: u32) -> Config {
        Config { rate, burst: burst as f64, ttl: DEFAULT_TTL, max_keys: DEFAULT_MAX_KEYS }
    }
}

pub struct Limiter {
    cfg: Config,
    buckets: Mutex<HashMap<String, Bucket>>,
}

struct Bucket {
    tokens: f64,
    last: Instant,
}

impl Limiter {
    pub fn new(cfg: Config) -> Limiter {
        Limiter { cfg, buckets: Mutex::new(HashMap::new()) }
    }

    /// Whether an event for `key` is allowed now; when not, how long until a
    /// retry would succeed (for Retry-After).
    pub fn allow(&self, key: &str) -> Result<(), Duration> {
        self.allow_at(key, Instant::now())
    }

    fn allow_at(&self, key: &str, now: Instant) -> Result<(), Duration> {
        let mut buckets = self.buckets.lock().unwrap();
        if !buckets.contains_key(key) && buckets.len() >= self.cfg.max_keys {
            evict(&mut buckets, |b: &Bucket| b.last, self.cfg.ttl, now);
        }
        let b = buckets.entry(key.to_string()).or_insert(Bucket { tokens: self.cfg.burst, last: now });
        let elapsed = now.saturating_duration_since(b.last).as_secs_f64();
        b.tokens = (b.tokens + elapsed * self.cfg.rate).min(self.cfg.burst);
        b.last = now;
        if b.tokens >= 1.0 {
            b.tokens -= 1.0;
            return Ok(());
        }
        if self.cfg.rate <= 0.0 {
            return Err(Duration::ZERO);
        }
        Err(Duration::from_secs_f64((1.0 - b.tokens) / self.cfg.rate))
    }
}

/// Drops every key idle past `ttl`; if that freed nothing, drops the single
/// oldest one so there is room for one more under the cap.
fn evict<V>(m: &mut HashMap<String, V>, seen: impl Fn(&V) -> Instant, ttl: Duration, now: Instant) {
    let before = m.len();
    m.retain(|_, v| now.saturating_duration_since(seen(v)) <= ttl);
    if m.len() < before {
        return;
    }
    if let Some(oldest) = m.iter().min_by_key(|(_, v)| seen(v)).map(|(k, _)| k.clone()) {
        m.remove(&oldest);
    }
}

pub struct LockoutConfig {
    pub threshold: u32,
    pub base_delay: Duration,
    pub max_delay: Duration,
    pub ttl: Duration,
    pub max_keys: usize,
}

impl LockoutConfig {
    pub fn new(threshold: u32, base_delay: Duration, max_delay: Duration) -> LockoutConfig {
        LockoutConfig { threshold, base_delay, max_delay, ttl: DEFAULT_TTL, max_keys: DEFAULT_MAX_KEYS }
    }
}

/// Consecutive failures per key (a username). Past the threshold the key is
/// locked for a delay doubling from `base_delay` up to `max_delay`; a success
/// resets it. Guards one account against distributed credential stuffing that
/// the per-IP limiter alone would miss.
pub struct Lockout {
    cfg: LockoutConfig,
    entries: Mutex<HashMap<String, Failure>>,
}

struct Failure {
    fails: u32,
    locked_until: Option<Instant>,
    last_seen: Instant,
}

impl Lockout {
    pub fn new(cfg: LockoutConfig) -> Lockout {
        Lockout { cfg, entries: Mutex::new(HashMap::new()) }
    }

    /// How long `key` is locked for; zero if an attempt is allowed now.
    pub fn retry(&self, key: &str) -> Duration {
        self.retry_at(key, Instant::now())
    }

    /// Records one failure; returns the resulting lock (zero under the threshold).
    pub fn fail(&self, key: &str) -> Duration {
        self.fail_at(key, Instant::now())
    }

    pub fn reset(&self, key: &str) {
        self.entries.lock().unwrap().remove(key);
    }

    fn retry_at(&self, key: &str, now: Instant) -> Duration {
        let mut entries = self.entries.lock().unwrap();
        let Some(e) = entries.get_mut(key) else {
            return Duration::ZERO;
        };
        e.last_seen = now;
        e.locked_until.map(|until| until.saturating_duration_since(now)).unwrap_or_default()
    }

    fn fail_at(&self, key: &str, now: Instant) -> Duration {
        let mut entries = self.entries.lock().unwrap();
        if !entries.contains_key(key) && entries.len() >= self.cfg.max_keys {
            evict(&mut entries, |f: &Failure| f.last_seen, self.cfg.ttl, now);
        }
        let e = entries.entry(key.to_string()).or_insert(Failure { fails: 0, locked_until: None, last_seen: now });
        e.fails += 1;
        e.last_seen = now;
        if e.fails < self.cfg.threshold {
            return Duration::ZERO;
        }
        let d = self.lock_duration(e.fails);
        e.locked_until = Some(now + d);
        d
    }

    /// Doubles `base_delay` once per failure past the threshold, capped.
    fn lock_duration(&self, fails: u32) -> Duration {
        let mut d = self.cfg.base_delay;
        for _ in 0..fails - self.cfg.threshold {
            if d >= self.cfg.max_delay {
                break;
            }
            d *= 2;
        }
        d.min(self.cfg.max_delay)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIN: Duration = Duration::from_secs(60);

    #[test]
    fn limiter_burst_then_throttle() {
        let l = Limiter::new(Config::new(1.0, 3));
        let t0 = Instant::now();
        for i in 0..3 {
            assert!(l.allow_at("ip", t0).is_ok(), "request {i} within burst");
        }
        let retry = l.allow_at("ip", t0).unwrap_err();
        assert!(retry > Duration::ZERO && retry <= Duration::from_secs(1), "retry-after = {retry:?}");
        assert!(l.allow_at("other", t0).is_ok(), "a fresh key has its own bucket");
        assert!(l.allow_at("ip", t0 + Duration::from_secs(1)).is_ok(), "refilled");
    }

    #[test]
    fn limiter_evicts_oldest_at_cap() {
        let l = Limiter::new(Config { max_keys: 2, ttl: Duration::from_secs(3600), ..Config::new(1.0, 1) });
        let t0 = Instant::now();
        let _ = l.allow_at("a", t0);
        let _ = l.allow_at("b", t0 + MIN);
        let _ = l.allow_at("c", t0 + 2 * MIN);
        let m = l.buckets.lock().unwrap();
        assert_eq!(m.len(), 2);
        assert!(!m.contains_key("a"));
        assert!(m.contains_key("b") && m.contains_key("c"));
    }

    #[test]
    fn lockout_threshold_and_backoff() {
        let l = Lockout::new(LockoutConfig::new(3, MIN, 10 * MIN));
        let t0 = Instant::now();
        for i in 0..2 {
            assert_eq!(l.fail_at("alice", t0), Duration::ZERO, "fail {i}");
            assert_eq!(l.retry_at("alice", t0), Duration::ZERO, "retry {i}");
        }
        assert_eq!(l.fail_at("alice", t0), MIN);
        assert!(l.retry_at("alice", t0) > Duration::ZERO);
        assert_eq!(l.retry_at("alice", t0 + MIN / 2), MIN / 2);
        assert_eq!(l.retry_at("alice", t0 + MIN), Duration::ZERO);
        assert_eq!(l.fail_at("alice", t0 + MIN), 2 * MIN, "doubled");
    }

    #[test]
    fn lockout_reset_clears_failures() {
        let l = Lockout::new(LockoutConfig::new(2, MIN, 60 * MIN));
        l.fail("bob");
        l.reset("bob");
        assert_eq!(l.fail("bob"), Duration::ZERO);
    }

    #[test]
    fn lockout_backoff_capped() {
        let l = Lockout::new(LockoutConfig::new(1, MIN, 4 * MIN));
        let t0 = Instant::now();
        let last = (0..20).map(|_| l.fail_at("x", t0)).last().unwrap();
        assert_eq!(last, 4 * MIN);
    }

    #[test]
    fn lockout_evicts_at_cap() {
        let l = Lockout::new(LockoutConfig { max_keys: 2, ..LockoutConfig::new(5, MIN, MIN) });
        let t0 = Instant::now();
        l.fail_at("a", t0);
        l.fail_at("b", t0 + MIN);
        l.fail_at("c", t0 + 2 * MIN);
        let m = l.entries.lock().unwrap();
        assert!(!m.contains_key("a") && m.len() == 2);
    }
}
