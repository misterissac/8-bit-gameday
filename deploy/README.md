# Deploying on an Oracle Always Free VM

Target shape: one Ampere A1 instance (2 OCPU / 12 GB), Caddy on 80/443 serving
the built SPA, uvicorn on `127.0.0.1:8000` behind it. Both files here assume the
checkout lives at `/srv/mlb-live` and runs as a `mlb` user.

## Prerequisites

1. **Nothing extra to fetch.** The simulator is vendored in the repo
   (`backend/MyBallTrajectorySim.py`, `backend/statcast_to_sim.py`), so
   `pip install -r backend/requirements.txt` is the whole setup. Both are MIT;
   see `backend/MyTrajectorySimulator.LICENSE`.
2. Open 80 and 443 in the instance's security list. Do **not** open 8000;
   uvicorn binds to loopback only.
3. Ubuntu 22.04/24.04 arm64, with `python3-venv` and `git` installed.

## Install

### One-shot script

[`deploy/setup-vm.sh`](setup-vm.sh) performs every step below — host firewall,
packages, service user, checkout, venv, swap and a tighter `MemoryMax` on a 1 GB
shape, Caddy, the unit, the idle-reclaim guard — then proves the site answers
over HTTPS. Copy it over and pass the public name (a real domain with an A
record, or the sslip.io name built from the IP):

```bash
scp deploy/setup-vm.sh ubuntu@<ip>:~/
ssh ubuntu@<ip> 'bash setup-vm.sh 203-0-113-10.sslip.io'
```

It does not build the SPA: Vite 8 needs Node >= 20.19, which Ubuntu's `nodejs`
package is not. Build locally, copy `frontend/dist` to the box, and re-run with
`DIST_SRC` pointing at it. That second run installs the build and finishes the
certificate check:

```bash
npm --prefix frontend run build
rsync -az frontend/dist/ ubuntu@<ip>:/tmp/mlb-dist/
ssh ubuntu@<ip> 'DIST_SRC=/tmp/mlb-dist bash setup-vm.sh 203-0-113-10.sslip.io'
```

Run the script as `ubuntu`, not under `sudo`: it escalates internally, and an
environment variable set outside the escalation would not reach it. Re-running
it is safe.

The manual steps below are what it automates.

```bash
sudo adduser --system --group --home /srv/mlb-live mlb
sudo -u mlb git clone <repo> /srv/mlb-live
sudo -u mlb python3 -m venv /srv/mlb-live/venv
sudo -u mlb /srv/mlb-live/venv/bin/pip install -r /srv/mlb-live/backend/requirements.txt

# Frontend build. The default base is "/" — the app is served from the domain
# root here, so no VITE_BASE is needed. Needs Node >= 20.19; otherwise build on
# your laptop and copy dist/ over, as the script section describes.
cd /srv/mlb-live/frontend
sudo -u mlb npm ci
sudo -u mlb npm run build
```

`VITE_API_BASE` only matters when the frontend is built somewhere else — for
example GitHub Pages, where `npm run build` needs
`VITE_BASE=/<repo>/ VITE_API_BASE=https://<backend-host>`.

## Caddy

```bash
sudo apt install -y caddy
sudo cp /srv/mlb-live/deploy/Caddyfile /etc/caddy/Caddyfile
# Pick the public name once; sslip.io needs no DNS record.
sudo mkdir -p /etc/systemd/system/caddy.service.d
printf '[Service]\nEnvironment=SITE_ADDRESS=203-0-113-10.sslip.io\n' \
  | sudo tee /etc/systemd/system/caddy.service.d/site.conf
sudo systemctl daemon-reload
sudo caddy validate --config /etc/caddy/Caddyfile   # do this before restarting
sudo systemctl enable --now caddy
```

With a real domain, point its A record at the instance and use that name
instead of the sslip.io one; Caddy issues and renews the certificate itself.

## API service

```bash
sudo cp /srv/mlb-live/deploy/mlb-live.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now mlb-live
sudo systemctl status mlb-live --no-pager
```

`main.py` still runs `uvicorn.run(..., reload=True)` when executed directly —
the unit does not do that, it calls uvicorn with `--workers 1`, so the reloader
is not involved.

## Verify

