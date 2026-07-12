package sfu

import (
	"fmt"
	"testing"

	"github.com/pion/rtp"
)

func audioRTPWithExtensions() []byte {
	pkt := &rtp.Packet{}
	pkt.Version = 2
	pkt.PayloadType = 111
	pkt.SequenceNumber = 1
	pkt.SSRC = 0xDEADBEEF
	_ = pkt.Header.SetExtension(1, []byte{0xAB})
	_ = pkt.Header.SetExtension(3, []byte{0x01, 0x02})
	pkt.Payload = make([]byte, 160)
	b, _ := pkt.Marshal()
	return b
}

func BenchmarkAudioRTPDecodeAndStrip(b *testing.B) {
	buf := audioRTPWithExtensions()
	pkt := &rtp.Packet{}
	b.ReportAllocs()
	for b.Loop() {
		if err := pkt.Unmarshal(buf); err != nil {
			b.Fatal(err)
		}
		pkt.Extension = false
		pkt.Extensions = pkt.Extensions[:0]
	}
}

func BenchmarkScreenSubscriberSnapshot(b *testing.B) {
	for _, count := range []int{1, 8, 32} {
		b.Run(fmt.Sprintf("subscribers=%d", count), func(b *testing.B) {
			session := &ScreenShareSession{subscribers: make(map[string]*screenSubscriber, count)}
			for i := range count {
				id := fmt.Sprintf("sub-%d", i)
				session.subscribers[id] = &screenSubscriber{peerID: id}
			}
			session.refreshSubscriberViewLocked()
			b.ReportAllocs()
			for b.Loop() {
				subs := session.subscribersSnapshot()
				if len(subs) != count {
					b.Fatalf("snapshot size = %d, want %d", len(subs), count)
				}
			}
		})
	}
}

func BenchmarkCameraSubscriberSnapshot(b *testing.B) {
	for _, count := range []int{1, 8, 32} {
		b.Run(fmt.Sprintf("subscribers=%d", count), func(b *testing.B) {
			session := &CameraSession{subscribers: make(map[string]*cameraSubscriber, count)}
			for i := range count {
				id := fmt.Sprintf("sub-%d", i)
				session.subscribers[id] = &cameraSubscriber{peerID: id}
			}
			session.refreshSubscriberViewLocked()
			b.ReportAllocs()
			for b.Loop() {
				subs := session.subscribersSnapshot()
				if len(subs) != count {
					b.Fatalf("snapshot size = %d, want %d", len(subs), count)
				}
			}
		})
	}
}

func TestAudioRTPStripRetainsExtensionBuffer(t *testing.T) {
	pkt := &rtp.Packet{}
	if err := pkt.Unmarshal(audioRTPWithExtensions()); err != nil {
		t.Fatal(err)
	}
	pkt.Extension = false
	pkt.Extensions = pkt.Extensions[:0]
	if cap(pkt.Extensions) == 0 {
		t.Fatal("stripping extensions discarded reusable buffer")
	}
	if err := pkt.Unmarshal(audioRTPWithExtensions()); err != nil {
		t.Fatal(err)
	}
	if len(pkt.Extensions) != 2 {
		t.Fatalf("decoded extensions = %d, want 2", len(pkt.Extensions))
	}
}

func TestSubscriberSnapshotsTrackMutations(t *testing.T) {
	screen := &ScreenShareSession{subscribers: make(map[string]*screenSubscriber)}
	screenSub := &screenSubscriber{peerID: "screen"}
	screen.subscribers[screenSub.peerID] = screenSub
	screen.refreshSubscriberViewLocked()
	if got := screen.subscribersSnapshot(); len(got) != 1 || got[0] != screenSub {
		t.Fatalf("screen snapshot = %#v", got)
	}
	delete(screen.subscribers, screenSub.peerID)
	screen.refreshSubscriberViewLocked()
	if got := screen.subscribersSnapshot(); len(got) != 0 {
		t.Fatalf("screen snapshot after remove = %#v", got)
	}

	camera := &CameraSession{subscribers: make(map[string]*cameraSubscriber)}
	cameraSub := &cameraSubscriber{peerID: "camera"}
	camera.subscribers[cameraSub.peerID] = cameraSub
	camera.refreshSubscriberViewLocked()
	if got := camera.subscribersSnapshot(); len(got) != 1 || got[0] != cameraSub {
		t.Fatalf("camera snapshot = %#v", got)
	}
	delete(camera.subscribers, cameraSub.peerID)
	camera.refreshSubscriberViewLocked()
	if got := camera.subscribersSnapshot(); len(got) != 0 {
		t.Fatalf("camera snapshot after remove = %#v", got)
	}
}
