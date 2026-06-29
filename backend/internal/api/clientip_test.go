package api

import (
	"net/http"
	"net/http/httptest"
	"net/netip"
	"testing"
)

func TestClientIP(t *testing.T) {
	trusted := []netip.Prefix{
		netip.MustParsePrefix("10.0.0.0/8"),
		netip.MustParsePrefix("::1/128"),
	}
	tests := []struct {
		name       string
		remoteAddr string
		xff        string
		want       string
	}{
		{
			name:       "untrusted RemoteAddr ignores spoofed XFF",
			remoteAddr: "203.0.113.7:51000",
			xff:        "1.2.3.4, 5.6.7.8",
			want:       "203.0.113.7",
		},
		{
			name:       "trusted RemoteAddr + single XFF returns XFF",
			remoteAddr: "10.0.0.5:51000",
			xff:        "203.0.113.7",
			want:       "203.0.113.7",
		},
		{
			name:       "trusted RemoteAddr + chain (client, trusted1, trusted2)",
			remoteAddr: "10.0.0.5:51000",
			xff:        "203.0.113.7, 10.0.0.10, 10.0.0.20",
			want:       "203.0.113.7",
		},
		{
			// A client that forges a left entry must not change the key: with the
			// proxy trusted, the real IP is the right-most untrusted entry.
			name:       "spoofed left + real proxy entry",
			remoteAddr: "10.0.0.5:51000",
			xff:        "9.9.9.9, 203.0.113.7",
			want:       "203.0.113.7",
		},
		{
			name:       "malformed XFF token fails safe to RemoteAddr",
			remoteAddr: "10.0.0.5:51000",
			xff:        "203.0.113.7, not-an-ip, 10.0.0.10",
			want:       "10.0.0.5",
		},
		{
			name:       "trusted RemoteAddr but no XFF returns RemoteAddr",
			remoteAddr: "10.0.0.5:51000",
			xff:        "",
			want:       "10.0.0.5",
		},
		{
			name:       "entire chain trusted returns RemoteAddr",
			remoteAddr: "10.0.0.5:51000",
			xff:        "10.0.0.10, 10.0.0.20",
			want:       "10.0.0.5",
		},
		{
			name:       "ipv4-mapped ipv6 RemoteAddr unmaps to ipv4 trusted",
			remoteAddr: "[::ffff:10.0.0.5]:51000",
			xff:        "203.0.113.7",
			want:       "203.0.113.7",
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodGet, "/api/auth/login", nil)
			r.RemoteAddr = tc.remoteAddr
			if tc.xff != "" {
				r.Header.Set("X-Forwarded-For", tc.xff)
			}
			if got := clientIP(r, trusted); got != tc.want {
				t.Fatalf("clientIP = %q, want %q", got, tc.want)
			}
		})
	}
}
