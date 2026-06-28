// Package migrations embeds the SQL migration files so they ship inside the
// binary and apply regardless of the process working directory.
package migrations

import "embed"

//go:embed *.sql
var FS embed.FS
