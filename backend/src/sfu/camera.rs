//! Camera video. Screen share's two-PC shape (the SFU answers the
//! publisher, offers each viewer its own PC) without resume, audio, modes or
//! layer control: one VP8 layer, every packet forwarded, bitrate left to the
//! publisher's congestion control.
//!
//! Lifecycle: camera-start → answer → first video packet → camera-available
//! to the room. Stop, publisher leave and publisher PC failure end it at once.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock, RwLock, Weak};

use str0m::Event;
use str0m::change::{SdpAnswer, SdpOffer, SdpPendingOffer};
use str0m::format::Codec;
use str0m::media::{Direction, KeyframeRequestKind, MediaKind, Mid, Pt};
use str0m::rtp::{RtpPacket, RtpWrite, SeqNo};

use super::net::{Pc, PcHandler};
use super::protocol::{self, PcKind};
use super::rtc::{self, PT_VP8};
use super::screen::{sdp_msg, sections};
use super::{Peer, Room, broadcast, msg};
use crate::log;
use crate::util::random_u32;

pub struct CameraSession {
    publisher_id: String,
    pub publisher_pc: Arc<Pc>,
    room: Weak<Room>,
    me: Weak<CameraSession>,
    inner: Mutex<SessionInner>,
    /// Copy-on-write view of `inner.subscribers` for the RTP hot path.
    view: RwLock<Arc<Vec<Arc<CameraSub>>>>,
    /// Set before the answer goes out, so before any media arrives.
    media: OnceLock<PubMedia>,
    first_video: AtomicBool,
}

struct PubMedia {
    video_mid: Mid,
    video_pts: Vec<Pt>,
}

#[derive(Default)]
struct SessionInner {
    subscribers: HashMap<String, Arc<CameraSub>>,
    closed: bool,
}

pub struct CameraSub {
    peer_id: String,
    pub pc: Arc<Pc>,
    session: Weak<CameraSession>,
    video_mid: Mid,
    pending: Mutex<Option<SdpPendingOffer>>,
    /// Rewritten per subscriber: each viewer's sequence space starts fresh.
    seq: AtomicU64,
}

impl CameraSub {
    fn forward(&self, pkt: &RtpPacket) {
        let seq = self.seq.fetch_add(1, Ordering::Relaxed) + 1;
        let mid = self.video_mid;
        self.pc.write(|rtc| {
            if let Some(tx) = rtc.direct_api().stream_tx_by_mid(mid, None) {
                tx.write_rtp(
                    RtpWrite::new(Pt::new_with_value(PT_VP8), SeqNo::from(seq), pkt.header.timestamp, pkt.timestamp, pkt.payload.clone())
                        .marker(pkt.header.marker)
                        .nackable(true),
                );
            }
        });
    }
}

impl PcHandler for CameraSub {
    fn on_event(&self, _pc: &Arc<Pc>, ev: Event) {
        // Relay viewer PLIs to the publisher.
        if let Event::KeyframeRequest(_) = ev
            && let Some(s) = self.session.upgrade()
        {
            s.request_keyframe();
        }
    }

    fn on_closed(&self, pc: &Arc<Pc>) {
        let Some(s) = self.session.upgrade() else { return };
        let Some(room) = s.room.upgrade() else { return };
        room.remove_camera_sub(&self.peer_id, &s.publisher_id, Some(pc), "subscriber pc closed");
    }
}

impl CameraSession {
    fn subscribers(&self) -> Arc<Vec<Arc<CameraSub>>> {
        self.view.read().unwrap().clone()
    }

    fn refresh_view(&self, inner: &SessionInner) {
        *self.view.write().unwrap() = Arc::new(inner.subscribers.values().cloned().collect());
    }

    /// PLI to the publisher so the next frame is a keyframe.
    fn request_keyframe(&self) {
        let Some(m) = self.media.get() else { return };
        let mid = m.video_mid;
        self.publisher_pc.write(|rtc| {
            if let Some(rx) = rtc.direct_api().stream_rx_by_mid(mid, None) {
                rx.request_keyframe(KeyframeRequestKind::Pli);
            }
        });
    }

    fn on_video(&self, pkt: &RtpPacket) {
        if !self.first_video.swap(true, Ordering::AcqRel) {
            // The SFU renumbers by arrival and never asks the publisher for
            // retransmissions.
            let ssrc = pkt.header.ssrc;
            self.publisher_pc.write(|rtc| {
                if let Some(rx) = rtc.direct_api().stream_rx(&ssrc) {
                    rx.suppress_nack(true);
                }
            });
            if let Some(room) = self.room.upgrade() {
                room.first_camera_video_ready(self);
            }
        }
        for sub in self.subscribers().iter() {
            sub.forward(pkt);
        }
    }
}

