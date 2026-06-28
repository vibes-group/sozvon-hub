package web

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// Handler serves static assets from dir and falls back to index.html for
// unknown paths, so deep links like /r/<slug> resolve to the SPA. Requests
// under /assets or /vendor are pure build output and 404 instead of falling
// back, avoiding index.html being served in place of a missing bundle.
func Handler(dir string) http.Handler {
	fileServer := http.FileServer(http.Dir(dir))
	index := filepath.Join(dir, "index.html")

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		clean := filepath.Clean(r.URL.Path)

		if info, err := os.Stat(filepath.Join(dir, clean)); err == nil && !info.IsDir() {
			fileServer.ServeHTTP(w, r)
			return
		}

		if strings.HasPrefix(clean, "/assets/") || strings.HasPrefix(clean, "/vendor/") {
			http.NotFound(w, r)
			return
		}

		http.ServeFile(w, r, index)
	})
}
