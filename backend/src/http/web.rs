//! The SPA: static assets from the web dir, index.html for unknown paths so
//! deep links like /r/<slug> resolve. /assets and /vendor are pure build
//! output and 404 instead of falling back. Mirrors Go's FileServer/ServeFile
//! redirects and Content-Type rules.

use std::io::Read;
use std::path::Path;

use http::{HeaderValue, Method, StatusCode, header};

use super::sniff::{SNIFF_LEN, detect_content_type};
use super::{Req, Resp, clean_path, local_redirect, not_found, percent_decode};

pub async fn serve(web_dir: &Path, req: Req) -> Resp {
    let raw = req.uri().path();
    let path = percent_decode(raw).map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap_or_else(|| raw.to_string());
    // filepath.Clean: confined to the web dir, no trailing slash.
    let cleaned = clean_path(&path);
    let clean = cleaned.strip_suffix('/').filter(|c| !c.is_empty()).unwrap_or(&cleaned);
    let file = web_dir.join(clean.trim_start_matches('/'));
    if clean != "/" && std::fs::metadata(&file).is_ok_and(|m| m.is_file()) {
        if path.ends_with("/index.html") {
            return local_redirect(req.uri(), "./");
        }
        if path.ends_with('/') {
            let base = path.trim_end_matches('/').rsplit('/').next().unwrap_or("");
            return local_redirect(req.uri(), &format!("../{base}"));
        }
        return serve_file(&file, req).await;
    }
    if clean.starts_with("/assets/") || clean.starts_with("/vendor/") {
        return not_found();
    }
    if path.ends_with("/index.html") {
        return local_redirect(req.uri(), "./");
    }
    serve_file(&web_dir.join("index.html"), req).await
}

/// Like http.ServeFile for any method: Range and conditional requests, a
/// Content-Type from Go's extension table or else sniffed from the content.
async fn serve_file(path: &Path, req: Req) -> Resp {
    let ct = content_type(path);
    let (mut parts, body) = req.into_parts();
    if parts.method != Method::HEAD {
        parts.method = Method::GET;
    }
    let mut r = super::serve_fs(tower_http::services::ServeFile::new(path), Req::from_parts(parts, body)).await;
    match r.status() {
        StatusCode::OK | StatusCode::PARTIAL_CONTENT => {
            if let Some(ct) = ct.and_then(|ct| HeaderValue::from_str(&ct).ok()) {
                r.headers_mut().insert(header::CONTENT_TYPE, ct);
            }
        }
        StatusCode::NOT_MODIFIED => {
            r.headers_mut().remove(header::CONTENT_TYPE);
        }
        _ => {}
    }
    r
}

fn content_type(path: &Path) -> Option<String> {
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    if let Some(ct) = go_mime(&ext) {
        return Some(ct.to_string());
    }
    let mut head = Vec::with_capacity(SNIFF_LEN);
    std::fs::File::open(path).ok()?.take(SNIFF_LEN as u64).read_to_end(&mut head).ok()?;
    Some(detect_content_type(&head).to_string())
}

/// Go's builtin mime table (the runtime image ships no /etc/mime.types).
fn go_mime(ext: &str) -> Option<&'static str> {
    Some(match ext {
        "avif" => "image/avif",
        "css" => "text/css; charset=utf-8",
        "gif" => "image/gif",
        "htm" | "html" => "text/html; charset=utf-8",
        "jpeg" | "jpg" => "image/jpeg",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "json" => "application/json",
        "pdf" => "application/pdf",
        "png" => "image/png",
        "svg" => "image/svg+xml",
        "wasm" => "application/wasm",
        "webp" => "image/webp",
        "xml" => "text/xml; charset=utf-8",
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn types() {
        assert_eq!(go_mime("js"), Some("text/javascript; charset=utf-8"));
        assert_eq!(go_mime("ico"), None);
    }
}
