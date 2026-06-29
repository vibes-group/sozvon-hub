package dd

import (
	"testing"
)

func TestParseAbsentExtension(t *testing.T) {
	d, err := NewParser().Parse(nil)
	if err != nil || d != nil {
		t.Fatalf("empty extData: got (%v, %v); want (nil, nil)", d, err)
	}
}

func TestParseTruncatedMandatory(t *testing.T) {
	// Only 2 bytes: the 16-bit frame_number read runs past the buffer.
	if _, err := NewParser().Parse([]byte{0x00, 0x00}); err == nil {
		t.Fatal("truncated mandatory descriptor: expected error, got nil")
	}
}

func TestParseMandatoryOnlyWithoutStructure(t *testing.T) {
	// A 3-byte (mandatory-only) packet arriving before any structure has
	// been seen has nothing to index into.
	if _, err := NewParser().Parse([]byte{0x00, 0x00, 0x00}); err != errNoStructure {
		t.Fatalf("got %v; want errNoStructure", err)
	}
}

// TestParseStructureBearing feeds a hand-assembled structure-bearing packet
// (1 template, 1 decode target, 1 chain, no frame diffs). It is the alignment
// guard for the parser: the template_dtis bits are consumed-and-discarded, so
// if that consumption drifts, the chain_diff read lands on the wrong bits and
// ChainDiffs no longer equals [3].
//
// Bit layout (MSB-first):
//
//	mandatory:  sof=0 eof=0 template_id=0(6) frame_number=10(16)
//	flags:      structPresent=1 activeDT=0 customDTI=0 customFdiff=0 customChain=0
//	structure:  id_offset=0(6) dt_cnt_minus_one=0(5)
//	            template_layers: idc=0b11 (stop after 1 template)
//	            template_dtis:   0b00
//	            template_fdiffs: follow=0 (empty → keyframe)
//	            template_chains: numChains=ns(2)=1 ; protected_by_chain=ns(1)=∅ ; chain_diff=0b0011
//	            resolutions_present=0
func TestParseStructureBearing(t *testing.T) {
	pkt := []byte{0x00, 0x00, 0x0A, 0x80, 0x00, 0xC4, 0xC0}
	d, err := NewParser().Parse(pkt)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if d == nil {
		t.Fatal("got nil descriptor")
	}
	if d.FrameNumber != 10 {
		t.Errorf("FrameNumber = %d; want 10", d.FrameNumber)
	}
	if d.TemporalLayer != 0 {
		t.Errorf("TemporalLayer = %d; want 0", d.TemporalLayer)
	}
	if !d.IsKeyframe {
		t.Error("IsKeyframe = false; want true (empty fdiffs)")
	}
	if !d.AttachesStructure {
		t.Error("AttachesStructure = false; want true")
	}
	if len(d.ChainDiffs) != 1 || d.ChainDiffs[0] != 3 {
		t.Errorf("ChainDiffs = %v; want [3]", d.ChainDiffs)
	}
}
