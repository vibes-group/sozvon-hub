package auth

import (
	"strings"
	"testing"
)

func TestHashVerifyRoundTrip(t *testing.T) {
	params := DefaultPasswordParams()
	encoded, err := HashPassword("correct horse battery staple", params)
	if err != nil {
		t.Fatalf("HashPassword: %v", err)
	}
	if !strings.HasPrefix(encoded, "$argon2id$v=19$") {
		t.Fatalf("unexpected hash format: %q", encoded)
	}

	ok, err := VerifyPassword("correct horse battery staple", encoded)
	if err != nil {
		t.Fatalf("VerifyPassword: %v", err)
	}
	if !ok {
		t.Fatal("expected matching password to verify")
	}
}

func TestVerifyWrongPasswordFails(t *testing.T) {
	encoded, err := HashPassword("right-password", DefaultPasswordParams())
	if err != nil {
		t.Fatalf("HashPassword: %v", err)
	}
	ok, err := VerifyPassword("wrong-password", encoded)
	if err != nil {
		t.Fatalf("VerifyPassword: %v", err)
	}
	if ok {
		t.Fatal("expected wrong password to fail verification")
	}
}

func TestVerifyInvalidEncodedHash(t *testing.T) {
	if _, err := VerifyPassword("whatever", "not-a-valid-hash"); err == nil {
		t.Fatal("expected error for malformed encoded hash")
	}
}

func TestValidatePasswordBounds(t *testing.T) {
	tests := []struct {
		name     string
		password string
		wantErr  bool
	}{
		{"too short", strings.Repeat("a", 7), true},
		{"min length", strings.Repeat("a", 8), false},
		{"max length", strings.Repeat("a", 256), false},
		{"too long", strings.Repeat("a", 257), true},
		{"empty", "", true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			err := validatePassword(tc.password)
			if tc.wantErr && err == nil {
				t.Fatalf("expected error for password of length %d", len(tc.password))
			}
			if !tc.wantErr && err != nil {
				t.Fatalf("unexpected error for password of length %d: %v", len(tc.password), err)
			}
		})
	}
}
