package sfu

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"sync"
	"sync/atomic"

	"github.com/pion/rtcp"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"

	"sozvon-hub/backend/internal/sfu/protocol"
)

// CameraSession owns one publisher's camera video. It is the camera analogue of
// ScreenShareSession, deliberately simpler: single VP8 layer, no audio, no
// resume token, no dynacast, no temporal-layer filtering. The SFU forwards every
// inbound packet verbatim to each subscriber's per-sub track (rewriting the RTP
// sequence number so wire loss, not deliberate drops, is what surfaces as gaps)
// and relies on GCC/TWCC for bitrate control.
//
// Concurrency mirrors ScreenShareSession: fields set at setup are read-only
// thereafter; subscribers is guarded by mu and snapshotted under RLock on the
// forward path to avoid pion-internal lock crossover.
type CameraSession struct {
	PublisherID string

	// videoCodec is the negotiated camera codec capability captured at start.
	// Per-subscriber tracks are minted from this template at subscribe time.
	videoCodec webrtc.RTPCodecCapability

	publisherPC *webrtc.PeerConnection
	room        *Room

	// publisherVideoSSRC is the SSRC of the publisher's inbound video track,
	// set once in OnTrack. Used to retarget forwarded PLI/FIR.
	publisherVideoSSRC atomic.Uint32

	mu          sync.RWMutex
	subscribers map[string]*cameraSubscriber // key = subscriber peer ID

	ctx    context.Context
	cancel context.CancelFunc
	closed bool
}

// cameraSubscriber holds per-subscriber forward state. videoTrack is per-sub so
// each viewer's RTP sequence space is independent; seqCounter rewrites it.
type cameraSubscriber struct {
	peerID      string
	pc          *webrtc.PeerConnection
	videoTrack  *webrtc.TrackLocalStaticRTP
	videoSender *webrtc.RTPSender

	seqCounter atomic.Uint32
	outPkt     rtp.Packet
}

// cameraSubPC is the per-publisher subscriber-side bookkeeping a subscriber peer
// keeps; the publisher ID lives in the cameraSubs map key.
type cameraSubPC struct {
	pc *webrtc.PeerConnection
}

// handleCameraStart is the entry point for a publisher's camera-start. It
// creates a dedicated camera-pub PC, answers the offer, wires callbacks, and on
// first OnTrack broadcasts camera-available.
func (r *Room) handleCameraStart(p *peer, data protocol.CameraStartData) {
	r.mu.Lock()
	if p.cameraSession != nil {
		r.mu.Unlock()
		log.Printf("sfu: camera-start (%s): already publishing", p.id)
		return
	}
	r.mu.Unlock()

	session, answer, err := r.setupCameraPubPC(p, data)
	if err != nil {
		return
	}

	r.wireCameraPubCallbacks(p, session.publisherPC, session)

	r.mu.Lock()
	p.cameraSession = session
	p.cameraOn = true
	r.mu.Unlock()

	answerData, err := json.Marshal(protocol.AnswerEnvelope{
		PC:                 protocol.PCCameraPub,
		SessionDescription: answer,
	})
	if err != nil {
		log.Printf("sfu: camera-start (%s) marshal answer: %v", p.id, err)
		r.endCameraSession(session, "marshal answer failed")
		return
	}
	_ = p.write(protocol.Envelope{Event: "answer", Data: answerData})
}

// setupCameraPubPC creates the publisher PC, performs the SDP exchange, and
// builds the CameraSession. On any error the PC is closed and the caller must
// return immediately.
func (r *Room) setupCameraPubPC(p *peer, data protocol.CameraStartData) (session *CameraSession, answer webrtc.SessionDescription, err error) {
	r.pcCreateMu.Lock()
	r.pendingBWE = nil
	pc, err := r.api.NewPeerConnection(webrtc.Configuration{ICEServers: r.cfg.ICEServers})
	r.pendingBWE = nil
	r.pcCreateMu.Unlock()
	if err != nil {
		log.Printf("sfu: camera-start (%s) new pc: %v", p.id, err)
		return nil, webrtc.SessionDescription{}, err
	}

	ctx, cancel := context.WithCancel(p.ctx)
	defer func() {
		if err != nil {
			pc.Close()
			cancel()
		}
	}()

	session = &CameraSession{
		PublisherID: p.id,
		publisherPC: pc,
		room:        r,
		subscribers: make(map[string]*cameraSubscriber),
		ctx:         ctx,
		cancel:      cancel,
	}

	offer := webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: data.SDP}
	if err = pc.SetRemoteDescription(offer); err != nil {
		log.Printf("sfu: camera-start (%s) set remote: %v", p.id, err)
		return nil, webrtc.SessionDescription{}, err
	}
	answer, err = pc.CreateAnswer(nil)
	if err != nil {
		log.Printf("sfu: camera-start (%s) create answer: %v", p.id, err)
		return nil, webrtc.SessionDescription{}, err
	}
	if err = pc.SetLocalDescription(answer); err != nil {
		log.Printf("sfu: camera-start (%s) set local: %v", p.id, err)
		return nil, webrtc.SessionDescription{}, err
	}

	for _, tr := range pc.GetTransceivers() {
		recv := tr.Receiver()
		if recv == nil {
			continue
		}
		track := recv.Track()
		if track == nil || track.Kind() != webrtc.RTPCodecTypeVideo {
			continue
		}
		params := recv.GetParameters()
		if len(params.Codecs) == 0 {
			continue
		}
		session.videoCodec = params.Codecs[0].RTPCodecCapability
	}
	if session.videoCodec.MimeType == "" {
		log.Printf("sfu: camera-start (%s) no video transceiver in offer", p.id)
		err = errors.New("no video transceiver")
		return nil, webrtc.SessionDescription{}, err
	}

	return session, answer, nil
}

