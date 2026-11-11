//! Room behaviour over real WebSockets (and real WebRTC via `loadclient`)
//! against an in-process server.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::net::TcpStream;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

use crate::loadclient::{ClientPeer, PeerOpts, Stats, Target};
use crate::testkit::{Env, env};

const WAIT: Duration = Duration::from_secs(5);

struct Ws {
    ws: WebSocketStream<TcpStream>,
}

impl Ws {
    async fn open(port: u16, cookie: &str, room: &str) -> Ws {
        let mut req = format!("ws://127.0.0.1:{port}/ws/{room}").into_client_request().unwrap();
        req.headers_mut().insert("cookie", cookie.parse().unwrap());
        let tcp = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let (ws, _) = tokio_tungstenite::client_async(req, tcp).await.unwrap();
        Ws { ws }
    }

    async fn join(port: u16, room: &str, cookie: &str, name: &str, client_id: &str, chat_only: bool) -> (Ws, String) {
        let mut w = Ws::open(port, cookie, room).await;
        w.send("hello", json!({ "displayName": name, "clientId": client_id, "chatOnly": chat_only })).await;
        let welcome = w.expect("welcome").await;
        (w, welcome["id"].as_str().unwrap().to_string())
    }

    async fn send(&mut self, event: &str, data: Value) {
        self.ws.send(Message::Text(json!({ "event": event, "data": data }).to_string().into())).await.unwrap();
    }

    /// Next message with this event name; others are skipped.
    async fn expect(&mut self, event: &str) -> Value {
        tokio::time::timeout(WAIT, async {
            loop {
                match self.ws.next().await {
                    Some(Ok(Message::Text(t))) => {
                        let v: Value = serde_json::from_str(&t).unwrap();
                        if v["event"] == event {
                            return v["data"].clone();
                        }
                    }
                    Some(Ok(_)) => {}
                    other => panic!("socket ended waiting for {event}: {other:?}"),
                }
            }
        })
        .await
        .unwrap_or_else(|_| panic!("timed out waiting for {event}"))
    }

    /// Asserts none of `events` arrives within `d`.
    async fn none(&mut self, events: &[&str], d: Duration) {
        let r = tokio::time::timeout(d, async {
            loop {
                match self.ws.next().await {
                    Some(Ok(Message::Text(t))) => {
                        let v: Value = serde_json::from_str(&t).unwrap();
                        if events.iter().any(|e| v["event"] == *e) {
                            return v;
                        }
                    }
                    Some(Ok(_)) => {}
                    _ => std::future::pending::<()>().await,
                }
            }
        })
        .await;
        assert!(r.is_err(), "unexpected event: {r:?}");
    }

    async fn closed(&mut self) -> bool {
        tokio::time::timeout(WAIT, async {
            loop {
                match self.ws.next().await {
                    None | Some(Err(_)) | Some(Ok(Message::Close(_))) => return true,
                    _ => {}
                }
            }
        })
        .await
        .unwrap_or(false)
    }
}

async fn served() -> (Env, u16, String) {
    let e = env().await;
    let port = e.serve().await;
    let cookie = e.user_cookie();
    (e, port, cookie)
}

/// The roster of the env's room (empty before anyone joined).
fn roster(e: &Env) -> Vec<crate::sfu::protocol::PeerInfo> {
    e.live_room(&e.room).map(|r| r.peers()).unwrap_or_default()
}

