//! argon2id in the PHC layout the Go backend stored:
//! `$argon2id$v=19$m=<KiB>,t=<iters>,p=<lanes>$<salt>$<key>` (raw std base64),
//! so existing `users.password_hash` values keep verifying.

use argon2::{Algorithm, Argon2, Params, Version};

use crate::util::{b64_raw_std, b64_raw_std_decode};

#[derive(Clone, Copy, Debug)]
pub struct PasswordParams {
    pub memory_kib: u32,
    pub iterations: u32,
    pub parallelism: u8,
    pub salt_bytes: usize,
    pub key_bytes: usize,
}

impl Default for PasswordParams {
    fn default() -> PasswordParams {
        PasswordParams { memory_kib: 32 * 1024, iterations: 3, parallelism: 1, salt_bytes: 16, key_bytes: 32 }
    }
}

pub fn hash_password(password: &str, p: PasswordParams) -> Result<String, String> {
    let mut salt = vec![0u8; p.salt_bytes];
    getrandom::fill(&mut salt).map_err(|e| format!("generate salt: {e}"))?;
    let key = derive(password.as_bytes(), &salt, p.iterations, p.memory_kib, p.parallelism, p.key_bytes)?;
    Ok(format!("$argon2id$v=19$m={},t={},p={}${}${}", p.memory_kib, p.iterations, p.parallelism, b64_raw_std(&salt), b64_raw_std(&key)))
}

/// Ok(false) on a wrong password; Err on a malformed hash.
pub fn verify_password(password: &str, encoded: &str) -> Result<bool, String> {
    let (p, salt, expected) = decode(encoded)?;
    let actual = derive(password.as_bytes(), &salt, p.iterations, p.memory_kib, p.parallelism, expected.len())?;
    Ok(constant_time_eq(&actual, &expected))
}

fn derive(password: &[u8], salt: &[u8], t: u32, m: u32, p: u8, key_len: usize) -> Result<Vec<u8>, String> {
    let params = Params::new(m, t, u32::from(p), Some(key_len)).map_err(|e| format!("argon2 params: {e}"))?;
    let mut out = vec![0u8; key_len];
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(password, salt, &mut out)
        .map_err(|e| format!("argon2: {e}"))?;
    Ok(out)
}

fn decode(encoded: &str) -> Result<(PasswordParams, Vec<u8>, Vec<u8>), String> {
    let parts: Vec<&str> = encoded.split('$').collect();
    if parts.len() != 6 || parts[1] != "argon2id" || parts[2] != "v=19" {
        return Err("invalid password hash".into());
    }
    let kv: Vec<&str> = parts[3].split(',').collect();
    if kv.len() != 3 {
        return Err("invalid password hash params".into());
    }
    let mut p = PasswordParams { memory_kib: 0, iterations: 0, parallelism: 0, salt_bytes: 0, key_bytes: 0 };
    for part in kv {
        let (k, v) = part.split_once('=').ok_or("invalid password hash param")?;
        // strconv.ParseUint(v, 10, 32): digits only.
        let value: u32 =
            v.bytes().all(|b| b.is_ascii_digit()).then(|| v.parse().ok()).flatten().ok_or("invalid password hash param value")?;
        match k {
            "m" => p.memory_kib = value,
            "t" => p.iterations = value,
            "p" => p.parallelism = u8::try_from(value).map_err(|_| "invalid password hash param value")?,
            _ => return Err("unknown password hash param".into()),
        }
    }
    let salt = b64_raw_std_decode(parts[4]).ok_or("invalid password hash salt")?;
    let key = b64_raw_std_decode(parts[5]).ok_or("invalid password hash value")?;
    Ok((p, salt, key))
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// 8..=256 bytes.
pub fn validate_password(password: &str) -> Result<(), &'static str> {
    if password.len() < 8 || password.len() > 256 { Err("invalid_password") } else { Ok(()) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_verify_round_trip() {
        let encoded = hash_password("correct horse battery staple", PasswordParams::default()).unwrap();
        assert!(encoded.starts_with("$argon2id$v=19$m=32768,t=3,p=1$"), "{encoded}");
        assert_eq!(verify_password("correct horse battery staple", &encoded), Ok(true));
    }

    #[test]
    fn wrong_password_fails() {
        let encoded = hash_password("right-password", PasswordParams::default()).unwrap();
        assert_eq!(verify_password("wrong-password", &encoded), Ok(false));
    }

    #[test]
    fn invalid_encoded_hash() {
        assert!(verify_password("whatever", "not-a-valid-hash").is_err());
        for h in [
            "$argon2id$v=18$m=8,t=1,p=1$c2FsdHNhbHQ$a2V5",
            "$argon2i$v=19$m=8,t=1,p=1$c2FsdHNhbHQ$a2V5",
            "$argon2id$v=19$m=8,t=1$c2FsdHNhbHQ$a2V5",
            "$argon2id$v=19$m=8,t=1,x=1$c2FsdHNhbHQ$a2V5",
            "$argon2id$v=19$m=8,t=1,p=256$c2FsdHNhbHQ$a2V5",
            "$argon2id$v=19$m=8,t=+1,p=1$c2FsdHNhbHQ$a2V5",
            "$argon2id$v=19$m=8,t=1,p=1$!!$a2V5",
        ] {
            assert!(verify_password("x", h).is_err(), "{h}");
        }
    }

    #[test]
    fn validate_password_bounds() {
        assert!(validate_password(&"a".repeat(7)).is_err());
        assert!(validate_password(&"a".repeat(8)).is_ok());
        assert!(validate_password(&"a".repeat(256)).is_ok());
        assert!(validate_password(&"a".repeat(257)).is_err());
        assert!(validate_password("").is_err());
    }

    /// Produced by the Go backend's auth.HashPassword with DefaultPasswordParams.
    const GO_HASH: &str = "$argon2id$v=19$m=32768,t=3,p=1$oHb10+NyyxvJPvyqcSw/2Q$CF0DP/40WcyQ4OTdM+UruAU51qsTvI4XkRVpmW7MATU";

    #[test]
    fn verifies_go_generated_hash() {
        assert_eq!(verify_password("password123", GO_HASH), Ok(true));
        assert_eq!(verify_password("password124", GO_HASH), Ok(false));
    }
}
