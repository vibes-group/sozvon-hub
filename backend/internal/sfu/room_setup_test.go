package sfu

import (
	"strings"
	"testing"

	"github.com/pion/webrtc/v4"
)

const transportCCURI = "http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01"

// Without rtcp-fb / transport-cc in the SDP, browsers send no NACK or TWCC
// feedback and the NACK/TWCC/GCC interceptors silently do nothing.
func TestNewRoomOfferAdvertisesRTCPFeedback(t *testing.T) {
	r, err := NewRoom(Config{})
	if err != nil {
		t.Fatal(err)
	}
	pc, err := r.api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = pc.Close() })
	for _, kind := range []webrtc.RTPCodecType{webrtc.RTPCodecTypeAudio, webrtc.RTPCodecTypeVideo} {
		if _, err := pc.AddTransceiverFromKind(kind); err != nil {
			t.Fatal(err)
		}
	}
	offer, err := pc.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}

	sections := map[string][]string{}
	var kind string
	for _, line := range strings.Split(offer.SDP, "\r\n") {
		if m, ok := strings.CutPrefix(line, "m="); ok {
			kind, _, _ = strings.Cut(m, " ")
		}
		if kind != "" {
			sections[kind] = append(sections[kind], line)
		}
	}

	audio := sections["audio"]
	requireLine(t, audio, "a=fmtp:111 minptime=10;useinbandfec=1;usedtx=1;stereo=0")
	requireLine(t, audio, "a=rtcp-fb:111 transport-cc")
	requireExtmap(t, audio, transportCCURI)

	video := sections["video"]
	pts := payloadTypes(video)
	if len(pts) == 0 {
		t.Fatal("no video codecs in offer")
	}
	for _, pt := range pts {
		for _, fb := range []string{"nack", "nack pli", "transport-cc"} {
			requireLine(t, video, "a=rtcp-fb:"+pt+" "+fb)
		}
	}
	requireExtmap(t, video, transportCCURI)
}

func payloadTypes(section []string) []string {
	var pts []string
	for _, line := range section {
		if rest, ok := strings.CutPrefix(line, "a=rtpmap:"); ok {
			pt, _, _ := strings.Cut(rest, " ")
			pts = append(pts, pt)
		}
	}
	return pts
}

func requireLine(t *testing.T, section []string, want string) {
	t.Helper()
	for _, line := range section {
		if line == want {
			return
		}
	}
	t.Errorf("missing %q in:\n%s", want, strings.Join(section, "\n"))
}

func requireExtmap(t *testing.T, section []string, uri string) {
	t.Helper()
	for _, line := range section {
		if strings.HasPrefix(line, "a=extmap:") && strings.HasSuffix(line, " "+uri) {
			return
		}
	}
	t.Errorf("missing extmap %s in:\n%s", uri, strings.Join(section, "\n"))
}
