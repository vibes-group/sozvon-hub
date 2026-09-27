package sfu

import (
	"github.com/pion/interceptor"
	"github.com/pion/interceptor/pkg/cc"
	"github.com/pion/interceptor/pkg/gcc"
	"github.com/pion/interceptor/pkg/nack"
	"github.com/pion/webrtc/v4"

	"sozvon-hub/backend/internal/sfu/dd"
)

// NewRoom creates and configures a Room with audio codecs, screen-share video
// codecs, and the full interceptor chain (RTCP reports, NACK
// responder, GCC bandwidth estimator, TWCC header extension + sender).
func NewRoom(cfg Config) (*Room, error) {
	settingEngine := webrtc.SettingEngine{}
	if len(cfg.NAT1To1IPs) > 0 {
		settingEngine.SetICEAddressRewriteRules(webrtc.ICEAddressRewriteRule{
			External:        cfg.NAT1To1IPs,
			AsCandidateType: webrtc.ICECandidateTypeHost,
		})
	}
	if cfg.UDPPortMin > 0 && cfg.UDPPortMax >= cfg.UDPPortMin {
		if err := settingEngine.SetEphemeralUDPPortRange(cfg.UDPPortMin, cfg.UDPPortMax); err != nil {
			return nil, err
		}
	}
	mediaEngine := &webrtc.MediaEngine{}
	if err := mediaEngine.RegisterCodec(webrtc.RTPCodecParameters{
		RTPCodecCapability: webrtc.RTPCodecCapability{
			MimeType:    webrtc.MimeTypeOpus,
			ClockRate:   48000,
			Channels:    2,
			SDPFmtpLine: "minptime=10;useinbandfec=1;usedtx=1;stereo=0",
		},
		PayloadType: 111,
	}, webrtc.RTPCodecTypeAudio); err != nil {
		return nil, err
	}
	// Screen-share video codecs. AV1 stays preferred by client-side codec
	// ordering; VP9 is registered as the compatibility fallback when AV1 is
	// absent or has proven CPU-bound on this client.
	if err := mediaEngine.RegisterCodec(webrtc.RTPCodecParameters{
		RTPCodecCapability: webrtc.RTPCodecCapability{
			MimeType:    webrtc.MimeTypeAV1,
			ClockRate:   90000,
			SDPFmtpLine: "level-idx=5;profile=0;tier=0",
		},
		PayloadType: 45,
	}, webrtc.RTPCodecTypeVideo); err != nil {
		return nil, err
	}
	if err := mediaEngine.RegisterCodec(webrtc.RTPCodecParameters{
		RTPCodecCapability: webrtc.RTPCodecCapability{
			MimeType:  webrtc.MimeTypeVP9,
			ClockRate: 90000,
		},
		PayloadType: 98,
	}, webrtc.RTPCodecTypeVideo); err != nil {
		return nil, err
	}
	// Camera video codec: VP8. Single layer (no SVC/simulcast); the SFU forwards
	// every packet verbatim and relies on GCC/TWCC for bitrate control. Chosen
	// for its universal browser encode/decode support and HW-decode availability.
	if err := mediaEngine.RegisterCodec(webrtc.RTPCodecParameters{
		RTPCodecCapability: webrtc.RTPCodecCapability{
			MimeType:  webrtc.MimeTypeVP8,
			ClockRate: 90000,
		},
		PayloadType: 96,
	}, webrtc.RTPCodecTypeVideo); err != nil {
		return nil, err
	}
	// DD extension negotiated here so per-PC extension IDs are included in SDP.
	if err := mediaEngine.RegisterHeaderExtension(
		webrtc.RTPHeaderExtensionCapability{URI: dd.RTPExtensionURI},
		webrtc.RTPCodecTypeVideo,
	); err != nil {
		return nil, err
	}

	// Stats interceptor skipped — getStats is never consumed server-side.
	// No interval PLI either: keyframes come from requestKeyframe and relayed
	// subscriber PLIs, not forced every few seconds.
	ir := &interceptor.Registry{}
	if err := webrtc.ConfigureRTCPReports(ir); err != nil {
		return nil, err
	}

	ccFactory, err := cc.NewInterceptor(func() (cc.BandwidthEstimator, error) {
		// NoOpPacer: we only want gcc's BWE estimate (for bwCapTID); the
		// default LeakyBucketPacer queues packets at the estimated rate and
		// stalls the wire when the encoder briefly outpaces it.
		return gcc.NewSendSideBWE(
			gcc.SendSideBWEInitialBitrate(bweInitialBitrate),
			gcc.SendSideBWEPacer(gcc.NewNoOpPacer()),
		)
	})
	if err != nil {
		return nil, err
	}

	r := &Room{
		peers:                 make(map[string]*peer),
		tracks:                make(map[string]*webrtc.TrackLocalStaticRTP),
		screenSessionsByToken: make(map[string]*ScreenShareSession),
		cfg:                   cfg,
	}
	ccFactory.OnNewPeerConnection(func(_ string, bwe cc.BandwidthEstimator) {
		r.pendingBWE = bwe
	})

	// Interceptor order matters: last-added is OUTERMOST on the write path.
	//   - TWCC HeaderExtension sets the transport seq# and must wrap cc, so
	//     cc.OnSent finds it.
	//   - TWCC Sender only generates feedback for INCOMING RTP, so publishers
	//     get it for their own BWE.
	//   - NACK responder wraps HeaderExtension, so retransmits get a fresh
	//     seq# and count toward the estimate.
	// Configure* and RegisterFeedback add the rtcp-fb / extmap SDP lines
	// browsers need to send NACK/TWCC; they must run after RegisterCodec.
	ir.Add(ccFactory)
	if err := webrtc.ConfigureTWCCHeaderExtensionSender(mediaEngine, ir); err != nil {
		return nil, err
	}
	if err := webrtc.ConfigureTWCCSender(mediaEngine, ir); err != nil {
		return nil, err
	}
	// NACK responder only, no generator: the SFU renumbers forwarded packets,
	// so a retransmit pulled from the publisher would arrive with a fresh seq#
	// and a stale timestamp and repair nothing. No ccm fir either: RTCP relay
	// rewrites only MediaSSRC, so a forwarded FIR is ignored; browsers use PLI.
	// 256 packets (default 1024) is still well over one RTT of history and
	// keeps the per-subscriber-stream buffer small.
	nackResponder, err := nack.NewResponderInterceptor(nack.ResponderSize(256))
	if err != nil {
		return nil, err
	}
	mediaEngine.RegisterFeedback(webrtc.RTCPFeedback{Type: webrtc.TypeRTCPFBNACK}, webrtc.RTPCodecTypeVideo)
	mediaEngine.RegisterFeedback(webrtc.RTCPFeedback{Type: webrtc.TypeRTCPFBNACK, Parameter: "pli"}, webrtc.RTPCodecTypeVideo)
	ir.Add(nackResponder)

	r.api = webrtc.NewAPI(
		webrtc.WithSettingEngine(settingEngine),
		webrtc.WithMediaEngine(mediaEngine),
		webrtc.WithInterceptorRegistry(ir),
	)
	return r, nil
}
