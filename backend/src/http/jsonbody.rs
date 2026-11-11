//! Request JSON decoded the way Go's encoding/json fills a struct: only the
//! first value counts (trailing bytes are ignored), `null` leaves a field
//! unset, keys match field names exactly or else case-insensitively, and
//! strict decoding rejects unknown keys.

use bytes::Bytes;
use http_body_util::BodyExt;
use serde_json::{Map, Value};

use super::Req;

/// io.LimitReader(r.Body, 1<<20): longer bodies are cut, not rejected.
pub const MAX_BODY: usize = 1 << 20;

/// Reads at most `MAX_BODY` bytes; a broken body reads as what arrived.
pub async fn read_limited(req: Req) -> Bytes {
    let mut body = req.into_body();
    let mut buf = Vec::new();
    while buf.len() < MAX_BODY {
        let Some(Ok(frame)) = body.frame().await else { break };
        if let Ok(d) = frame.into_data() {
            buf.extend_from_slice(&d);
        }
    }
    buf.truncate(MAX_BODY);
    Bytes::from(buf)
}

/// The body's first JSON value; Ok(None) when it holds none at all (io.EOF).
pub fn first_value(body: &[u8]) -> Result<Option<Value>, Invalid> {
    // Go substitutes U+FFFD for invalid UTF-8 inside strings.
    let text = String::from_utf8_lossy(body);
    match serde_json::Deserializer::from_str(&text).into_iter::<Value>().next() {
        None => Ok(None),
        Some(Ok(v)) => Ok(Some(v)),
        Some(Err(_)) => Err(Invalid),
    }
}

/// Undecodable input: the handler answers 400 invalid_request.
#[derive(Debug, PartialEq, Eq)]
pub struct Invalid;

/// A JSON object being decoded into a struct's fields.
pub struct Object(Map<String, Value>);

impl Object {
    /// `null` decodes as an empty object; any other non-object is a type error.
    pub fn new(v: Value) -> Result<Object, Invalid> {
        match v {
            Value::Object(m) => Ok(Object(m)),
            Value::Null => Ok(Object(Map::new())),
            _ => Err(Invalid),
        }
    }

    /// The value for field `name`, consuming every key that maps to it.
    fn take(&mut self, name: &str) -> Option<Value> {
        let exact = self.0.remove(name);
        let folded: Vec<String> = self.0.keys().filter(|k| k.eq_ignore_ascii_case(name)).cloned().collect();
        let mut fold_value = None;
        for k in folded {
            fold_value = self.0.remove(&k);
        }
        exact.or(fold_value)
    }

    /// Absent or null → None; a non-string is a type error.
    pub fn string(&mut self, name: &str) -> Result<Option<String>, Invalid> {
        match self.take(name) {
            None | Some(Value::Null) => Ok(None),
            Some(Value::String(s)) => Ok(Some(s)),
            Some(_) => Err(Invalid),
        }
    }

    pub fn bool(&mut self, name: &str) -> Result<Option<bool>, Invalid> {
        match self.take(name) {
            None | Some(Value::Null) => Ok(None),
            Some(Value::Bool(b)) => Ok(Some(b)),
            Some(_) => Err(Invalid),
        }
    }

    /// DisallowUnknownFields: every key must have been taken.
    pub fn finish(self) -> Result<(), Invalid> {
        if self.0.is_empty() { Ok(()) } else { Err(Invalid) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn go_struct_semantics() {
        assert_eq!(first_value(b""), Ok(None));
        assert_eq!(first_value(b"  \n"), Ok(None));
        assert!(first_value(b"{\"a\"").is_err());
        assert_eq!(first_value(b"{\"a\":1} trailing junk"), Ok(Some(serde_json::json!({"a": 1}))));

        let mut o = Object::new(first_value(br#"{"Username":"x","password":null}"#).unwrap().unwrap()).unwrap();
        assert_eq!(o.string("username"), Ok(Some("x".into())));
        assert_eq!(o.string("password"), Ok(None));
        assert_eq!(o.finish(), Ok(()));

        let mut o = Object::new(serde_json::json!({"name": 5})).unwrap();
        assert!(o.string("name").is_err());
        let mut o = Object::new(serde_json::json!({"name": "a", "extra": 1})).unwrap();
        assert_eq!(o.string("name"), Ok(Some("a".into())));
        assert!(o.finish().is_err());
        assert!(Object::new(serde_json::json!([])).is_err());
        assert!(Object::new(Value::Null).unwrap().finish().is_ok());
    }
}