// wireCameraPubCallbacks registers the publisher PC event callbacks.
func (r *Room) wireCameraPubCallbacks(p *peer, pc *webrtc.PeerConnection, session *CameraSession) {
	pc.OnConnectionStateChange(func(s webrtc.PeerConnectionState) {
		switch s {
		case webrtc.PeerConnectionStateFailed, webrtc.PeerConnectionStateClosed:
			r.endCameraSession(session, "publisher pc closed")
		}
	})

	pc.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c == nil {
			return
		}
		b, err := json.Marshal(protocol.CandidateEnvelope{
			PC:               protocol.PCCameraPub,
			ICECandidateInit: c.ToJSON(),
		})
		if err != nil {
			return
		}
		_ = p.write(protocol.Envelope{Event: "candidate", Data: b})
	})

	pc.OnTrack(func(remote *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		if remote.Kind() != webrtc.RTPCodecTypeVideo {
			return
		}
		session.publisherVideoSSRC.Store(uint32(remote.SSRC()))
		r.firstCameraVideoReady(p, session)
		session.forwardVideo(remote)
	})
}

// firstCameraVideoReady runs on the first video OnTrack: updates the publisher's
// PeerInfo and broadcasts peer-info + camera-available so subscribers render a
// tile only once media is actually flowing.
func (r *Room) firstCameraVideoReady(p *peer, session *CameraSession) {
	session.mu.Lock()
	if session.closed {
		session.mu.Unlock()
		return
	}
	session.mu.Unlock()

	r.mu.Lock()
	others := make([]*peer, 0, len(r.peers))
	for _, op := range r.peers {
		if op.id != p.id {
			others = append(others, op)
		}
	}
	info := peerInfo(p)
	r.mu.Unlock()

	infoData, _ := json.Marshal(info)
	infoEnv, _ := json.Marshal(protocol.Envelope{Event: "peer-info", Data: infoData})
	availData, _ := json.Marshal(protocol.CameraAvailableData{PublisherID: session.PublisherID})
	availEnv, _ := json.Marshal(protocol.Envelope{Event: "camera-available", Data: availData})

	for _, op := range others {
		_ = op.writeRaw(infoEnv)
		_ = op.writeRaw(availEnv)
	}
	if r.cfg.OnPeerUpdated != nil {
		r.cfg.OnPeerUpdated(info)
	}
}

// handleCameraStop is the publisher-initiated teardown path.
func (r *Room) handleCameraStop(p *peer) {
	r.mu.Lock()
	session := p.cameraSession
	r.mu.Unlock()
	if session == nil {
		return
	}
	r.endCameraSession(session, "publisher requested stop")
}

