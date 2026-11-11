//! Synthetic WebRTC participant for integration tests and load runs. It
//! speaks the signaling protocol like the browser client, negotiates with
//! str0m, sends RTP stamped with a probe (publisher, sequence, send time) and
//! measures what arrives. Server-agnostic: works against any implementation
//! of the protocol.

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use http_body_util::{BodyExt, Full};
use str0m::change::{SdpAnswer, SdpOffer, SdpPendingOffer};
use str0m::media::{Direction, MediaKind, Mid, Pt};
use str0m::rtp::{RtpWrite, SeqNo};
use str0m::{Candidate, Event};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_util::sync::CancellationToken;

use crate::sfu::net::{Mux, Pc, PcHandler};
use crate::sfu::rtc;

const PROBE_MAGIC: &[u8; 4] = b"SZLT";
const PROBE_LEN: usize = 20;
/// Our synthetic VP9 payload descriptor: I(15-bit id), L, non-flexible.
const VP9_DESC_LEN: usize = 5;
/// Our synthetic VP8 payload descriptor: X, I with a 15-bit picture ID.
const VP8_DESC_LEN: usize = 4;
const VIDEO_MTU_PAYLOAD: usize = 1100;

fn now_ns() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos() as u64
}

fn probe(buf: &mut [u8], publisher: u32, seq: u32) {
    buf[..4].copy_from_slice(PROBE_MAGIC);
    buf[4..8].copy_from_slice(&publisher.to_be_bytes());
    buf[8..12].copy_from_slice(&seq.to_be_bytes());
    buf[12..20].copy_from_slice(&now_ns().to_be_bytes());
}

fn parse_probe(b: &[u8]) -> Option<(u32, u32, u64)> {
    if b.len() < PROBE_LEN || &b[..4] != PROBE_MAGIC {
        return None;
    }
    Some((
        u32::from_be_bytes(b[4..8].try_into().ok()?),
        u32::from_be_bytes(b[8..12].try_into().ok()?),
        u64::from_be_bytes(b[12..20].try_into().ok()?),
    ))
}

// --- HTTP helpers (plain HTTP/1.1, enough for login and room setup) ---

pub struct Target {
    pub host: String,
    pub port: u16,
    pub cookie: String,
    /// IP the server can reach our UDP sockets on.
    pub local_ip: IpAddr,
}

async fn http(host: &str, port: u16, req: http::Request<Full<Bytes>>) -> std::io::Result<http::Response<hyper::body::Incoming>> {
    let tcp = TcpStream::connect((host, port)).await?;
    let (mut send, conn) = hyper::client::conn::http1::handshake(hyper_util::rt::TokioIo::new(tcp)).await.map_err(std::io::Error::other)?;
    tokio::spawn(async move {
        let _ = conn.await;
    });
    send.send_request(req).await.map_err(std::io::Error::other)
}

async fn post_json(t: &Target, path: &str, body: serde_json::Value) -> std::io::Result<(http::StatusCode, http::HeaderMap, Bytes)> {
    let mut req = http::Request::post(path).header("host", format!("{}:{}", t.host, t.port)).header("content-type", "application/json");
    if !t.cookie.is_empty() {
        req = req.header("cookie", &t.cookie);
    }
    let resp = http(&t.host, t.port, req.body(Full::new(Bytes::from(body.to_string()))).unwrap()).await?;
    let (parts, body) = resp.into_parts();
    let body = body.collect().await.map_err(std::io::Error::other)?.to_bytes();
    Ok((parts.status, parts.headers, body))
}

/// Logs in; returns the `Cookie` header value for the session.
pub async fn login(host: &str, port: u16, user: &str, password: &str) -> std::io::Result<String> {
    let t = Target { host: host.into(), port, cookie: String::new(), local_ip: std::net::Ipv4Addr::UNSPECIFIED.into() };
    let (status, headers, _) = post_json(&t, "/api/auth/login", serde_json::json!({ "username": user, "password": password })).await?;
    if status != http::StatusCode::OK {
        return Err(std::io::Error::other(format!("login: status {status}")));
    }
    headers
        .get_all("set-cookie")
        .iter()
        .filter_map(|v| v.to_str().ok())
        .find(|c| c.starts_with("sh_session="))
        .map(|c| c.split(';').next().unwrap().to_string())
        .ok_or_else(|| std::io::Error::other("login: no sh_session cookie"))
}