impl PcHandler for CameraSession {
    fn on_event(&self, _pc: &Arc<Pc>, ev: Event) {
        let Event::RtpPacket(pkt) = ev else { return };
        if pkt.payload.is_empty() {
            return; // padding-only probe
        }
        if self.media.get().is_some_and(|m| m.video_pts.contains(&pkt.header.payload_type)) {
            self.on_video(&pkt);
        }
    }

    fn on_closed(&self, _pc: &Arc<Pc>) {
        // Ending the session closes the subscriber PCs; a PC handler must not
        // drive other PCs synchronously.
        let (Some(room), Some(me)) = (self.room.upgrade(), self.me.upgrade()) else { return };
        tokio::spawn(async move { room.end_camera_session(&me, "publisher pc closed") });
    }
}

/// The first accepted video section and its VP8 payload types.
fn video_section(rtc: &str0m::Rtc, answer: &str) -> Option<PubMedia> {
    let s = sections(answer).into_iter().find(|s| s.kind == "video" && !s.rejected)?;
    let video_pts: Vec<Pt> =
        s.pts.iter().map(|&v| Pt::new_with_value(v)).filter(|&pt| rtc::codec_of_pt(rtc, pt) == Some(Codec::Vp8)).collect();
    (!video_pts.is_empty()).then(|| PubMedia { video_mid: Mid::from(s.mid.as_str()), video_pts })
}

impl Room {
    pub(super) fn handle_camera_start(&self, p: &Arc<Peer>, data: protocol::CameraStart) {
        if self.state.lock().unwrap().peers.get(&p.id).is_some_and(|e| e.camera_session.is_some()) {
            log!("sfu: camera-start ({}): already publishing", p.id);
            return;
        }
        let Some((session, answer)) = self.setup_camera_pub(p, &data.sdp) else { return };
        let registered = {
            let mut st = self.state.lock().unwrap();
            match st.peers.get_mut(&p.id) {
                Some(e) if e.camera_session.is_none() => {
                    e.camera_session = Some(session.clone());
                    true
                }
                _ => false,
            }
        };
        if !registered {
            // Closed first, so its PC teardown doesn't announce camera-ended
            // for the session that won.
            session.inner.lock().unwrap().closed = true;
            session.publisher_pc.close();
            return;
        }
        p.send_event("answer", &sdp_msg(PcKind::CameraPub, "", "answer", answer));
    }

    /// Creates the publisher PC and answers the offer; a VP8 video section
    /// is required.
    fn setup_camera_pub(&self, p: &Arc<Peer>, sdp: &str) -> Option<(Arc<CameraSession>, String)> {
        let offer = match SdpOffer::from_sdp_string(sdp) {
            Ok(o) => o,
            Err(e) => {
                log!("sfu: camera-start ({}) set remote: {e}", p.id);
                return None;
            }
        };
        let socket = self.cfg.mux.pick();
        let (rtc, ufrag) = rtc::build_camera(&socket);
        let session = Arc::new_cyclic(|me: &Weak<CameraSession>| {
            let handler: Weak<dyn PcHandler> = me.clone();
            CameraSession {
                publisher_id: p.id.clone(),
                publisher_pc: Pc::spawn(rtc, socket, ufrag, handler),
                room: self.me.clone(),
                me: me.clone(),
                inner: Mutex::default(),
                view: RwLock::new(Arc::new(Vec::new())),
                media: OnceLock::new(),
                first_video: AtomicBool::new(false),
            }
        });
        let answer = session.publisher_pc.with(|rtc| {
            let sdp = rtc.sdp_api().accept_offer(offer)?.to_sdp_string();
            Ok::<_, str0m::RtcError>((video_section(rtc, &sdp), sdp))
        });
        // No media can arrive before the client has the answer.
        match answer {
            Ok((Some(media), sdp)) => {
                let _ = session.media.set(media);
                Some((session, sdp))
            }
            Ok((None, _)) => {
                log!("sfu: camera-start ({}) no video transceiver in offer", p.id);
                session.publisher_pc.close();
                None
            }
            Err(e) => {
                log!("sfu: camera-start ({}) set remote: {e}", p.id);
                session.publisher_pc.close();
                None
            }
        }
    }

