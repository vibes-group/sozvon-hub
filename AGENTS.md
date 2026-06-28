# Rules for AI agents

Repository is **public**. Every commit is visible.

## Never commit

- Real names, emails, phones, messenger handles
- Absolute home paths — use `~` or relative
- Real hosts / IPs of prod/dev servers — use placeholders
- `.env` contents, tokens, keys, passwords, session/TURN secrets
- Output of `whoami`, `hostname`, `id`, `env`

## Doc style

- README and comments — signal only. Don't explain the obvious.
- No planning `*.md` files in the repo. Plans live in PRs/tickets.
- Before PR: grep for «not yet» / «TODO» on shipped features.

## Product voice

- UI copy is Russian, understandable without English. Plain, restrained labels
  («Создать комнату», «Войти», «Настройки»).

## Architecture

- Quick video calls, Jitsi-like. Pion WebRTC SFU embedded in the Go process,
  JSON-over-WebSocket signaling. Audio (Opus + RNNoise), camera video, screen
  share. **No E2EE** — media transits the SFU in the clear.
- Accounts are invite-only (register via a link from an existing user). Only
  registered users create rooms; anyone with a room link can join as a guest.
- Rooms are ephemeral one-time links.

## Env naming

| Tier | Prefix |
|------|--------|
| App-level | `APP_*` |
| Subsystem (≥2 vars) | `<DOMAIN>_*` (`AUTH_*`, `TURN_*`) |
| Infra context | no prefix (`IMAGE_TAG`, `PUBLIC_IP`) |

Range pairs: `<NAME>_MIN` / `<NAME>_MAX`. Required vars have no defaults, crash
on startup. Secrets only via env, never as flags, never logged.

## Git

- Conventional commits (`feat:`, `fix:`, `chore:`, `refactor:`).
- No `--amend` on published commits, no force-push to `master`.
