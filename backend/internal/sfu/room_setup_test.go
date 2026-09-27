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
	pc := newSFUPC(t)
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

	if rtx := rtxPayloadTypes(audio); len(rtx) != 0 {
		t.Errorf("audio offers RTX %v", rtx)
	}

	video := sections["video"]
	pts := mediaPayloadTypes(video)
	if len(pts) == 0 {
		t.Fatal("no video codecs in offer")
	}
	for _, pt := range pts {
		for _, fb := range []string{"nack", "nack pli", "transport-cc"} {
			requireLine(t, video, "a=rtcp-fb:"+pt+" "+fb)
		}
	}
	requireExtmap(t, video, transportCCURI)

	rtx := rtxPayloadTypes(video)
	for _, pt := range pts {
		rtxPT, ok := rtx[pt]
		if !ok {
			t.Errorf("no RTX with apt=%s in:\n%s", pt, strings.Join(video, "\n"))
			continue
		}
		requireLine(t, video, "a=rtpmap:"+rtxPT+" rtx/90000")
		for _, line := range video {
			if strings.HasPrefix(line, "a=rtcp-fb:"+rtxPT+" ") {
				t.Errorf("RTX PT %s carries feedback: %q", rtxPT, line)
			}
		}
	}
	if len(rtx) != len(pts) {
		t.Errorf("RTX apt map %v does not match media PTs %v", rtx, pts)
	}
}

// mediaPayloadTypes returns the non-RTX payload types of an m= section.
func mediaPayloadTypes(section []string) []string {
	var pts []string
	for _, line := range section {
		if rest, ok := strings.CutPrefix(line, "a=rtpmap:"); ok {
			pt, name, _ := strings.Cut(rest, " ")
			if !strings.HasPrefix(strings.ToLower(name), "rtx/") {
				pts = append(pts, pt)
			}
		}
	}
	return pts
}

// rtxPayloadTypes maps each apt= target to its RTX payload type.
func rtxPayloadTypes(section []string) map[string]string {
	rtx := map[string]string{}
	for _, line := range section {
		rest, ok := strings.CutPrefix(line, "a=fmtp:")
		if !ok {
			continue
		}
		pt, params, _ := strings.Cut(rest, " ")
		if apt, ok := strings.CutPrefix(params, "apt="); ok {
			rtx[apt] = pt
		}
	}
	return rtx
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