    /// Once per session, on the first video packet: tell the room media is
    /// actually flowing.
    fn first_camera_video_ready(&self, session: &CameraSession) {
        if session.inner.lock().unwrap().closed {
            return;
        }
        let (info, others) = {
            let st = self.state.lock().unwrap();
            let Some(e) = st.peers.get(&session.publisher_id) else { return };
            (e.info(), Self::others(&st, &session.publisher_id))
        };
        let info_msg = msg("peer-info", &info);
        let avail = msg("camera-available", &protocol::CameraPublisher { publisher_id: &session.publisher_id });
        for op in &others {
            op.send(&info_msg);
            op.send(&avail);
        }
        self.hooks_updated(&info);
    }

    pub(super) fn handle_camera_stop(&self, p: &Arc<Peer>) {
        let session = self.state.lock().unwrap().peers.get(&p.id).and_then(|e| e.camera_session.clone());
        if let Some(s) = session {
            self.end_camera_session(&s, "publisher requested stop");
        }
    }

    /// Closes the publisher and every subscriber PC, broadcasts camera-ended
    /// and clears the publisher's flag. Idempotent.
    pub(super) fn end_camera_session(&self, session: &Arc<CameraSession>, reason: &str) {
        let subs = {
            let mut inner = session.inner.lock().unwrap();
            if inner.closed {
                return;
            }
            inner.closed = true;
            let subs: Vec<Arc<CameraSub>> = inner.subscribers.drain().map(|(_, s)| s).collect();
            session.refresh_view(&inner);
            subs
        };
        session.publisher_pc.close();
        let pub_id = &session.publisher_id;
        for s in &subs {
            s.pc.close();
        }
        let (info, all) = {
            let mut st = self.state.lock().unwrap();
            for s in &subs {
                if let Some(e) = st.peers.get_mut(&s.peer_id)
                    && e.camera_subs.get(pub_id).is_some_and(|c| Arc::ptr_eq(c, s))
                {
                    e.camera_subs.remove(pub_id);
                }
            }
            let info = st.peers.get_mut(pub_id).map(|e| {
                if e.camera_session.as_ref().is_some_and(|s| Arc::ptr_eq(s, session)) {
                    e.camera_session = None;
                }
                e.info()
            });
            (info, Self::all(&st))
        };
        let ended = msg("camera-ended", &protocol::CameraPublisher { publisher_id: pub_id });
        match info {
            Some(info) => {
                let info_msg = msg("peer-info", &info);
                for op in &all {
                    op.send(&ended);
                    if op.id != info.id {
                        op.send(&info_msg);
                    }
                }
                self.hooks_updated(&info);
            }
            None => broadcast(&all, &ended),
        }
        log!("sfu: camera ended publisher={pub_id} reason={reason}");
    }

    pub(super) fn handle_camera_subscribe(&self, sub: &Arc<Peer>, publisher_id: &str) {
        let session = {
            let st = self.state.lock().unwrap();
            let Some(session) = st.peers.get(publisher_id).and_then(|e| e.camera_session.clone()) else {
                log!("sfu: camera-subscribe ({}→{publisher_id}) no session", sub.id);
                return;
            };
            if st.peers.get(&sub.id).is_some_and(|e| e.camera_subs.contains_key(publisher_id)) {
                log!("sfu: camera-subscribe ({}→{publisher_id}) duplicate, ignoring", sub.id);
                return;
            }
            session
        };
        let pub_id = session.publisher_id.as_str();
        let socket = self.cfg.mux.pick();
        let (rtc, ufrag) = rtc::build_camera(&socket);
        let mut offer = None;
        let entry = Arc::new_cyclic(|me: &Weak<CameraSub>| {
            let handler: Weak<dyn PcHandler> = me.clone();
            let pc = Pc::spawn(rtc, socket, ufrag, handler);
            let (video_mid, o) = pc.with(|rtc| {
                let mut api = rtc.sdp_api();
                let v = api.add_media(MediaKind::Video, Direction::SendOnly, Some(pub_id.to_string()), Some("camera-video".into()), None);
                (v, api.apply())
            });
            let pending = o.map(|(offer_sdp, pending)| {
                offer = Some(offer_sdp.to_sdp_string());
                pending
            });
            CameraSub {
                peer_id: sub.id.clone(),
                pc,
                session: Arc::downgrade(&session),
                video_mid,
                pending: Mutex::new(pending),
                seq: AtomicU64::new((random_u32() & 0xffff) as u64),
            }
        });
        let Some(offer) = offer else {
            log!("sfu: camera subscribe ({}→{pub_id}) create offer failed", sub.id);
            entry.pc.close();
            return;
        };
        // The peer's entry goes first: once the session holds the sub, an
        // ending session closes its PC and on_closed must find the entry.
        let attached = {
            let mut st = self.state.lock().unwrap();
            match st.peers.get_mut(&sub.id) {
                Some(e) if !e.camera_subs.contains_key(pub_id) => {
                    e.camera_subs.insert(pub_id.to_string(), entry.clone());
                    true
                }
                _ => false,
            }
        };
        if !attached {
            entry.pc.close();
            return;
        }
        let open = {
            let mut inner = session.inner.lock().unwrap();
            if inner.closed {
                false
            } else {
                inner.subscribers.insert(sub.id.clone(), entry.clone());
                session.refresh_view(&inner);
                true
            }
        };
        if !open {
            self.remove_camera_sub(&sub.id, pub_id, Some(&entry.pc), "session ended");
            return;
        }
        sub.send_event("offer", &sdp_msg(PcKind::CameraSub, pub_id, "offer", offer));
        session.request_keyframe();
        log!("sfu: camera subscribe sub={} pub={pub_id}", sub.id);
    }