/// Creates a room owned by the logged-in user; returns its slug.
pub async fn create_room(t: &Target) -> std::io::Result<String> {
    let (status, _, body) = post_json(t, "/api/rooms", serde_json::json!({})).await?;
    if status != http::StatusCode::CREATED {
        return Err(std::io::Error::other(format!("create room: status {status}")));
    }
    let v: serde_json::Value = serde_json::from_slice(&body).map_err(std::io::Error::other)?;
    v["room"]["slug"].as_str().map(str::to_string).ok_or_else(|| std::io::Error::other("create room: no slug"))
}

// --- Measurements ---

#[derive(Default)]
pub struct Samples {
    /// One-way latency, µs.
    pub audio_us: Vec<u32>,
    pub video_us: Vec<u32>,
    pub camera_us: Vec<u32>,
    pub chat_us: Vec<u32>,
    /// hello sent → welcome received, µs.
    pub welcome_us: Vec<u32>,
    /// WS connect → first media packet from anyone, µs.
    pub first_media_us: Vec<u32>,
}

#[derive(Default, Clone, Copy)]
pub struct StreamAcc {
    pub first: u64,
    pub max: u64,
    pub count: u64,
}

impl StreamAcc {
    fn add(&mut self, seq: u64) {
        if self.count == 0 {
            self.first = seq;
            self.max = seq;
        }
        self.first = self.first.min(seq);
        self.max = self.max.max(seq);
        self.count += 1;
    }

    pub fn lost(&self) -> u64 {
        if self.count == 0 { 0 } else { (self.max - self.first + 1).saturating_sub(self.count) }
    }
}

#[derive(Default)]
pub struct Stats {
    pub samples: Mutex<Samples>,
    /// (publisher index) → probe-sequence accounting, audio.
    pub audio: Mutex<HashMap<u32, StreamAcc>>,
    /// (publisher index) → RTP-sequence accounting, video (per-sub renumbered).
    pub video: Mutex<HashMap<u32, StreamAcc>>,
    pub video_frames: AtomicU64,
    /// Same as `video`, for camera subscriptions.
    pub camera: Mutex<HashMap<u32, StreamAcc>>,
    pub camera_frames: AtomicU64,
    /// PLIs the server sent to our publisher PCs.
    pub keyframe_requests: AtomicU64,
    /// (announced slot owner peer ID or "" if unknown, probe publisher index)
    /// → packets: shows whether voices land in the slot announced for them.
    pub slot_owners: Mutex<HashMap<(String, u32), u64>>,
    pub audio_offers: AtomicU64,
    pub ws_in: AtomicU64,
    pub disconnects: AtomicU64,
    pub errors: AtomicU64,
}

impl Stats {
    fn latency(sent_ns: u64) -> u32 {
        (now_ns().saturating_sub(sent_ns) / 1000).min(u32::MAX as u64) as u32
    }
}

// --- Client PCs ---

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Role {
    Audio,
    ScreenPub,
    ScreenSub,
    CameraPub,
    CameraSub,
}

struct ClientPc {
    role: Role,
    pc: OnceLock<Arc<Pc>>,
    mux: Arc<Mux>,
    peer: Weak<ClientPeer>,
    pending: Mutex<Option<SdpPendingOffer>>,
    send_mid: Mutex<Option<Mid>>,
    audio_mid: Mutex<Option<Mid>>,
    /// SSRC → msid stream ID of the server's audio m-lines.
    ssrc_streams: Mutex<HashMap<u32, String>>,
    keyframe: AtomicBool,
}

impl ClientPc {
    async fn new(role: Role, peer: &Arc<ClientPeer>) -> std::io::Result<Arc<ClientPc>> {
        let mux = Mux::bind(peer.target.local_ip, 0, 0).await?;
        let socket = mux.pick();
        let (rtc, ufrag) = match role {
            Role::CameraPub | Role::CameraSub => rtc::build_camera(&socket),
            _ => rtc::build_with(&socket, false, false),
        };
        let c = Arc::new(ClientPc {
            role,
            pc: OnceLock::new(),
            mux,
            peer: Arc::downgrade(peer),
            pending: Mutex::new(None),
            send_mid: Mutex::new(None),
            audio_mid: Mutex::new(None),
            ssrc_streams: Mutex::default(),
            keyframe: AtomicBool::new(true),
        });
        let handler: Weak<dyn PcHandler> = Arc::downgrade(&c) as Weak<dyn PcHandler>;
        let _ = c.pc.set(Pc::spawn(rtc, socket, ufrag, handler));
        Ok(c)
    }

