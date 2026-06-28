# sozvon-hub

Быстрые видеозвонки по ссылке. Self-hosted, Jitsi-like.

- Аккаунты по приглашениям: зарегистрироваться можно только по ссылке от уже зарегистрированного пользователя.
- Комнаты создаёт зарегистрированный пользователь и делится одноразовой ссылкой. По ссылке заходит любой.
- Звонок: аудио (Opus + шумоподавление), видео с камеры, демонстрация экрана. SFU на Pion, без E2EE.

## Локальная разработка

```bash
docker compose -f docker-compose.dev.yml up -d --build
```

Открыть `http://localhost:8080`.

Фронт с HMR отдельно:

```bash
docker compose -f docker-compose.dev.yml up -d app --build
cd frontend && npm install && npm run dev
```

## Production

Сервер + GitHub Actions + Caddy (репозиторий `vibes-group/infra`). Push в `master` → деплой.
