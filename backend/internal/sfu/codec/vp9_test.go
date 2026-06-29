package codec

import (
	"testing"

	"github.com/pion/rtp"
)

func vp9Desc(t *testing.T, payload []byte) (frame uint16, temporal uint8, keyframe bool) {
	t.Helper()
	d, err := (&vp9{}).Parse(&rtp.Packet{Payload: payload})
	if err != nil {
		t.Fatalf("Parse(%#v) unexpected error: %v", payload, err)
	}
	return d.FrameNumber, d.TemporalLayer, d.IsKeyframe
}

func TestVP9ParseKeyframe(t *testing.T) {
	// B set, P clear → start of a non-inter-predicted frame = keyframe.
	frame, tid, kf := vp9Desc(t, []byte{0x08})
	if !kf || frame != 0 || tid != 0 {
		t.Fatalf("got frame=%d tid=%d keyframe=%v; want 0,0,true", frame, tid, kf)
	}
}

func TestVP9ParseInterFrame(t *testing.T) {
	// P set → inter-predicted, not a keyframe.
	if _, _, kf := vp9Desc(t, []byte{0x40}); kf {
		t.Fatal("P-bit payload classified as keyframe")
	}
}

func TestVP9ParsePictureID7Bit(t *testing.T) {
	// I+B, picture-id byte with M-bit clear → 7-bit id.
	frame, _, kf := vp9Desc(t, []byte{0x88, 0x2A})
	if frame != 42 || !kf {
		t.Fatalf("got frame=%d keyframe=%v; want 42,true", frame, kf)
	}
}

func TestVP9ParsePictureID15Bit(t *testing.T) {
	// I+B, picture-id byte with M-bit set → 15-bit id spanning two bytes.
	frame, _, _ := vp9Desc(t, []byte{0x88, 0x81, 0x00})
	if frame != 256 {
		t.Fatalf("got frame=%d; want 256", frame)
	}
}

func TestVP9ParseTemporalLayer(t *testing.T) {
	// L+B, F=0. layers byte 0x40 → TID = (0x40>>5)&7 = 2. A trailing flex
	// byte must be present (F=0), hence the third byte.
	_, tid, _ := vp9Desc(t, []byte{0x28, 0x40, 0x00})
	if tid != 2 {
		t.Fatalf("got tid=%d; want 2", tid)
	}
}

func TestVP9ParseErrors(t *testing.T) {
	cases := map[string][]byte{
		"empty":            {},
		"truncated I":      {0x80},       // I set but no picture-id byte
		"truncated L flex": {0x28, 0x40}, // L set, F=0, but flex byte missing
	}
	for name, payload := range cases {
		if _, err := (&vp9{}).Parse(&rtp.Packet{Payload: payload}); err == nil {
			t.Errorf("%s: expected error, got nil", name)
		}
	}
}