    pub(super) fn camera_sub_answer(&self, p: &Arc<Peer>, publisher_id: &str, sdp: &str) {
        let Some(sub) = self.state.lock().unwrap().peers.get(&p.id).and_then(|e| e.camera_subs.get(publisher_id).cloned()) else {
            log!("sfu: camera-sub answer ({}→{publisher_id}) no PC", p.id);
            return;
        };
        let Some(pending) = sub.pending.lock().unwrap().take() else {
            log!("sfu: camera-sub set remote ({}→{publisher_id}): no offer pending", p.id);
            return;
        };
        let r = SdpAnswer::from_sdp_string(sdp)
            .map_err(|e| e.to_string())
            .and_then(|a| sub.pc.with(|rtc| rtc.sdp_api().accept_answer(pending, a)).map_err(|e| e.to_string()));
        if let Err(e) = r {
            log!("sfu: camera-sub set remote ({}→{publisher_id}): {e}", p.id);
        }
    }

    /// Tears down a viewer's PC for one publisher. Idempotent; `only` limits
    /// the teardown to that exact PC so a stale close can't kill a newer
    /// subscription.
    pub(super) fn remove_camera_sub(&self, sub_id: &str, publisher_id: &str, only: Option<&Arc<Pc>>, reason: &str) {
        let matches = |s: &Arc<CameraSub>| only.is_none_or(|pc| Arc::ptr_eq(&s.pc, pc));
        let (sub, session) = {
            let mut st = self.state.lock().unwrap();
            let sub = st
                .peers
                .get_mut(sub_id)
                .and_then(|e| if e.camera_subs.get(publisher_id).is_some_and(matches) { e.camera_subs.remove(publisher_id) } else { None });
            let session = st.peers.get(publisher_id).and_then(|e| e.camera_session.clone());
            (sub, session)
        };
        if let Some(s) = &sub {
            s.pc.close();
        }
        if let Some(session) = &session {
            let mut inner = session.inner.lock().unwrap();
            let removed = if inner.subscribers.get(sub_id).is_some_and(matches) { inner.subscribers.remove(sub_id) } else { None };
            if removed.is_some() {
                session.refresh_view(&inner);
            }
            // Closing re-enters this function via the PC's on_closed.
            drop(inner);
            if let Some(s) = removed {
                s.pc.close();
            }
        }
        log!("sfu: camera unsubscribe ({sub_id}→{publisher_id}) {reason}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn video_section_keeps_vp8_only() {
        let mux = super::super::net::Mux::bind("127.0.0.1".parse().unwrap(), 0, 0).await.unwrap();
        let (rtc, _) = rtc::build_camera(&mux.pick());
        let m = video_section(
            &rtc,
            "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=mid:0\r\nm=video 0 UDP/TLS/RTP/SAVPF 96\r\na=mid:1\r\nm=video 9 UDP/TLS/RTP/SAVPF 96 97\r\na=mid:2\r\n",
        )
        .unwrap();
        assert_eq!((m.video_mid, m.video_pts), (Mid::from("2"), vec![Pt::new_with_value(PT_VP8)]), "RTX is not media");
        assert!(video_section(&rtc, "v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 98\r\na=mid:0\r\n").is_none(), "no VP8, no camera");
        mux.close();
    }
}