// endCameraSession closes the publisher PC and all subscriber PCs, broadcasts
// camera-ended, and clears the publisher's cameraOn flag. Idempotent via
// session.closed.
func (r *Room) endCameraSession(session *CameraSession, reason string) {
	session.mu.Lock()
	if session.closed {
		session.mu.Unlock()
		return
	}
	session.closed = true
	subs := make([]*cameraSubscriber, 0, len(session.subscribers))
	for _, s := range session.subscribers {
		subs = append(subs, s)
	}
	session.subscribers = nil
	session.mu.Unlock()

	_ = session.publisherPC.Close()
	session.cancel()

	for _, s := range subs {
		_ = s.pc.Close()
		r.mu.Lock()
		if subPeer, ok := r.peers[s.peerID]; ok && subPeer.cameraSubs != nil {
			delete(subPeer.cameraSubs, session.PublisherID)
		}
		r.mu.Unlock()
	}

	r.mu.Lock()
	pubPeer := r.peers[session.PublisherID]
	var info protocol.PeerInfo
	var havePubInfo bool
	if pubPeer != nil && pubPeer.cameraSession == session {
		pubPeer.cameraSession = nil
		pubPeer.cameraOn = false
	}
	if pubPeer != nil {
		info = peerInfo(pubPeer)
		havePubInfo = true
	}
	others := make([]*peer, 0, len(r.peers))
	for _, op := range r.peers {
		others = append(others, op)
	}
	r.mu.Unlock()

	endedData, _ := json.Marshal(protocol.CameraEndedData{PublisherID: session.PublisherID})
	endedEnv, _ := json.Marshal(protocol.Envelope{Event: "camera-ended", Data: endedData})

	if havePubInfo {
		infoData, _ := json.Marshal(info)
		infoEnv, _ := json.Marshal(protocol.Envelope{Event: "peer-info", Data: infoData})
		for _, op := range others {
			_ = op.writeRaw(endedEnv)
			if op.id != info.ID {
				_ = op.writeRaw(infoEnv)
			}
		}
		if r.cfg.OnPeerUpdated != nil {
			r.cfg.OnPeerUpdated(info)
		}
	} else {
		for _, op := range others {
			_ = op.writeRaw(endedEnv)
		}
	}

	log.Printf("sfu: camera ended publisher=%s reason=%s", session.PublisherID, reason)
}

// handleCameraSubscribe creates a subscriber PC, attaches the publisher's
// fan-out track, and offers it back (server-as-offerer, like screen-sub).
func (r *Room) handleCameraSubscribe(sub *peer, data protocol.CameraSubscribeData) {
	r.mu.Lock()
	pubPeer, ok := r.peers[data.PublisherID]
	var session *CameraSession
	if ok && pubPeer.cameraSession != nil {
		session = pubPeer.cameraSession
	}
	if session == nil {
		r.mu.Unlock()
		log.Printf("sfu: camera-subscribe (%s→%s) no session", sub.id, data.PublisherID)
		return
	}
	if sub.cameraSubs == nil {
		sub.cameraSubs = make(map[string]*cameraSubPC)
	}
	if _, dup := sub.cameraSubs[data.PublisherID]; dup {
		r.mu.Unlock()
		log.Printf("sfu: camera-subscribe (%s→%s) duplicate, ignoring", sub.id, data.PublisherID)
		return
	}
	r.mu.Unlock()

	pc, subEntry, offer, err := r.setupCameraSubPC(sub, session)
	if err != nil {
		return
	}
	subEntry.seqCounter.Store(seqSeed())

	session.mu.Lock()
	if session.closed {
		session.mu.Unlock()
		pc.Close()
		return
	}
	session.subscribers[sub.id] = subEntry
	session.mu.Unlock()

	r.mu.Lock()
	sub.cameraSubs[session.PublisherID] = &cameraSubPC{pc: pc}
	r.mu.Unlock()

	// nil onReport: camera has no auto-downgrade loop, so RR loss is unused.
	go forwardRTCP(&session.publisherVideoSSRC, session.publisherPC, subEntry.videoSender, nil)

	offerData, err := json.Marshal(protocol.OfferEnvelope{
		PC:                 protocol.PCCameraSub,
		PublisherID:        session.PublisherID,
		SessionDescription: offer,
	})
	if err != nil {
		log.Printf("sfu: camera-subscribe (%s→%s) marshal offer: %v", sub.id, session.PublisherID, err)
		r.removeCameraSubscriber(sub, session.PublisherID, "marshal offer failed")
		return
	}
	_ = sub.write(protocol.Envelope{Event: "offer", Data: offerData})
	session.requestKeyframe()
	log.Printf("sfu: camera subscribe sub=%s pub=%s", sub.id, session.PublisherID)
}

