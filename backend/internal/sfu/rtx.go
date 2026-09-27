package sfu

import (
	"fmt"

	"github.com/pion/interceptor"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

// registerRTX registers an RFC 4588 RTX codec for the video codec at apt, so
// the NACK responder answers subscribers on a separate SSRC (ssrc-group FID).
func registerRTX(m *webrtc.MediaEngine, pt, apt webrtc.PayloadType) error {
	return m.RegisterCodec(webrtc.RTPCodecParameters{
		RTPCodecCapability: webrtc.RTPCodecCapability{
			MimeType:  webrtc.MimeTypeRTX,
			ClockRate: 90000,
			// Exactly "apt=N": pion looks the RTX PT up by string equality.
			SDPFmtpLine: fmt.Sprintf("apt=%d", apt),
		},
		PayloadType: pt,
	}, webrtc.RTPCodecTypeVideo)
}

// rtxPacerFactory wraps the cc interceptor so each local stream's RTX SSRC is
// registered with the gcc pacer too. The pacer routes by header SSRC and
// rejects unknown ones, so without this every retransmission fails with
// gcc.ErrUnknownStream.
type rtxPacerFactory struct{ interceptor.Factory }

func (f rtxPacerFactory) NewInterceptor(id string) (interceptor.Interceptor, error) {
	i, err := f.Factory.NewInterceptor(id)
	if err != nil {
		return nil, err
	}
	return rtxPacer{i}, nil
}

type rtxPacer struct{ interceptor.Interceptor }

func (p rtxPacer) BindLocalStream(info *interceptor.StreamInfo, writer interceptor.RTPWriter) interceptor.RTPWriter {
	if info.SSRCRetransmission != 0 {
		rtx := *info
		rtx.SSRC = info.SSRCRetransmission
		p.Interceptor.BindLocalStream(&rtx, writer)
	}
	return p.Interceptor.BindLocalStream(info, writer)
}

// forwardable reports whether a packet read from a publisher's video track
// carries new media. The SFU never NACKs publishers and renumbers by arrival,
// so padding-only BWE probes and anything pion unwrapped from the publisher's
// RTX stream (only other clients negotiate it: ours leave rtx out of
// setCodecPreferences) would reach subscribers as fresh packets. TWCC has
// already counted both by the time ReadRTP returns.
func forwardable(pkt *rtp.Packet, attrs interceptor.Attributes) bool {
	return len(pkt.Payload) > 0 && attrs.Get(webrtc.AttributeRtxSsrc) == nil
}
