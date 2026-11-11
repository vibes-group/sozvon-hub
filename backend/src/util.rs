//! Small helpers shared across modules: logging, randomness, encodings, time.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64ct::Encoding;
use time::OffsetDateTime;

/// `log!` prints one line to stderr in Go's default log layout
/// (`2006/01/02 15:04:05 message`), so logs read the same as before the port.
#[macro_export]
macro_rules! log {
    ($($arg:tt)*) => {
        $crate::util::log_line(format_args!($($arg)*))
    };
}

pub fn log_line(args: std::fmt::Arguments<'_>) {
    let now = OffsetDateTime::now_utc();
    eprintln!(
        "{:04}/{:02}/{:02} {:02}:{:02}:{:02} {}",
        now.year(),
        u8::from(now.month()),
        now.day(),
        now.hour(),
        now.minute(),
        now.second(),
        args
    );
}

pub fn random_bytes<const N: usize>() -> [u8; N] {
    let mut buf = [0u8; N];
    getrandom::fill(&mut buf).expect("OS random source");
    buf
}

pub fn random_u32() -> u32 {
    u32::from_le_bytes(random_bytes::<4>())
}

pub fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(DIGITS[(b >> 4) as usize] as char);
        out.push(DIGITS[(b & 0xf) as usize] as char);
    }
    out
}

pub fn b64_std(bytes: &[u8]) -> String {
    base64ct::Base64::encode_string(bytes)
}

pub fn b64_raw_std(bytes: &[u8]) -> String {
    base64ct::Base64Unpadded::encode_string(bytes)
}

pub fn b64_raw_std_decode(s: &str) -> Option<Vec<u8>> {
    base64ct::Base64Unpadded::decode_vec(s).ok()
}

pub fn b64_raw_url(bytes: &[u8]) -> String {
    base64ct::Base64UrlUnpadded::encode_string(bytes)
}

/// ULID (https://github.com/ulid/spec): 48-bit millisecond timestamp plus 80
/// random bits, Crockford base32. Lexicographically sortable by creation time.
pub fn ulid(at: SystemTime) -> String {
    const ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    let ms = at.duration_since(UNIX_EPOCH).unwrap_or_default().as_millis();
    let rand = random_bytes::<10>();
    let mut v: u128 = ms & ((1 << 48) - 1);
    for b in rand {
        v = (v << 8) | b as u128;
    }
    let mut out = [0u8; 26];
    for i in (0..26).rev() {
        out[i] = ALPHABET[(v & 0x1f) as usize];
        v >>= 5;
    }
    String::from_utf8(out.to_vec()).expect("ascii")
}

/// Random (version 4) UUID in the canonical lowercase hyphenated form, like
/// Go's uuid.NewString.
pub fn uuid_v4() -> String {
    let mut b = random_bytes::<16>();
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h = hex(&b);
    format!("{}-{}-{}-{}-{}", &h[..8], &h[8..12], &h[12..16], &h[16..20], &h[20..])
}

pub fn unix_millis(t: SystemTime) -> i64 {
    t.duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as i64
}

pub fn unix_secs(t: SystemTime) -> i64 {
    t.duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() as i64
}

pub fn ceil_secs(d: Duration) -> u64 {
    d.as_secs() + u64::from(d.subsec_nanos() > 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ulid_shape_and_order() {
        let a = ulid(UNIX_EPOCH + Duration::from_millis(1));
        let b = ulid(UNIX_EPOCH + Duration::from_millis(2));
        assert_eq!(a.len(), 26);
        assert!(a < b);
    }

    #[test]
    fn uuid_shape() {
        let u = uuid_v4();
        assert_eq!(u.len(), 36);
        assert_eq!(&u[14..15], "4");
        assert!(matches!(&u[19..20], "8" | "9" | "a" | "b"));
        assert_eq!(u.matches('-').count(), 4);
        assert_ne!(u, uuid_v4());
    }
}