// setupCameraSubPC creates a subscriber PC, adds the fan-out video track, wires
// callbacks, and generates the offer. On error the partial PC is already closed.
func (r *Room) setupCameraSubPC(sub *peer, session *CameraSession) (pc *webrtc.PeerConnection, subEntry *cameraSubscriber, offer webrtc.SessionDescription, err error) {
	r.pcCreateMu.Lock()
	r.pendingBWE = nil
	pc, err = r.api.NewPeerConnection(webrtc.Configuration{ICEServers: r.cfg.ICEServers})
	r.pendingBWE = nil
	r.pcCreateMu.Unlock()
	if err != nil {
		log.Printf("sfu: camera subscribe (%s→%s) new pc: %v", sub.id, session.PublisherID, err)
		return nil, nil, webrtc.SessionDescription{}, err
	}

	videoTrack, err := webrtc.NewTrackLocalStaticRTP(session.videoCodec, "camera-video", session.PublisherID)
	if err != nil {
		pc.Close()
		log.Printf("sfu: camera subscribe (%s→%s) new video track: %v", sub.id, session.PublisherID, err)
		return nil, nil, webrtc.SessionDescription{}, err
	}
	videoSender, err := pc.AddTrack(videoTrack)
	if err != nil {
		pc.Close()
		log.Printf("sfu: camera subscribe (%s→%s) add video: %v", sub.id, session.PublisherID, err)
		return nil, nil, webrtc.SessionDescription{}, err
	}

	pc.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c == nil {
			return
		}
		b, err := json.Marshal(protocol.CandidateEnvelope{
			PC:               protocol.PCCameraSub,
			PublisherID:      session.PublisherID,
			ICECandidateInit: c.ToJSON(),
		})
		if err != nil {
			return
		}
		_ = sub.write(protocol.Envelope{Event: "candidate", Data: b})
	})

	pc.OnConnectionStateChange(func(s webrtc.PeerConnectionState) {
		switch s {
		case webrtc.PeerConnectionStateFailed, webrtc.PeerConnectionStateClosed:
			r.removeCameraSubscriber(sub, session.PublisherID, "subscriber pc closed")
		}
	})

	offer, err = pc.CreateOffer(nil)
	if err != nil {
		pc.Close()
		log.Printf("sfu: camera subscribe (%s→%s) create offer: %v", sub.id, session.PublisherID, err)
		return nil, nil, webrtc.SessionDescription{}, err
	}
	if err = pc.SetLocalDescription(offer); err != nil {
		pc.Close()
		log.Printf("sfu: camera subscribe (%s→%s) set local: %v", sub.id, session.PublisherID, err)
		return nil, nil, webrtc.SessionDescription{}, err
	}

	subEntry = &cameraSubscriber{
		peerID:      sub.id,
		pc:          pc,
		videoTrack:  videoTrack,
		videoSender: videoSender,
	}
	return pc, subEntry, offer, nil
}

// removeCameraSubscriber tears down the subscriber's per-publisher PC.
// Idempotent.
func (r *Room) removeCameraSubscriber(sub *peer, publisherID, reason string) {
	r.mu.Lock()
	var subPC *cameraSubPC
	if sub.cameraSubs != nil {
		subPC = sub.cameraSubs[publisherID]
		delete(sub.cameraSubs, publisherID)
	}
	var session *CameraSession
	if pubPeer := r.peers[publisherID]; pubPeer != nil {
		session = pubPeer.cameraSession
	}
	r.mu.Unlock()

	if subPC != nil {
		_ = subPC.pc.Close()
	}
	if session != nil {
		session.mu.Lock()
		delete(session.subscribers, sub.id)
		session.mu.Unlock()
	}
	log.Printf("sfu: camera unsubscribe (%s→%s) %s", sub.id, publisherID, reason)
}

// forwardVideo reads RTP from the publisher's remote camera track and writes to
// every active subscriber's per-sub track. VP8 is single-layer, so there is no
// temporal-layer gate — every packet is forwarded.
func (s *CameraSession) forwardVideo(remote *webrtc.TrackRemote) {
	for {
		pkt, _, err := remote.ReadRTP()
		if err != nil {
			if !errors.Is(err, io.EOF) {
				log.Printf("sfu: camera forwardVideo (%s) read: %v", s.PublisherID, err)
			}
			return
		}

		s.mu.RLock()
		subs := make([]*cameraSubscriber, 0, len(s.subscribers))
		for _, sub := range s.subscribers {
			subs = append(subs, sub)
		}
		s.mu.RUnlock()

		for _, sub := range subs {
			sub.forward(pkt, s.PublisherID)
		}
	}
}

// requestKeyframe sends a PLI to the publisher so the next packets carry an
// intra frame. Called when a new subscriber attaches so it does not wait a full
// GOP for decodable video. No-op before the publisher's first OnTrack.
func (s *CameraSession) requestKeyframe() {
	pubSSRC := s.publisherVideoSSRC.Load()
	if pubSSRC == 0 {
		return
	}
	_ = s.publisherPC.WriteRTCP([]rtcp.Packet{
		&rtcp.PictureLossIndication{MediaSSRC: pubSSRC},
	})
}

// forward writes one inbound RTP packet to the subscriber's track, rewriting the
// sequence number per-subscriber so the receiver's NACK responder stays useful.
func (sub *cameraSubscriber) forward(pkt *rtp.Packet, pubID string) {
	sub.outPkt = *pkt
	// Strip RTP extensions: the publisher negotiated extension IDs the
	// subscriber did not.
	sub.outPkt.Extension = false
	sub.outPkt.Extensions = nil
	sub.outPkt.SequenceNumber = uint16(sub.seqCounter.Add(1))
	if err := sub.videoTrack.WriteRTP(&sub.outPkt); err != nil {
		if !errors.Is(err, io.ErrClosedPipe) {
			log.Printf("sfu: camera forwardVideo (%s→%s) write: %v", pubID, sub.peerID, err)
		}
	}
}
