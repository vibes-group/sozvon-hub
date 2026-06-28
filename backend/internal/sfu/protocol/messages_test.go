package protocol

import (
	"encoding/json"
	"testing"
)

func TestEnvelopeWelcomeRoundTrip(t *testing.T) {
	welcome := WelcomePayload{
		ID: "peer-1",
		Peers: []PeerInfo{
			{ID: "peer-2", DisplayName: "Bob", SelfMuted: true},
			{ID: "peer-3", ChatOnly: true},
		},
	}
	data, err := json.Marshal(welcome)
	if err != nil {
		t.Fatalf("marshal welcome: %v", err)
	}
	env := Envelope{Event: "welcome", Data: data}
	wire, err := json.Marshal(env)
	if err != nil {
		t.Fatalf("marshal envelope: %v", err)
	}

	var decoded Envelope
	if err := json.Unmarshal(wire, &decoded); err != nil {
		t.Fatalf("unmarshal envelope: %v", err)
	}
	if decoded.Event != "welcome" {
		t.Fatalf("event = %q, want welcome", decoded.Event)
	}
	var got WelcomePayload
	if err := json.Unmarshal(decoded.Data, &got); err != nil {
		t.Fatalf("unmarshal payload: %v", err)
	}
	if got.ID != welcome.ID || len(got.Peers) != 2 {
		t.Fatalf("welcome mismatch: %+v", got)
	}
	if got.Peers[0].DisplayName != "Bob" || !got.Peers[0].SelfMuted {
		t.Fatalf("peer[0] mismatch: %+v", got.Peers[0])
	}
	if !got.Peers[1].ChatOnly {
		t.Fatalf("peer[1] ChatOnly lost: %+v", got.Peers[1])
	}
}

func TestChatPayloadRoundTrip(t *testing.T) {
	chat := ChatPayload{
		ID:          "01J0000000000000000000000",
		From:        "peer-1",
		Text:        "hello world",
		Ts:          1700000000000,
		ClientMsgID: "client-123",
		SenderName:  "Alice",
		Attachments: []Attachment{{UploadID: "up-1", Kind: AttachmentImage, Name: "pic.png", MIME: "image/png", Size: 42, Width: 100, Height: 80}},
	}
	data, err := json.Marshal(chat)
	if err != nil {
		t.Fatalf("marshal chat: %v", err)
	}
	var got ChatPayload
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatalf("unmarshal chat: %v", err)
	}
	if got.ID != chat.ID || got.Text != chat.Text || got.Ts != chat.Ts || got.ClientMsgID != chat.ClientMsgID || got.SenderName != chat.SenderName {
		t.Fatalf("chat scalar mismatch: %+v", got)
	}
	if len(got.Attachments) != 1 || got.Attachments[0].Kind != AttachmentImage || got.Attachments[0].Width != 100 {
		t.Fatalf("attachment mismatch: %+v", got.Attachments)
	}
}

func TestPeerInfoOmitsZeroFields(t *testing.T) {
	data, err := json.Marshal(PeerInfo{ID: "p1"})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	// Only the required id should be present; all omitempty fields drop out.
	if string(data) != `{"id":"p1"}` {
		t.Fatalf("unexpected JSON: %s", data)
	}
}

func TestScreenShareModeIsValid(t *testing.T) {
	if !ScreenShareModeSharp.IsValid() || !ScreenShareModeMotion.IsValid() {
		t.Fatal("expected sharp and motion to be valid")
	}
	if ScreenShareMode("bogus").IsValid() {
		t.Fatal("expected bogus mode to be invalid")
	}
}
