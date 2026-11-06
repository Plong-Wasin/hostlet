# Hostlet

A small authenticated web app that publishes an application through an existing, remotely managed Cloudflare Tunnel without opening the Cloudflare Dashboard.

Log in, type only a **Subdomain**, check the **Hostname** preview, press Create. Hostlet adds the Ingress Rule (before the Tunnel catch-all, keeping every existing rule) and a proxied CNAME DNS Record, then reports `created`, `partial` or `error`. Pressing Create again after a Partial Failure finishes the missing part.

Terms are defined in [`GLOSSARY.md`](GLOSSARY.md). Design trade-offs: [`docs/adr/`](docs/adr/).

## Requirements

- A remotely managed Cloudflare Tunnel.
- A Cloudflare API token with Tunnel edit and DNS edit permission.
- [Bun](https://bun.sh) 1.x, or Docker.

## Configuration

All configuration is environment variables. Startup fails fast, naming the variable, when one is missing or `SESSION_SECRET` is shorter than 32 characters.

| Variable | Meaning |
| --- | --- |
| `ADMIN_USERNAME`, `ADMIN_PASSWORD` | The single operator login |
| `SESSION_SECRET` | Signs the session cookie, 32+ chars |
| `CLOUDFLARE_API_TOKEN` | API token |
| `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_ZONE_ID`, `CLOUDFLARE_TUNNEL_ID` | Where to write |
| `DOMAIN` | Base domain, e.g. `example.com` |
| `SERVICE_URL` | Origin every new Ingress Rule points at |
| `PORT` | Optional, default `3000` |
| `CLOUDFLARE_API_BASE` | Optional, default the real Cloudflare API; tests point it at a fake |

`cp .env.example .env` and fill it in.

## Run

```sh
# Bun
bun install
set -a; . ./.env; set +a
bun start

# Docker (local, publishes port 3000)
docker compose up --build
```

Health check: `GET /healthz`.

## Develop

```sh
bun test            # black-box tests against a fake Cloudflare server
bunx tsc --noEmit   # type check
```

`tests/container-deployment.test.ts` builds the image, so it needs Docker.

## Deploy on Dokploy

Use `docker-compose.dokploy.yml`. Set the variables in Dokploy's Environment UI, attach the domain to the `app` service on container port `3000`, and add no ports or Traefik labels. Run exactly one replica. Keep `SESSION_SECRET` unchanged across redeploys.

## Security notes

- Session: signed, HttpOnly, SameSite=Strict cookie, 24 hours. Logout clears the cookie; there is no server-side revoke, so rotate `SESSION_SECRET` to revoke everyone.
- Login is limited to 5 failed attempts per 15 minutes per client IP (`CF-Connecting-IP`).
- State-changing requests need a matching `Origin` and a JSON body.
- Cloudflare errors are sanitised before display; secrets never reach the browser.
