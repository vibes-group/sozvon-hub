package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	_ "github.com/ncruces/go-sqlite3/driver"
)

// Pragmas live in the DSN so they apply to every pooled connection; an Exec
// would configure only the connection that served it.
//
// _txlock=immediate: a deferred BEGIN that reads then writes can fail its lock
// upgrade (SQLITE_BUSY_SNAPSHOT, which busy_timeout cannot retry).
// temp_store=memory keeps temp files off a read-only rootfs.
const pragmaDSN = "?_txlock=immediate" +
	"&_pragma=busy_timeout(5000)" +
	"&_pragma=foreign_keys(on)" +
	"&_pragma=journal_mode(wal)" +
	"&_pragma=synchronous(normal)" +
	"&_pragma=temp_store(memory)"

type SQLiteConfig struct {
	Path string
	// Migrations is the filesystem holding the *.sql migration files; the
	// caller passes an embed.FS so migrations ship inside the binary.
	Migrations fs.FS
}

func OpenSQLite(ctx context.Context, cfg SQLiteConfig) (*sql.DB, error) {
	if cfg.Path == "" {
		return nil, errors.New("sqlite path is required")
	}

	if err := os.MkdirAll(filepath.Dir(cfg.Path), 0o700); err != nil {
		return nil, fmt.Errorf("create sqlite dir: %w", err)
	}

	database, err := sql.Open("sqlite3", "file:"+cfg.Path+pragmaDSN)
	if err != nil {
		return nil, fmt.Errorf("open sqlite: %w", err)
	}

	database.SetMaxOpenConns(2)
	database.SetMaxIdleConns(2)
	database.SetConnMaxLifetime(time.Hour)

	if err := database.PingContext(ctx); err != nil {
		database.Close()
		return nil, fmt.Errorf("ping sqlite: %w", err)
	}

	if err := migrate(ctx, database, cfg.Migrations); err != nil {
		database.Close()
		return nil, err
	}

	return database, nil
}

func migrate(ctx context.Context, database *sql.DB, migrations fs.FS) error {
	if migrations == nil {
		return errors.New("migrations filesystem is required")
	}
	if _, err := database.ExecContext(ctx, `
		create table if not exists schema_migrations (
			version text primary key,
			applied_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
		)
	`); err != nil {
		return fmt.Errorf("ensure schema_migrations: %w", err)
	}

	entries, err := fs.ReadDir(migrations, ".")
	if err != nil {
		return fmt.Errorf("read migrations: %w", err)
	}

	var names []string
	for _, entry := range entries {
		if !entry.IsDir() && strings.HasSuffix(entry.Name(), ".sql") {
			names = append(names, entry.Name())
		}
	}
	sort.Strings(names)

	for _, name := range names {
		applied, err := migrationApplied(ctx, database, name)
		if err != nil {
			return err
		}
		if applied {
			continue
		}
		if err := applyMigration(ctx, database, migrations, name); err != nil {
			return err
		}
	}

	return nil
}

func migrationApplied(ctx context.Context, database *sql.DB, name string) (bool, error) {
	var version string
	err := database.QueryRowContext(ctx,
		`select version from schema_migrations where version = ?`,
		name,
	).Scan(&version)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("check migration %s: %w", name, err)
	}
	return true, nil
}

func applyMigration(ctx context.Context, database *sql.DB, migrations fs.FS, name string) error {
	contents, err := fs.ReadFile(migrations, name)
	if err != nil {
		return fmt.Errorf("read migration %s: %w", name, err)
	}

	tx, err := database.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin migration %s: %w", name, err)
	}
	defer tx.Rollback()

	if _, err := tx.ExecContext(ctx, string(contents)); err != nil {
		return fmt.Errorf("apply migration %s: %w", name, err)
	}

	if _, err := tx.ExecContext(ctx,
		`insert into schema_migrations (version) values (?)`,
		name,
	); err != nil {
		return fmt.Errorf("record migration %s: %w", name, err)
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit migration %s: %w", name, err)
	}

	return nil
}
