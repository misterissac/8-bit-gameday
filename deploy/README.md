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

```bash
sudo adduser --system --group --home /srv/mlb-live mlb
sudo -u mlb git clone <repo> /srv/mlb-live
sudo -u mlb python3 -m venv /srv/mlb-live/venv
sudo -u mlb /srv/mlb-live/venv/bin/pip install -r /srv/mlb-live/backend/requirements.txt

# Frontend build. The default base is "/" — the app is served from the domain
# root here, so no VITE_BASE is needed.
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
3. Push a change under `frontend/` to `main`, or run the workflow manually.

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
percentile above the threshold:

```cron
*/10 * * * * timeout 60 sha256sum /dev/zero > /dev/null
```

## Capacity

One worker on 2 OCPU is the intended shape. Raising `--workers` doubles the
statsapi fetches and the trajectory builds, because every cache in `main.py` is
per-process — measure before changing it, and see the payload/short-circuit work
first if 60 viewers at 1 Hz is the target.