```bash
curl -I https://$SITE_ADDRESS/                       # 200, text/html
curl -s https://$SITE_ADDRESS/api/game-status | head -c 200
ss -ltnp | grep 8000                                 # 127.0.0.1:8000 only
curl -s https://$SITE_ADDRESS/assets/<hashed>.js -I  # immutable, gzip/zstd
```

Then load the site once in a browser: the 3D models (`/models/player.glb`,
`/textures/*.png`) should return 200 from the same origin.

## Public behaviour

The API is guarded now that it has a public address. All of it is offline-safe:
nothing here calls out to MLB.

| Guard | Behaviour |
|---|---|
| `game_pk` | must be 5–7 digits; anything else is `400` before statsapi is called |
| Rate limit | per-client token bucket, 20 req/s sustained, 40 burst, then `429` + `Retry-After` |
| CORS | same-origin only; the default allowlist is the Vite dev server |
| Prewarm | at most 2 builds in flight, one per client and game per 30 s; a declined call returns `queued: false` |

The rate limit keys on `X-Forwarded-For`. Caddy already ignores a client's value
for that header by default; the `header_up X-Forwarded-For {remote_host}` line
makes it explicit. If you ever put a CDN in front of Caddy, replace that line
with Caddy's `trusted_proxies` setting, or every visitor will share one bucket.

Tune it in the unit's `Environment=` lines: `RATE_LIMIT_PER_SECOND`,
`RATE_LIMIT_BURST`, and `ALLOWED_ORIGINS` (comma separated) when the SPA is
served from another origin.

## Polling

The four endpoints the frontend polls (`/api/trajectory`, `/api/batted-ball`,
`/api/game-state`, `/api/game-status`) answer an unchanged repeat with `304` and
no body. Each carries a strong `ETag` and `Cache-Control: no-cache`, so the
browser keeps the body it already holds and asks whether it is still current: a
quiet second costs a few hundred bytes of headers instead of 1–155 KB of JSON.
Revalidation is the browser's job — nothing in the frontend sets a validator.

## GitHub Pages frontend (optional)

`.github/workflows/pages.yml` builds `frontend/` and publishes `frontend/dist` to
GitHub Pages. Only the static app moves; the API stays on the VM, so the VM must
be reachable over HTTPS first.

One-time setup:

1. **Settings → Pages → Build and deployment → Source: GitHub Actions.** The
   workflow's `configure-pages` step fails until this is selected.
2. **Settings → Secrets and variables → Actions → Variables → New repository
   variable:** `VITE_API_BASE = https://<backend-host>` (no trailing slash, no
   `/api` suffix). It is baked into the bundle, so a backend move needs a
   workflow re-run, not a new push of static files.
3. Add the Pages origin to the API, or the browser blocks the calls:
   `Environment=ALLOWED_ORIGINS=https://misterissac.github.io` in a drop-in for
   `mlb-live.service`.
4. Push a change under `frontend/` to `main`, or run the workflow manually.

The site is served at `https://<owner>.github.io/<repo>/`. The workflow reads
the base from the Pages API (`/8-bit-gameday/` for a project site, `/` for a
custom domain), passes it to Vite as `VITE_BASE`, and fails before uploading if
`index.html` or the API origin in the bundle do not carry it. Vite rewrites
`/assets`; `src/util/assetUrl.js` prefixes the models and textures in `public/`;
`src/util/apiBase.js` prefixes the API calls.

CORS: the backend answers `Access-Control-Allow-Origin: *` without credentials,
so the Pages origin is accepted as-is. If that list is narrowed later, add
`https://<owner>.github.io`.

## Keep it from being reclaimed

Oracle may reclaim an Always Free instance whose **7-day p95** CPU, network and
memory are all under 20%. A game-night workload is idle most of the day, so p95
sits near zero between series. A short burn every ten minutes keeps the CPU
percentile above the threshold; `setup-vm.sh` installs it as
`/etc/cron.d/mlb-keepalive`. To add it by hand:

```cron
*/10 * * * * timeout 60 sha256sum /dev/zero > /dev/null
```

## Capacity

One worker on 2 OCPU is the intended shape. Raising `--workers` doubles the
statsapi fetches and the trajectory builds, because every cache in `main.py` is
per-process — measure before changing it, and see the payload/short-circuit work
first if 60 viewers at 1 Hz is the target.