#[tokio::test(flavor = "multi_thread")]
async fn lurker_roster_and_chat() {
    let (e, port, c) = served().await;
    let (mut a, a_id) = Ws::join(port, &e.room, &c, "alice", "ca", false).await;
    let (mut l, l_id) = Ws::join(port, &e.room, &c, "lurk", "cl", true).await;
    let joined = a.expect("peer-joined").await;
    assert_eq!(joined, json!({ "id": l_id, "displayName": "lurk", "clientId": "cl", "chatOnly": true }));

    l.send("chat-send", json!({ "text": "  hi all  ", "clientMsgId": "m1" })).await;
    let ma = a.expect("chat").await;
    let ml = l.expect("chat").await;
    assert_eq!(ma, ml, "one envelope for everyone, sender included");
    assert_eq!(ma["text"], "hi all");
    assert_eq!(ma["from"], l_id);
    assert_eq!(ma["senderName"], "lurk");
    assert_eq!(ma["clientMsgId"], "m1");
    assert_eq!(ma["id"].as_str().unwrap().len(), 26);

    // Lurkers can't touch media or state.
    l.send("set-state", json!({ "selfMuted": true, "deafened": true })).await;
    l.send("set-displayname", json!({ "displayName": "x" })).await;
    l.send("offer", json!({ "pc": "audio", "type": "offer", "sdp": "v=0" })).await;
    a.none(&["peer-state", "peer-info", "offer"], Duration::from_millis(300)).await;
    a.send("chat-send", json!({ "text": "voice→lurker", "clientMsgId": "m2" })).await;
    assert_eq!(l.expect("chat").await["from"], a_id);

    drop(l);
    assert_eq!(a.expect("peer-left").await, json!({ "id": l_id }));
}

#[tokio::test(flavor = "multi_thread")]
async fn chat_validation() {
    let (e, port, c) = served().await;
    let (mut a, _) = Ws::join(port, &e.room, &c, "alice", "ca", true).await;
    let (mut nameless, _) = Ws::join(port, &e.room, &c, "", "cn", true).await;
    for text in ["", "   "] {
        a.send("chat-send", json!({ "text": text, "clientMsgId": "e" })).await;
    }
    a.send("chat-send", json!({ "text": "x".repeat(2001), "clientMsgId": "big" })).await;
    nameless.send("chat-send", json!({ "text": "no hello name", "clientMsgId": "n" })).await;
    a.send("chat-send", json!({ "text": "x".repeat(2000), "clientMsgId": "max" })).await;
    let m = a.expect("chat").await;
    assert_eq!(m["clientMsgId"], "max", "only the exact-limit message passes");

    a.send("chat-delete", json!({ "id": "" })).await;
    a.send("chat-delete", json!({ "id": "01HX" })).await;
    assert_eq!(nameless.expect("chat-deleted").await, json!({ "id": "01HX" }));
    assert_eq!(a.expect("chat-deleted").await, json!({ "id": "01HX" }));
}

#[tokio::test(flavor = "multi_thread")]
async fn chat_attachments() {
    let (e, port, c) = served().await;
    let upload = |room: &str| {
        let room = room.to_string();
        let e = &e;
        let c = c.clone();
        async move {
            let r = e.call(http::Method::POST, &format!("/api/upload?room={room}"), Some(&c), &[], "bytes").await;
            let body = http_body_util::BodyExt::collect(r.into_body()).await.unwrap().to_bytes();
            serde_json::from_slice::<Value>(&body).unwrap()["uploadId"].as_str().unwrap().to_string()
        }
    };
    let here = upload(&e.room).await;
    let other = upload(&e.new_room()).await;
    let att = |id: &str| json!({ "uploadId": id, "kind": "file", "name": "a.txt", "mime": "text/plain", "size": 5 });
    let (mut a, _) = Ws::join(port, &e.room, &c, "alice", "ca", true).await;
    a.send("chat-send", json!({ "text": "", "clientMsgId": "bad1", "attachments": [att("nope")] })).await;
    a.send("chat-send", json!({ "text": "", "clientMsgId": "bad2", "attachments": [att(&other)] })).await;
    a.send("chat-send", json!({ "text": "", "clientMsgId": "bad3", "attachments": vec![att(&here); 11] })).await;
    a.send("chat-send", json!({ "text": "", "clientMsgId": "ok", "attachments": [att(&here)] })).await;
    let m = a.expect("chat").await;
    assert_eq!(m["clientMsgId"], "ok");
    assert_eq!(m["attachments"][0]["uploadId"], here.as_str());
    assert!(m.get("text").is_some());
}