    fn pc(&self) -> &Arc<Pc> {
        self.pc.get().expect("pc set at construction")
    }

    fn close(&self) {
        self.pc().close();
        self.mux.close();
    }

    /// Accepts a server offer; remembers the m-line we may send on.
    fn answer(&self, sdp: &str) -> Option<String> {
        let offer = SdpOffer::from_sdp_string(sdp).ok()?;
        if self.role == Role::Audio {
            let mut map = self.ssrc_streams.lock().unwrap();
            for section in sdp.split("\nm=").skip(1) {
                let stream = section.lines().find_map(|l| l.strip_prefix("a=msid:")).and_then(|v| v.split_whitespace().next());
                let Some(stream) = stream else { continue };
                for l in section.lines() {
                    if let Some(ssrc) = l.strip_prefix("a=ssrc:").and_then(|v| v.split_whitespace().next()).and_then(|v| v.parse().ok()) {
                        map.insert(ssrc, stream.to_string());
                    }
                }
            }
        }
        let answer = self.pc().with(|rtc| rtc.sdp_api().accept_offer(offer)).ok()?.to_sdp_string();
        if self.role == Role::Audio {
            let mut cur_mid = None;
            for line in answer.lines() {
                if let Some(m) = line.strip_prefix("a=mid:") {
                    cur_mid = Some(m.trim().to_string());
                }
                if (line == "a=sendonly" || line == "a=sendrecv")
                    && self.send_mid.lock().unwrap().is_none()
                    && let Some(m) = &cur_mid
                {
                    *self.send_mid.lock().unwrap() = Some(Mid::from(m.as_str()));
                }
            }
        }
        Some(answer)
    }

    fn add_candidate(&self, cand: &str) {
        let c = cand.trim().trim_start_matches("a=");
        if let Ok(c) = Candidate::from_sdp_string(c) {
            self.pc().with(|rtc| rtc.add_remote_candidate(c));
        }
    }

    fn write(&self, mid: Mid, pt: u8, seq: u64, ts: u32, marker: bool, payload: Vec<u8>) {
        self.pc().with(|rtc| {
            if let Some(tx) = rtc.direct_api().stream_tx_by_mid(mid, None) {
                tx.write_rtp(
                    RtpWrite::new(Pt::new_with_value(pt), SeqNo::from(seq), ts, Instant::now(), payload)
                        .marker(marker)
                        .nackable(pt != rtc::PT_OPUS),
                );
            }
        });
    }
}

impl PcHandler for ClientPc {
    fn on_event(&self, _pc: &Arc<Pc>, ev: Event) {
        let Some(peer) = self.peer.upgrade() else { return };
        match ev {
            Event::RtpPacket(pkt) => {
                let video = *pkt.header.payload_type != rtc::PT_OPUS;
                let camera = self.role == Role::CameraSub;
                let desc_len = match (video, camera) {
                    (false, _) => 0,
                    (true, false) => VP9_DESC_LEN,
                    (true, true) => VP8_DESC_LEN,
                };
                let body = pkt.payload.get(desc_len..).unwrap_or(&[]);
                let Some((publisher, seq, sent)) = parse_probe(body) else { return };
                peer.first_media();
                let lat = Stats::latency(sent);
                if camera {
                    peer.stats.camera.lock().unwrap().entry(publisher).or_default().add(*pkt.seq_no);
                    if pkt.header.marker {
                        peer.stats.camera_frames.fetch_add(1, Ordering::Relaxed);
                    }
                    peer.stats.samples.lock().unwrap().camera_us.push(lat);
                } else if video {
                    peer.stats.video.lock().unwrap().entry(publisher).or_default().add(*pkt.seq_no);
                    if pkt.header.marker {
                        peer.stats.video_frames.fetch_add(1, Ordering::Relaxed);
                    }
                    peer.stats.samples.lock().unwrap().video_us.push(lat);
                } else {
                    if self.role == Role::Audio {
                        let stream = self.ssrc_streams.lock().unwrap().get(&*pkt.header.ssrc).cloned();
                        let owner = stream.and_then(|s| peer.slot_owner.lock().unwrap().get(&s).cloned().flatten()).unwrap_or_default();
                        *peer.stats.slot_owners.lock().unwrap().entry((owner, publisher)).or_default() += 1;
                    }
                    peer.stats.audio.lock().unwrap().entry(publisher).or_default().add(seq as u64);
                    peer.stats.samples.lock().unwrap().audio_us.push(lat);
                }
            }
            Event::KeyframeRequest(_) => {
                peer.stats.keyframe_requests.fetch_add(1, Ordering::Relaxed);
                self.keyframe.store(true, Ordering::Release);
            }
            _ => {}
        }
    }

