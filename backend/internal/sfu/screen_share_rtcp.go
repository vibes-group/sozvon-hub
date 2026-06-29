package sfu

import (
	"sync/atomic"

	"github.com/pion/rtcp"
	"github.com/pion/webrtc/v4"
)

// forwardRTCP relays PLI/FIR from a subscriber sender to the publisher PC,
// rewriting MediaSSRC to the publisher's current video SSRC. When onReport is
// non-nil it is called for every ReceiverReport seen, letting callers harvest
// per-subscriber loss stats. Runs until sender.Read errors (subscriber gone).
// Shared by the screen-share and camera forward paths.
func forwardRTCP(
	pubSSRC *atomic.Uint32,
	publisherPC *webrtc.PeerConnection,
	sender *webrtc.RTPSender,
	onReport func(*rtcp.ReceiverReport),
) {
	buf := make([]byte, 1500)
	for {
		n, _, err := sender.Read(buf)
		if err != nil {
			return
		}
		pkts, err := rtcp.Unmarshal(buf[:n])
		if err != nil {
			continue
		}
		var forward []rtcp.Packet
		for _, pkt := range pkts {
			switch p := pkt.(type) {
			case *rtcp.PictureLossIndication, *rtcp.FullIntraRequest:
				forward = append(forward, pkt)
			case *rtcp.ReceiverReport:
				if onReport != nil {
					onReport(p)
				}
			}
		}
		if len(forward) == 0 {
			continue
		}
		ssrc := pubSSRC.Load()
		if ssrc == 0 {
			continue
		}
		for _, pkt := range forward {
			switch p := pkt.(type) {
			case *rtcp.PictureLossIndication:
				p.MediaSSRC = ssrc
			case *rtcp.FullIntraRequest:
				p.MediaSSRC = ssrc
			}
		}
		_ = publisherPC.WriteRTCP(forward)
	}
}

// forwardScreenVideoRTCPToPublisher relays PLI/FIR from a subscriber's video
// sender to the publisher's PC and harvests ReceiverReport.FractionLost into
// sub.lossPerMille for the auto-downgrade loop.
func (r *Room) forwardScreenVideoRTCPToPublisher(session *ScreenShareSession, sub *screenSubscriber, sender *webrtc.RTPSender) {
	forwardRTCP(&session.publisherVideoSSRC, session.publisherPC, sender, func(p *rtcp.ReceiverReport) {
		if len(p.Reports) > 0 {
			// A compound RR may carry blocks for both video and audio SSRCs
			// (RFC 3550 §6.4.1). Take the worst loss across all blocks —
			// conservative bias toward downgrade when any leg is hurting.
			var worst uint8
			for _, rep := range p.Reports {
				if rep.FractionLost > worst {
					worst = rep.FractionLost
				}
			}
			// FractionLost is fixed-point /256 (RFC 3550 §6.4.1) — convert
			// to per-mille for the int comparisons in the decision loop.
			sub.lossPerMille.Store(uint32(worst) * 1000 / 256)
		}
	})
}
