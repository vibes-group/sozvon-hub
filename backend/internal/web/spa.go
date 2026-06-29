package web

import (
	"net/http"
	"path/filepath"
	"strings"
)

// Handler serves static assets from dir and falls back to index.html for
// unknown paths, so deep links like /r/<slug> resolve to the SPA. Requests
// under /assets or /vendor are pure build output and 404 instead of falling
// back, avoiding index.html being served in place of a missing bundle.
func Handler(dir string) http.Handler {
	root := http.Dir(dir)
	fileServer := http.FileServer(root)
	index := filepath.Join(dir, "index.html")

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		clean := filepath.Clean(r.URL.Path)

		// Resolve existence through http.Dir, which confines access to dir and
		// rejects traversal, so a crafted URL path cannot escape it.
		if f, err := root.Open(clean); err == nil {
			info, statErr := f.Stat()
			f.Close()
			if statErr == nil && !info.IsDir() {
				fileServer.ServeHTTP(w, r)
				return
			}
		}

		if strings.HasPrefix(clean, "/assets/") || strings.HasPrefix(clean, "/vendor/") {
			http.NotFound(w, r)
			return
		}

		http.ServeFile(w, r, index)
	})
}