    fn on_closed(&self, _pc: &Arc<Pc>) {
        if let Some(p) = self.peer.upgrade()
            && !p.cancel.is_cancelled()
        {
            p.stats.disconnects.fetch_add(1, Ordering::Relaxed);
        }
    }
}

// --- Peer ---

pub struct PeerOpts {
    pub display_name: String,
    pub client_id: String,
    pub chat_only: bool,
    pub room: String,
    /// Subscribe to every screen share that becomes available.
    pub watch_screens: bool,
    /// preferredTemporalLayer for subscriptions.
    pub temporal_layer: u8,
    /// Subscribe to every camera that becomes available.
    pub watch_cameras: bool,
}

pub struct ClientPeer {
    pub idx: u32,
    target: Arc<Target>,
    pub stats: Arc<Stats>,
    pub id: OnceLock<String>,
    out: mpsc::UnboundedSender<String>,
    pub cancel: CancellationToken,
    audio: OnceLock<Arc<ClientPc>>,
    screen_pub: Mutex<Option<Arc<ClientPc>>>,
    screen_subs: Mutex<HashMap<String, Arc<ClientPc>>>,
    screen_paused: AtomicBool,
    watch_screens: bool,
    camera_pub: Mutex<Option<Arc<ClientPc>>>,
    camera_subs: Mutex<HashMap<String, Arc<ClientPc>>>,
    watch_cameras: bool,
    temporal_layer: u8,
    connected_at: Instant,
    hello_at: Mutex<Option<Instant>>,
    got_media: AtomicBool,
    audio_seq: AtomicU32,
    /// Slot stream ID → announced owner peer ID.
    pub slot_owner: Mutex<HashMap<String, Option<String>>>,
    /// Resume token from the last screen-share-started.
    pub screen_token: Mutex<Option<String>>,
    /// Reason of the last screen-share-error.
    pub screen_error: Mutex<Option<String>>,
    /// m-line count of the last audio offer.
    pub audio_mlines: AtomicU32,
}

fn env(event: &str, data: serde_json::Value) -> String {
    serde_json::json!({ "event": event, "data": data }).to_string()
}

