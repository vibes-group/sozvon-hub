// Package testutil provides shared helpers for the backend test suites: each
// test gets a fresh, fully-migrated SQLite database on a temp-file path (the
// pure-Go driver is file-based, so an in-memory shared cache is avoided).
package testutil

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"

	"sozvon-hub/backend/internal/db"
	"sozvon-hub/backend/migrations"
)

// NewDB opens a real SQLite database in a per-test temp directory with every
// migration applied, and registers cleanup that closes it.
func NewDB(t *testing.T) *sql.DB {
	t.Helper()
	database, err := db.OpenSQLite(context.Background(), db.SQLiteConfig{
		Path:       filepath.Join(t.TempDir(), "test.db"),
		Migrations: migrations.FS,
	})
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	return database
}