#[tokio::test(flavor = "multi_thread")]
async fn eviction_state_and_ping() {
    let (e, port, c) = served().await;
    let (mut a, a_id) = Ws::join(port, &e.room, &c, "alice", "ca", false).await;
    let (mut b1, b1_id) = Ws::join(port, &e.room, &c, "bob", "cb", false).await;
    a.expect("peer-joined").await;

    // Same clientId reconnects: peer-left for the stale session before peer-joined.
    let (mut b2, b2_id) = Ws::join(port, &e.room, &c, "bob", "cb", false).await;
    assert_eq!(a.expect("peer-left").await["id"], b1_id);
    assert_eq!(a.expect("peer-joined").await["id"], b2_id);
    assert!(b1.closed().await, "evicted socket is closed");

    b2.send("set-state", json!({ "selfMuted": true, "deafened": false })).await;
    assert_eq!(a.expect("peer-state").await, json!({ "id": b2_id, "selfMuted": true, "deafened": false }));
    b2.send("set-displayname", json!({ "displayName": "robert" })).await;
    let info = a.expect("peer-info").await;
    assert_eq!((info["displayName"].as_str(), info["selfMuted"].as_bool()), (Some("robert"), Some(true)));

    // One ping per target per 10 s, whoever sends it.
    b2.send("ping", json!({ "to": a_id })).await;
    b2.send("ping", json!({ "to": a_id })).await;
    b2.send("ping", json!({ "to": b2_id })).await;
    assert_eq!(a.expect("ping").await, json!({ "from": b2_id, "fromName": "robert" }));
    a.none(&["ping"], Duration::from_millis(300)).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn first_message_must_be_hello() {
    let (e, port, c) = served().await;
    let mut w = Ws::open(port, &c, &e.room).await;
    w.send("chat-send", json!({ "text": "too early" })).await;
    assert!(w.closed().await);
}

async fn peer(t: &Arc<Target>, room: &str, idx: u32, watch: bool, layer: u8) -> Arc<ClientPeer> {
    let opts = PeerOpts {
        display_name: format!("p{idx}"),
        client_id: format!("c{idx}"),
        chat_only: false,
        room: room.into(),
        watch_screens: watch,
        temporal_layer: layer,
        watch_cameras: watch,
    };
    ClientPeer::connect(t.clone(), idx, opts, Arc::new(Stats::default())).await.unwrap()
}

async fn until(what: &str, mut f: impl FnMut() -> bool) {
    for _ in 0..100 {
        if f() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("timed out: {what}");
}

fn target(port: u16, cookie: String) -> Arc<Target> {
    Arc::new(Target { host: "127.0.0.1".into(), port, cookie, local_ip: "127.0.0.1".parse().unwrap() })
}

#[tokio::test(flavor = "multi_thread")]
async fn audio_fans_out_to_everyone_else() {
    let (e, port, c) = served().await;
    let t = target(port, c);
    let peers = [peer(&t, &e.room, 0, false, 2).await, peer(&t, &e.room, 1, false, 2).await, peer(&t, &e.room, 2, false, 2).await];
    for n in 0..150u32 {
        for p in &peers {
            p.send_audio(true, n * 960);
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    until("every peer hears both others", || {
        peers.iter().all(|p| {
            let a = p.stats.audio.lock().unwrap();
            a.len() == 2 && !a.contains_key(&p.idx) && a.values().all(|s| s.count > 50)
        })
    })
    .await;
    for p in &peers {
        assert_eq!(p.stats.audio.lock().unwrap().values().map(|s| s.lost()).sum::<u64>(), 0);
    }
    assert!(roster(&e).len() == 3);
    peers[2].close();
    until("peer removed", || roster(&e).len() == 2).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn muted_silence_is_not_forwarded() {
    let (e, port, c) = served().await;
    let t = target(port, c);
    let (a, b) = (peer(&t, &e.room, 0, false, 2).await, peer(&t, &e.room, 1, false, 2).await);
    a.set_state(true);
    until("server sees A muted", || roster(&e).iter().any(|p| p.self_muted)).await;
    for n in 0..50u32 {
        a.send_audio(false, n * 960);
        b.send_audio(true, n * 960);
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    until("A hears B", || a.stats.audio.lock().unwrap().get(&1).is_some_and(|s| s.count > 30)).await;
    assert!(b.stats.audio.lock().unwrap().get(&0).is_none(), "B got A's muted silence");

    // Speech from a peer whose unmute hasn't landed yet still goes through.
    for n in 50..100u32 {
        a.send_audio(true, n * 960);
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    until("B hears A's speech", || b.stats.audio.lock().unwrap().get(&0).is_some_and(|s| s.count > 30)).await;
    assert_eq!(b.stats.audio.lock().unwrap()[&0].lost(), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn screen_share_lifecycle_and_layers() {
    let (e, port, c) = served().await;
    let t = target(port, c.clone());
    let publisher = peer(&t, &e.room, 0, false, 2).await;
    let full_viewer = peer(&t, &e.room, 1, true, 2).await;
    let base_viewer = peer(&t, &e.room, 2, true, 0).await;
    let (mut raw, _) = Ws::join(port, &e.room, &c, "observer", "cobs", false).await;
    until("all joined", || roster(&e).len() == 4).await;

    publisher.start_screen(false).await.unwrap();
    let mut seq = 1u64;
    let mut frame = 0u32;
    for _ in 0..90 {
        if publisher.send_screen_frame(frame, 3000, &mut seq) {
            frame += 1;
        }
        tokio::time::sleep(Duration::from_millis(33)).await;
    }
    let av = raw.expect("screen-share-available").await;
    assert_eq!((av["videoCodec"].as_str(), av["mode"].as_str(), av["hasSystemAudio"].as_bool()), (Some("vp9"), Some("sharp"), Some(false)));
    until("both viewers get frames", || {
        full_viewer.stats.video_frames.load(std::sync::atomic::Ordering::Relaxed) > 20
            && base_viewer.stats.video_frames.load(std::sync::atomic::Ordering::Relaxed) > 5
    })
    .await;
    let full = full_viewer.stats.video_frames.load(std::sync::atomic::Ordering::Relaxed);
    let base = base_viewer.stats.video_frames.load(std::sync::atomic::Ordering::Relaxed);
    // T0 is one frame in four (L1T3): the capped viewer sees about a quarter.
    assert!(base * 2 < full, "temporal filtering: base={base} full={full}");
    for v in [&full_viewer, &base_viewer] {
        assert_eq!(v.stats.video.lock().unwrap().values().map(|s| s.lost()).sum::<u64>(), 0, "renumbered without gaps");
    }

    // A second start while sharing is refused and the first share survives.
    publisher.raw("screen-share-start", json!({ "sdp": "v=0", "hasSystemAudio": false }));
    until("already-publishing", || publisher.screen_error.lock().unwrap().as_deref() == Some("already-publishing")).await;
    assert!(roster(&e).iter().any(|p| p.display_name == "p0" && p.screen_sharing));
    publisher.stop_screen();
    let ended = raw.expect("screen-share-ended").await;
    assert_eq!(ended["publisherId"], roster(&e).iter().find(|p| p.display_name == "p0").unwrap().id.as_str());
}

#[tokio::test(flavor = "multi_thread")]
async fn screen_share_resume_after_ws_drop() {
    let (e, port, c) = served().await;
    let t = target(port, c.clone());
    let publisher = peer(&t, &e.room, 0, false, 2).await;
    let (mut watcher, _) = Ws::join(port, &e.room, &c, "watcher", "cw", false).await;
    publisher.start_screen(false).await.unwrap();
    until("token issued", || publisher.screen_token.lock().unwrap().is_some()).await;
    let mut seq = 1;
    for f in 0..10 {
        publisher.send_screen_frame(f, 2000, &mut seq);
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
    let old_id = watcher.expect("screen-share-available").await["publisherId"].as_str().unwrap().to_string();
    let token = publisher.screen_token.lock().unwrap().clone().unwrap();

    // A live owner keeps the token: another peer can't take the share.
    let (mut thief, _) = Ws::join(port, &e.room, &c, "thief", "cthief", false).await;
    thief.send("screen-share-resume", json!({ "sessionToken": token })).await;
    assert_eq!(thief.expect("screen-share-error").await, json!({ "reason": "invalid-token" }));

    // Unknown token next.
    let (mut fresh, _) = Ws::join(port, &e.room, &c, "p0", "c0", false).await;
    fresh.send("screen-share-resume", json!({ "sessionToken": "bogus" })).await;
    assert_eq!(fresh.expect("screen-share-error").await, json!({ "reason": "invalid-token" }));
    // The same clientId just evicted the old publisher session; its share
    // waits for a resume instead of ending.
    publisher.drop_ws();
    fresh.send("screen-share-resume", json!({ "sessionToken": token })).await;
    assert_eq!(fresh.expect("screen-share-started").await["sessionToken"], token.as_str());
    assert_eq!(watcher.expect("screen-share-ended").await["publisherId"], old_id.as_str());
    let new_av = watcher.expect("screen-share-available").await;
    assert_ne!(new_av["publisherId"], old_id.as_str());
    let p = roster(&e);
    assert!(p.iter().any(|p| p.display_name == "p0" && p.screen_sharing));

    // The resumed publisher restarts ICE on its surviving screen PC (new
    // ufrag on both sides); media must keep flowing to a new viewer.
    let offer = publisher.screen_ice_restart_offer().unwrap();
    fresh.send("offer", json!({ "pc": "screen-pub", "type": "offer", "sdp": offer })).await;
    let answer = fresh.expect("answer").await;
    assert!(publisher.screen_accept_answer(answer["sdp"].as_str().unwrap()));
    let new_ufrag = answer["sdp"].as_str().unwrap().lines().find_map(|l| l.strip_prefix("a=ice-ufrag:")).unwrap().trim().to_string();
    let session = e.live_room(&e.room).unwrap().find_session(&token).unwrap();
    assert!(session.publisher_pc.routes_ufrag(&new_ufrag), "STUN with the restarted ufrag reaches the publisher PC");
    let viewer = peer(&t, &e.room, 5, true, 2).await;
    fresh.expect("screen-share-encode-resume").await;
    publisher.set_screen_paused(false);
    for f in 10..200 {
        publisher.send_screen_frame(f, 2000, &mut seq);
        tokio::time::sleep(Duration::from_millis(20)).await;
        if viewer.stats.video_frames.load(std::sync::atomic::Ordering::Relaxed) > 10 {
            break;
        }
    }
    assert!(viewer.stats.video_frames.load(std::sync::atomic::Ordering::Relaxed) > 10, "video after ICE restart");
}

/// The slot announcement travels over WS, media over UDP, so a voice's first
/// packets can beat it. How many depends on scheduling, not on the SFU: the
/// bound only has to catch an announcement that never arrives (each voice
/// sends at least 15 packets).
const UNANNOUNCED_HEAD_MAX: u64 = 10;

#[tokio::test(flavor = "multi_thread")]
async fn churn_reassigns_slots_without_renegotiation() {
    let (e, port, c) = served().await;
    let t = target(port, c);
    let a = peer(&t, &e.room, 0, false, 2).await;
    let b = peer(&t, &e.room, 1, false, 2).await;
    until("both joined", || a.joined() && b.joined()).await;
    let mut ids = HashMap::from([(0, a.id.get().unwrap().clone()), (1, b.id.get().unwrap().clone())]);
    let mut n = 0;
    for round in 0..12u32 {
        let churner = peer(&t, &e.room, 10 + round, false, 2).await;
        for _ in 0..15 {
            for p in [&a, &b, &churner] {
                p.send_audio(true, n * 960);
            }
            n += 1;
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        ids.insert(10 + round, churner.id.get().cloned().unwrap_or_default());
        churner.close();
        until("churner gone", || roster(&e).len() == 2).await;
    }
    let heard = a.stats.audio.lock().unwrap().get(&1).map(|s| s.count).unwrap_or(0);
    for _ in 0..30 {
        b.send_audio(true, n * 960);
        n += 1;
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    until("A still hears B after churn", || a.stats.audio.lock().unwrap().get(&1).is_some_and(|s| s.count > heard + 15)).await;

    for p in [&a, &b] {
        assert_eq!(p.stats.audio_offers.load(std::sync::atomic::Ordering::Relaxed), 1, "joins and leaves never renegotiate");
        assert_eq!(p.audio_mlines.load(std::sync::atomic::Ordering::Relaxed), 1 + 8, "mic + initial slot pool");
        let owners = p.stats.slot_owners.lock().unwrap();
        assert!(!owners.is_empty());
        for ((owner, publisher), count) in owners.iter() {
            if owner.is_empty() && *count <= UNANNOUNCED_HEAD_MAX {
                continue;
            }
            assert_eq!(owner, &ids[publisher], "{count} packets of publisher {publisher} arrived in a slot announced for {owner:?}");
        }
        assert_eq!(p.stats.audio.lock().unwrap().values().map(|s| s.lost()).sum::<u64>(), 0);
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn slot_pool_grows_past_initial_size() {
    let (e, port, c) = served().await;
    let t = target(port, c);
    let mut peers = Vec::new();
    for i in 0..11 {
        peers.push(peer(&t, &e.room, i, false, 2).await);
    }
    until("all joined", || roster(&e).len() == 11).await;
    for n in 0..60u32 {
        for p in &peers {
            p.send_audio(true, n * 960);
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    until("everyone hears the other ten", || {
        peers.iter().all(|p| p.stats.audio.lock().unwrap().values().filter(|s| s.count > 10).count() == 10)
    })
    .await;
    for p in &peers {
        assert!(p.stats.audio_offers.load(std::sync::atomic::Ordering::Relaxed) <= 2, "one growth step at most");
        let owners = p.stats.slot_owners.lock().unwrap();
        assert!(owners.iter().all(|((o, _), c)| !o.is_empty() || *c <= UNANNOUNCED_HEAD_MAX), "{owners:?}");
    }
    // The first eight joiners grew from 8 to 12 slots once.
    assert_eq!(peers[0].audio_mlines.load(std::sync::atomic::Ordering::Relaxed), 1 + 12);
}

/// Sends 30 fps camera frames until aborted.
fn camera_feed(p: &Arc<ClientPeer>) -> tokio::task::JoinHandle<()> {
    let p = p.clone();
    tokio::spawn(async move {
        let (mut frame, mut seq) = (0u32, 1u64);
        loop {
            if p.send_camera_frame(frame, 2000, &mut seq) {
                frame += 1;
            }
            tokio::time::sleep(Duration::from_millis(33)).await;
        }
    })
}

/// Publishers `viewer` holds camera subscriber PCs for, as the server sees it.
fn camera_subs(e: &Env, viewer: &str) -> Vec<String> {
    let Some(room) = e.live_room(&e.room) else { return Vec::new() };
    room.state.lock().unwrap().peers.get(viewer).map(|en| en.camera_subs.keys().cloned().collect()).unwrap_or_default()
}

fn live_camera_session(e: &Env, publisher: &str) -> Arc<super::camera::CameraSession> {
    let room = e.live_room(&e.room).unwrap();
    let st = room.state.lock().unwrap();
    st.peers[publisher].camera_session.clone().unwrap()
}

/// A browser-like camera offer: one sendonly VP8 video m-line.
fn vp8_offer() -> String {
    let mut rtc = str0m::RtcConfig::new().clear_codecs().enable_vp8(true).build(std::time::Instant::now());
    let mut api = rtc.sdp_api();
    api.add_media(str0m::media::MediaKind::Video, str0m::media::Direction::SendOnly, None, None, None);
    api.apply().unwrap().0.to_sdp_string()
}

fn camera_frames(p: &ClientPeer) -> u64 {
    p.stats.camera_frames.load(std::sync::atomic::Ordering::Relaxed)
}

#[tokio::test(flavor = "multi_thread")]
async fn camera_publish_subscribe_and_stop() {
    let (e, port, c) = served().await;
    let t = target(port, c.clone());
    let publisher = peer(&t, &e.room, 0, false, 2).await;
    let viewer = peer(&t, &e.room, 1, true, 2).await;
    let (mut raw, _) = Ws::join(port, &e.room, &c, "observer", "cobs", false).await;
    until("all joined", || roster(&e).len() == 3 && publisher.joined() && viewer.joined()).await;
    let (pub_id, viewer_id) = (publisher.id.get().unwrap().clone(), viewer.id.get().unwrap().clone());

    publisher.start_camera().await.unwrap();
    let feed = camera_feed(&publisher);
    let info = raw.expect("peer-info").await;
    assert_eq!((info["id"].as_str(), info["cameraOn"].as_bool()), (Some(pub_id.as_str()), Some(true)));
    assert_eq!(raw.expect("camera-available").await, json!({ "publisherId": pub_id }));

    until("viewer gets frames", || camera_frames(&viewer) > 20).await;
    assert_eq!(viewer.stats.camera.lock().unwrap()[&0].lost(), 0, "renumbered without gaps");
    assert!(publisher.stats.keyframe_requests.load(std::sync::atomic::Ordering::Relaxed) > 0, "subscribe asks for a keyframe");
    assert_eq!(camera_subs(&e, &viewer_id), std::slice::from_ref(&pub_id));

    // A second start with a valid offer is ignored; the late joiner sees the
    // camera in its welcome.
    let first = live_camera_session(&e, &pub_id);
    publisher.raw("camera-start", json!({ "sdp": vp8_offer() }));
    let mut late = Ws::open(port, &c, &e.room).await;
    late.send("hello", json!({ "displayName": "late", "clientId": "clate" })).await;
    let welcome = late.expect("welcome").await;
    assert!(welcome["peers"].as_array().unwrap().iter().any(|p| p["id"] == pub_id.as_str() && p["cameraOn"] == true), "{welcome}");

    assert!(Arc::ptr_eq(&first, &live_camera_session(&e, &pub_id)), "second start replaced the session");

    viewer.unsubscribe_camera(&pub_id);
    until("subscription removed", || camera_subs(&e, &viewer_id).is_empty()).await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    let frozen = camera_frames(&viewer);
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(camera_frames(&viewer), frozen, "nothing forwarded after unsubscribe");

    viewer.raw("camera-subscribe", json!({ "publisherId": pub_id }));
    until("re-subscribed viewer gets frames", || camera_frames(&viewer) > frozen + 10).await;

    publisher.stop_camera();
    assert_eq!(raw.expect("camera-ended").await, json!({ "publisherId": pub_id }));
    let info = raw.expect("peer-info").await;
    assert_eq!(info["id"], pub_id.as_str());
    assert!(info.get("cameraOn").is_none(), "{info}");
    assert!(camera_subs(&e, &viewer_id).is_empty());
    assert!(roster(&e).iter().all(|p| !p.camera_on));
    feed.abort();
}

#[tokio::test(flavor = "multi_thread")]
async fn camera_ends_with_its_publisher() {
    let (e, port, c) = served().await;
    let t = target(port, c.clone());
    let (mut raw, _) = Ws::join(port, &e.room, &c, "observer", "cobs", false).await;
    let viewer = peer(&t, &e.room, 1, true, 2).await;

    // WS loss: the camera ends before the peer leaves; no grace.
    let a = peer(&t, &e.room, 0, false, 2).await;
    a.start_camera().await.unwrap();
    let feed = camera_feed(&a);
    let a_id = raw.expect("camera-available").await["publisherId"].as_str().unwrap().to_string();
    until("viewer gets frames", || camera_frames(&viewer) > 5).await;
    a.drop_ws();
    assert_eq!(raw.expect("camera-ended").await, json!({ "publisherId": a_id }));
    assert_eq!(raw.expect("peer-left").await, json!({ "id": a_id }));
    feed.abort();
    a.close();
    until("viewer's subscription gone", || camera_subs(&e, viewer.id.get().unwrap()).is_empty()).await;

    // Eviction by a reconnect with the same clientId ends it too.
    let b = peer(&t, &e.room, 2, false, 2).await;
    b.start_camera().await.unwrap();
    let feed = camera_feed(&b);
    let b_id = raw.expect("camera-available").await["publisherId"].as_str().unwrap().to_string();
    let (_b2, _) = Ws::join(port, &e.room, &c, "p2", "c2", false).await;
    assert_eq!(raw.expect("peer-left").await, json!({ "id": b_id }));
    assert_eq!(raw.expect("camera-ended").await, json!({ "publisherId": b_id }));
    feed.abort();
    b.close();
    assert!(roster(&e).iter().all(|p| !p.camera_on));
}