impl ClientPeer {
    pub async fn connect(target: Arc<Target>, idx: u32, opts: PeerOpts, stats: Arc<Stats>) -> std::io::Result<Arc<ClientPeer>> {
        let connected_at = Instant::now();
        let tcp = TcpStream::connect((target.host.as_str(), target.port)).await?;
        let mut req =
            format!("ws://{}:{}/ws/{}", target.host, target.port, opts.room).into_client_request().map_err(std::io::Error::other)?;
        req.headers_mut().insert("cookie", target.cookie.parse().map_err(std::io::Error::other)?);
        let (ws, _) = tokio_tungstenite::client_async(req, tcp).await.map_err(std::io::Error::other)?;
        let (mut sink, mut stream) = ws.split();
        let (tx, mut rx) = mpsc::unbounded_channel::<String>();
        let cancel = CancellationToken::new();
        let peer = Arc::new(ClientPeer {
            idx,
            target,
            stats,
            id: OnceLock::new(),
            out: tx,
            cancel: cancel.clone(),
            audio: OnceLock::new(),
            screen_pub: Mutex::new(None),
            screen_subs: Mutex::new(HashMap::new()),
            screen_paused: AtomicBool::new(false),
            watch_screens: opts.watch_screens,
            camera_pub: Mutex::new(None),
            camera_subs: Mutex::new(HashMap::new()),
            watch_cameras: opts.watch_cameras,
            temporal_layer: opts.temporal_layer,
            connected_at,
            hello_at: Mutex::new(None),
            got_media: AtomicBool::new(false),
            audio_seq: AtomicU32::new(0),
            screen_token: Mutex::new(None),
            slot_owner: Mutex::default(),
            screen_error: Mutex::new(None),
            audio_mlines: AtomicU32::new(0),
        });
        if !opts.chat_only {
            let a = ClientPc::new(Role::Audio, &peer).await?;
            let _ = peer.audio.set(a);
        }
        let c2 = cancel.clone();
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = c2.cancelled() => break,
                    m = rx.recv() => match m {
                        Some(m) => if sink.send(Message::Text(m.into())).await.is_err() { c2.cancel(); break },
                        None => break,
                    },
                }
            }
            let _ = sink.send(Message::Close(None)).await;
        });
        let weak = Arc::downgrade(&peer);
        let c3 = cancel.clone();
        tokio::spawn(async move {
            loop {
                let m = tokio::select! {
                    _ = c3.cancelled() => break,
                    m = stream.next() => m,
                };
                let Some(Ok(m)) = m else { break };
                let Message::Text(t) = m else { continue };
                let Some(p) = weak.upgrade() else { break };
                p.stats.ws_in.fetch_add(1, Ordering::Relaxed);
                p.on_message(&t).await;
            }
            // Like the browser, a lost WebSocket leaves the PeerConnections up
            // (a screen share survives until resume); `close` tears them down.
            if let Some(p) = weak.upgrade()
                && !p.cancel.is_cancelled()
            {
                p.stats.disconnects.fetch_add(1, Ordering::Relaxed);
                p.cancel.cancel();
            }
        });
        *peer.hello_at.lock().unwrap() = Some(Instant::now());
        peer.send(env(
            "hello",
            serde_json::json!({ "displayName": opts.display_name, "clientId": opts.client_id, "chatOnly": opts.chat_only }),
        ));
        Ok(peer)
    }

    fn send(&self, m: String) {
        let _ = self.out.send(m);
    }

    fn first_media(&self) {
        if !self.got_media.swap(true, Ordering::AcqRel) {
            let us = self.connected_at.elapsed().as_micros() as u32;
            self.stats.samples.lock().unwrap().first_media_us.push(us);
        }
    }

    pub fn close(&self) {
        self.cancel.cancel();
        if let Some(a) = self.audio.get() {
            a.close();
        }
        if let Some(p) = self.screen_pub.lock().unwrap().take() {
            p.close();
        }
        for (_, s) in self.screen_subs.lock().unwrap().drain() {
            s.close();
        }
        if let Some(p) = self.camera_pub.lock().unwrap().take() {
            p.close();
        }
        for (_, s) in self.camera_subs.lock().unwrap().drain() {
            s.close();
        }
    }

    /// Drops only the signaling WebSocket; PeerConnections stay up (what a
    /// network blip looks like before the client reconnects).
    pub fn drop_ws(&self) {
        self.cancel.cancel();
    }

    pub fn joined(&self) -> bool {
        self.id.get().is_some()
    }

    async fn on_message(self: &Arc<Self>, raw: &str) {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(raw) else { return };
        let event = v["event"].as_str().unwrap_or("");
        let d = &v["data"];
        let pc = d["pc"].as_str().unwrap_or("");
        let publisher = d["publisherId"].as_str().unwrap_or("").to_string();
        match event {
            "welcome" => {
                let _ = self.id.set(d["id"].as_str().unwrap_or("").to_string());
                if self.watch_screens && self.audio.get().is_some() {
                    for p in d["peers"].as_array().into_iter().flatten().filter(|p| p["screenSharing"] == true) {
                        self.send(env(
                            "screen-share-subscribe",
                            serde_json::json!({ "publisherId": p["id"], "preferredTemporalLayer": self.temporal_layer }),
                        ));
                    }
                }
                if self.watch_cameras && self.audio.get().is_some() {
                    for p in d["peers"].as_array().into_iter().flatten().filter(|p| p["cameraOn"] == true) {
                        self.send(env("camera-subscribe", serde_json::json!({ "publisherId": p["id"] })));
                    }
                }
                if let Some(at) = *self.hello_at.lock().unwrap() {
                    self.stats.samples.lock().unwrap().welcome_us.push(at.elapsed().as_micros() as u32);
                }
            }
            "offer" if pc == "audio" => {
                self.stats.audio_offers.fetch_add(1, Ordering::Relaxed);
                let Some(a) = self.audio.get() else { return };
                let sdp = d["sdp"].as_str().unwrap_or("");
                self.audio_mlines.store(sdp.matches("\nm=").count() as u32, Ordering::Relaxed);
                match a.answer(sdp) {
                    Some(sdp) => self.send(env("answer", serde_json::json!({ "pc": "audio", "type": "answer", "sdp": sdp }))),
                    None => {
                        self.stats.errors.fetch_add(1, Ordering::Relaxed);
                    }
                }
            }
            "offer" if pc == "screen-sub" => {
                let Ok(sub) = ClientPc::new(Role::ScreenSub, self).await else { return };
                match sub.answer(d["sdp"].as_str().unwrap_or("")) {
                    Some(sdp) => {
                        self.screen_subs.lock().unwrap().insert(publisher.clone(), sub);
                        self.send(env(
                            "answer",
                            serde_json::json!({ "pc": "screen-sub", "publisherId": publisher, "type": "answer", "sdp": sdp }),
                        ));
                    }
                    None => {
                        self.stats.errors.fetch_add(1, Ordering::Relaxed);
                        sub.close();
                    }
                }
            }
            "offer" if pc == "camera-sub" => {
                let Ok(sub) = ClientPc::new(Role::CameraSub, self).await else { return };
                match sub.answer(d["sdp"].as_str().unwrap_or("")) {
                    Some(sdp) => {
                        self.camera_subs.lock().unwrap().insert(publisher.clone(), sub);
                        self.send(env(
                            "answer",
                            serde_json::json!({ "pc": "camera-sub", "publisherId": publisher, "type": "answer", "sdp": sdp }),
                        ));
                    }
                    None => {
                        self.stats.errors.fetch_add(1, Ordering::Relaxed);
                        sub.close();
                    }
                }
            }
            "answer" if pc == "screen-pub" || pc == "camera-pub" => {
                let slot = if pc == "screen-pub" { &self.screen_pub } else { &self.camera_pub };
                let Some(p) = slot.lock().unwrap().clone() else { return };
                let pending = p.pending.lock().unwrap().take();
                let (Some(pending), Ok(ans)) = (pending, SdpAnswer::from_sdp_string(d["sdp"].as_str().unwrap_or(""))) else { return };
                if p.pc().with(|rtc| rtc.sdp_api().accept_answer(pending, ans)).is_err() {
                    self.stats.errors.fetch_add(1, Ordering::Relaxed);
                }
            }
            "candidate" => {
                let c = d["candidate"].as_str().unwrap_or("");
                let target = match pc {
                    "audio" => self.audio.get().cloned(),
                    "screen-pub" => self.screen_pub.lock().unwrap().clone(),
                    "screen-sub" => self.screen_subs.lock().unwrap().get(&publisher).cloned(),
                    "camera-pub" => self.camera_pub.lock().unwrap().clone(),
                    "camera-sub" => self.camera_subs.lock().unwrap().get(&publisher).cloned(),
                    _ => None,
                };
                if let Some(t) = target {
                    t.add_candidate(c);
                }
            }
            "chat" => {
                let from = d["from"].as_str().unwrap_or("");
                if Some(from) != self.id.get().map(String::as_str)
                    && let Some(ns) = d["clientMsgId"].as_str().and_then(|m| m.strip_prefix("lt:")).and_then(|n| n.parse::<u64>().ok())
                {
                    self.stats.samples.lock().unwrap().chat_us.push(Stats::latency(ns));
                }
            }
            "screen-share-available" if self.watch_screens && self.audio.get().is_some() => {
                self.send(env(
                    "screen-share-subscribe",
                    serde_json::json!({ "publisherId": publisher, "preferredTemporalLayer": self.temporal_layer }),
                ));
            }
            "screen-share-ended" => {
                if let Some(s) = self.screen_subs.lock().unwrap().remove(&publisher) {
                    s.close();
                }
            }
            "camera-available" if self.watch_cameras && self.audio.get().is_some() => {
                self.send(env("camera-subscribe", serde_json::json!({ "publisherId": publisher })));
            }
            "camera-ended" => {
                if let Some(s) = self.camera_subs.lock().unwrap().remove(&publisher) {
                    s.close();
                }
            }
            "audio-slots" => {
                let mut owners = self.slot_owner.lock().unwrap();
                for s in d["slots"].as_array().into_iter().flatten() {
                    owners.insert(s["slot"].as_str().unwrap_or("").to_string(), s["peerId"].as_str().map(str::to_string));
                }
            }
            "screen-share-started" => *self.screen_token.lock().unwrap() = d["sessionToken"].as_str().map(str::to_string),
            "screen-share-error" => *self.screen_error.lock().unwrap() = d["reason"].as_str().map(str::to_string),
            "screen-share-encode-pause" => self.screen_paused.store(true, Ordering::Release),
            "screen-share-encode-resume" => self.screen_paused.store(false, Ordering::Release),
            _ => {}
        }
    }

    pub fn chat(&self, text: &str) {
        self.send(env("chat-send", serde_json::json!({ "text": text, "clientMsgId": format!("lt:{}", now_ns()) })));
    }

    pub fn set_state(&self, muted: bool) {
        self.send(env("set-state", serde_json::json!({ "selfMuted": muted, "deafened": false })));
    }

    /// One 20 ms Opus-sized packet; `speaking` = full frame, else DTX-sized.
    pub fn send_audio(&self, speaking: bool, ts: u32) {
        let Some(a) = self.audio.get() else { return };
        let Some(mid) = *a.send_mid.lock().unwrap() else { return };
        let seq = self.audio_seq.fetch_add(1, Ordering::Relaxed);
        let mut payload = vec![0u8; if speaking { 100 } else { PROBE_LEN }];
        probe(&mut payload, self.idx, seq);
        a.write(mid, rtc::PT_OPUS, 1000 + seq as u64, ts, false, payload);
    }

    /// Starts a VP9 screen share (plus optional system audio).
    pub async fn start_screen(self: &Arc<Self>, with_audio: bool) -> std::io::Result<()> {
        let p = ClientPc::new(Role::ScreenPub, self).await?;
        let (video, audio, offer) = p.pc().with(|rtc| {
            let mut api = rtc.sdp_api();
            let v = api.add_media(MediaKind::Video, Direction::SendOnly, Some("screen".into()), Some("v".into()), None);
            let a = with_audio.then(|| api.add_media(MediaKind::Audio, Direction::SendOnly, Some("screen".into()), Some("a".into()), None));
            (v, a, api.apply())
        });
        let Some((offer, pending)) = offer else { return Err(std::io::Error::other("no offer")) };
        *p.pending.lock().unwrap() = Some(pending);
        *p.send_mid.lock().unwrap() = Some(video);
        *p.audio_mid.lock().unwrap() = audio;
        *self.screen_pub.lock().unwrap() = Some(p);
        self.send(env(
            "screen-share-start",
            serde_json::json!({ "sdp": offer.to_sdp_string(), "hasSystemAudio": with_audio, "mode": "sharp" }),
        ));
        Ok(())
    }

    /// Sends one synthetic L1T3 VP9 frame of roughly `bytes` (keyframe when
    /// requested). Returns false while dynacast has the encoder paused.
    pub fn send_screen_frame(&self, frame_no: u32, bytes: usize, seq: &mut u64) -> bool {
        let Some(p) = self.screen_pub.lock().unwrap().clone() else { return false };
        if self.screen_paused.load(Ordering::Acquire) {
            return false;
        }
        let Some(mid) = *p.send_mid.lock().unwrap() else { return false };
        let keyframe = p.keyframe.swap(false, Ordering::AcqRel);
        let tid: u8 = if keyframe { 0 } else { [0, 2, 1, 2][(frame_no % 4) as usize] };
        let size = if keyframe { bytes * 4 } else { bytes };
        let packets = size.div_ceil(VIDEO_MTU_PAYLOAD).max(1);
        let pid = (frame_no & 0x7fff) as u16;
        let ts = frame_no.wrapping_mul(3000);
        for i in 0..packets {
            let mut head = 0x80 | 0x20; // I, L
            if !keyframe {
                head |= 0x40; // P
            }
            if i == 0 {
                head |= 0x08; // B
            }
            if i == packets - 1 {
                head |= 0x04; // E
            }
            let mut payload = vec![0u8; VIDEO_MTU_PAYLOAD.min(size - i * VIDEO_MTU_PAYLOAD).max(VP9_DESC_LEN + PROBE_LEN)];
            payload[0] = head;
            payload[1] = 0x80 | (pid >> 8) as u8;
            payload[2] = pid as u8;
            payload[3] = (tid << 5) | if tid > 0 { 0x10 } else { 0 };
            payload[4] = (frame_no / 4) as u8; // TL0PICIDX
            probe(&mut payload[VP9_DESC_LEN..], self.idx, *seq as u32);
            p.write(mid, rtc::PT_VP9, *seq, ts, i == packets - 1, payload);
            *seq += 1;
        }
        true
    }

    pub fn send_screen_audio(&self, seq: u64, ts: u32) {
        let Some(p) = self.screen_pub.lock().unwrap().clone() else { return };
        let Some(mid) = *p.audio_mid.lock().unwrap() else { return };
        let mut payload = vec![0u8; 100];
        probe(&mut payload, self.idx + 100_000, seq as u32);
        p.write(mid, rtc::PT_OPUS, seq, ts, false, payload);
    }

    /// ICE-restart offer for the screen PC, as the browser sends after a
    /// resume. Feed the answer to `screen_accept_answer`.
    pub fn screen_ice_restart_offer(&self) -> Option<String> {
        let p = self.screen_pub.lock().unwrap().clone()?;
        let (offer, pending) = p.pc().with(|rtc| {
            let mut api = rtc.sdp_api();
            api.ice_restart(true);
            api.apply()
        })?;
        *p.pending.lock().unwrap() = Some(pending);
        Some(offer.to_sdp_string())
    }

    pub fn screen_accept_answer(&self, sdp: &str) -> bool {
        let Some(p) = self.screen_pub.lock().unwrap().clone() else { return false };
        let pending = p.pending.lock().unwrap().take();
        let (Some(pending), Ok(ans)) = (pending, SdpAnswer::from_sdp_string(sdp)) else { return false };
        p.pc().with(|rtc| rtc.sdp_api().accept_answer(pending, ans)).is_ok()
    }

    /// Applies a dynacast pause/resume received on another connection.
    pub fn set_screen_paused(&self, paused: bool) {
        self.screen_paused.store(paused, Ordering::Release);
    }

    pub fn stop_screen(&self) {
        self.send(env("screen-share-stop", serde_json::json!({})));
        if let Some(p) = self.screen_pub.lock().unwrap().take() {
            p.close();
        }
    }

    /// Starts a VP8 camera.
    pub async fn start_camera(self: &Arc<Self>) -> std::io::Result<()> {
        let p = ClientPc::new(Role::CameraPub, self).await?;
        let (video, offer) = p.pc().with(|rtc| {
            let mut api = rtc.sdp_api();
            let v = api.add_media(MediaKind::Video, Direction::SendOnly, Some("camera".into()), Some("v".into()), None);
            (v, api.apply())
        });
        let Some((offer, pending)) = offer else { return Err(std::io::Error::other("no offer")) };
        *p.pending.lock().unwrap() = Some(pending);
        *p.send_mid.lock().unwrap() = Some(video);
        *self.camera_pub.lock().unwrap() = Some(p);
        self.send(env("camera-start", serde_json::json!({ "sdp": offer.to_sdp_string() })));
        Ok(())
    }

    /// Sends one synthetic VP8 frame of roughly `bytes` (4× when a keyframe
    /// was requested). Returns false when no camera is published.
    pub fn send_camera_frame(&self, frame_no: u32, bytes: usize, seq: &mut u64) -> bool {
        let Some(p) = self.camera_pub.lock().unwrap().clone() else { return false };
        let Some(mid) = *p.send_mid.lock().unwrap() else { return false };
        let size = if p.keyframe.swap(false, Ordering::AcqRel) { bytes * 4 } else { bytes };
        let packets = size.div_ceil(VIDEO_MTU_PAYLOAD).max(1);
        let pid = (frame_no & 0x7fff) as u16;
        let ts = frame_no.wrapping_mul(3000);
        for i in 0..packets {
            let mut payload = vec![0u8; VIDEO_MTU_PAYLOAD.min(size - i * VIDEO_MTU_PAYLOAD).max(VP8_DESC_LEN + PROBE_LEN)];
            payload[0] = 0x80 | if i == 0 { 0x10 } else { 0 }; // X, S
            payload[1] = 0x80; // I
            payload[2] = 0x80 | (pid >> 8) as u8;
            payload[3] = pid as u8;
            probe(&mut payload[VP8_DESC_LEN..], self.idx, *seq as u32);
            p.write(mid, rtc::PT_VP8, *seq, ts, i == packets - 1, payload);
            *seq += 1;
        }
        true
    }

    pub fn stop_camera(&self) {
        self.send(env("camera-stop", serde_json::json!({})));
        if let Some(p) = self.camera_pub.lock().unwrap().take() {
            p.close();
        }
    }

    pub fn unsubscribe_camera(&self, publisher_id: &str) {
        self.send(env("camera-unsubscribe", serde_json::json!({ "publisherId": publisher_id })));
        if let Some(s) = self.camera_subs.lock().unwrap().remove(publisher_id) {
            s.close();
        }
    }

    pub fn raw(&self, event: &str, data: serde_json::Value) {
        self.send(env(event, data));
    }
}
