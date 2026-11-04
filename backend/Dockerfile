FROM node:24.22-bookworm-slim@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c AS frontend

WORKDIR /src/frontend

COPY frontend/package.json frontend/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci

COPY frontend ./
RUN --mount=type=cache,target=/root/.npm npm run build

FROM golang:1.27-bookworm@sha256:05237276236793ebedaf0b87dab86add9ec9adc66ebef2dbc3107c18254cde1c AS build

WORKDIR /src

COPY backend/go.mod backend/go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    go mod download

COPY backend ./

RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=linux \
    go build -ldflags="-s -w" -o /out/sozvon-hub-app ./cmd/server

FROM debian:13-slim@sha256:89c1ea91e897f0fe0a3731595330bc45b8bdef4047464a07116f891a94054b31

RUN apt-get update \
 && apt-get upgrade -y \
 && apt-get install -y --no-install-recommends ca-certificates wget \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd -r app && useradd -r -g app -u 10001 -d /app -s /sbin/nologin app

WORKDIR /app

COPY --from=build /out/sozvon-hub-app /app/sozvon-hub-app
COPY --from=frontend /src/frontend/dist /app/web

RUN mkdir -p /app/data && chown app:app /app/data

ENV APP_ADDR=:8080
ENV APP_WEB_DIR=/app/web

EXPOSE 8080

USER app:app

CMD ["/app/sozvon-hub-app"]
