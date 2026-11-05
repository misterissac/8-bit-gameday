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

## Reserve the public IP

An instance launched without an explicit choice gets an **ephemeral** public IP.
It hangs off the VNIC's primary private IP, and:

- survives a stop/start and a reboot (the "stopping changes the IP" advice that
  circulates describes instances whose IP was unassigned first, not a plain
  stop);
- is **deleted with the instance** — and an Always Free instance Oracle reclaims
  for sitting idle is terminated, whatever the dashboard calls it.

A **reserved** public IP is a tenancy object instead: it stays in the compartment
after termination, sits in state `AVAILABLE`, and can be re-attached to a rebuilt
instance. Oracle does not list a charge for one, assigned or not (worth a glance
at *Billing → Cost Analysis* for your own tenancy); unassigned ones still count
against the 50-per-region limit.

OCI cannot convert an ephemeral IP into a reserved one at the same address, so
**reserving changes the public address once.** Do it before a real domain points
at the box — after that, reserving is just moving the A record.

**This deployment** already has one: `147.5.107.10`
(`ocid1.publicip.oc1.ca-toronto-1.amaaaaaa2ijmquiawfblirf6hdym2r476w6msyn275smomtai5u7t3o4avyq`),
served as `https://147-5-107-10.sslip.io`. If the instance is ever rebuilt,
re-attach that address instead of minting a new one:

```bash
oci network public-ip update \
  --public-ip-id ocid1.publicip.oc1.ca-toronto-1.amaaaaaa2ijmquiawfblirf6hdym2r476w6msyn275smomtai5u7t3o4avyq \
  --private-ip-id <new instance's primary private IP> \
  --wait-for-state ASSIGNED
```

The sslip name is derived from the address, so a different address means a
different name, and `SITE_ADDRESS` has to move with it.

### Console

1. **Networking → Reserved public IPs → Create reserved public IP.** Name it,
   pick the compartment, leave it unassigned, and copy the address.
2. **Compute → Instances → mlb-live → Attached VNICs →** primary VNIC **→ Public
   IP address →** the ephemeral row **→ Terminate.** An ephemeral IP cannot be
   unassigned, only terminated; releasing it is what frees the private IP.
3. Same **Public IP address** section **→ Assign public IP → Choose an existing
   reserved IP**, and pick the one from step 1.
4. Point `SITE_ADDRESS` at the new name and restart Caddy (below). The
   certificate is reissued for the new name over port 80/443.
5. Anything holding the old address: the Pages repository variable
   `VITE_API_BASE`, shared links, bookmarks.

### CLI

```bash
INSTANCE=ocid1.instance.…
COMPARTMENT=ocid1.tenancy.…
AD=$(oci compute instance get --instance-id "$INSTANCE" \
  --query 'data."availability-domain"' --raw-output)
VNIC=$(oci compute instance list-vnics --instance-id "$INSTANCE" \
  --query 'data[?`"is-primary"`].id | [0]' --raw-output)
PRIVATE_IP=$(oci network private-ip list --vnic-id "$VNIC" \
  --query 'data[?`"is-primary"`].id | [0]' --raw-output)

# 1. reserve one, unassigned
oci network public-ip create --compartment-id "$COMPARTMENT" \
  --lifetime RESERVED --display-name mlb-live \
  --wait-for-state AVAILABLE

# 2. find the ephemeral IP on that VNIC. Note the scope: an instance's public
#    IP is AVAILABILITY_DOMAIN-scoped, so --scope REGION lists only NAT
#    gateways and load balancers and looks empty.
oci network public-ip list --scope AVAILABILITY_DOMAIN \
  --availability-domain "$AD" --compartment-id "$COMPARTMENT" \
  --lifetime EPHEMERAL --all \
  --query 'data[].{ip:"ip-address",id:id,state:"lifecycle-state"}'

oci network public-ip delete --public-ip-id <EPHEMERAL_OCID>

# 3. assign the reserved one (asynchronous: wait for ASSIGNED)
oci network public-ip update --public-ip-id <RESERVED_OCID> \
  --private-ip-id "$PRIVATE_IP" --wait-for-state ASSIGNED
```

Then move the name:

```bash
printf '[Service]\nEnvironment=SITE_ADDRESS=%s\n' "<new-name>.sslip.io" \
  | ssh ubuntu@<new-ip> 'sudo tee /etc/systemd/system/caddy.service.d/site.conf'
ssh ubuntu@<new-ip> 'sudo systemctl daemon-reload && sudo systemctl restart caddy'
```

### Verify

```bash
# A reserved IP is a compartment object, not a VNIC property, so it is
# REGION-scoped: the AVAILABILITY_DOMAIN scope that finds the ephemeral one
# returns an empty table here and looks like the reservation failed.
oci network public-ip list --scope REGION --compartment-id "$COMPARTMENT" \
  --all --lifetime RESERVED \
  --query 'data[].{ip:"ip-address",life:lifetime,state:"lifecycle-state"}'
# expect one row: lifetime RESERVED, state ASSIGNED, the address you want
```

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

## Security headers

The site block in `deploy/Caddyfile` sets these on **every** response — the SPA,
the JSON API and the `304`s alike — so there is one place to look and no route
that quietly skips them.

| Header | Value |
|---|---|
| `Strict-Transport-Security` | `max-age=31536000` |
| `Content-Security-Policy` | below |
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `X-Frame-Options` | `DENY` |
| `Permissions-Policy` | accelerometer, camera, geolocation, gyroscope, magnetometer, microphone, payment, usb — all `()` |
| `Cross-Origin-Opener-Policy` | `same-origin` |
| `Server` | removed |

HSTS carries no `includeSubDomains` and no `preload`: the host is a name this
project may still change, and a year-long pin is awkward to take back. Add
`includeSubDomains` once the final domain's subdomains are all HTTPS too.

The CSP is derived from what the bundle actually loads, which is why it can stay
this tight:

- `script-src 'self' 'wasm-unsafe-eval'` — `index.html` has no inline script;
  Vite emits a single `type="module"` tag pointing at a hashed file. The extra
  keyword is not `'unsafe-eval'`: it permits WebAssembly instantiation and
  nothing else, and the DRACO decoder starts a WASM module.
- `style-src 'self' 'unsafe-inline'` — the React tree writes `style` attributes
  and there is no nonce to hand them. Styles are the only `unsafe-inline` left.
- `img-src 'self' data: blob: https://img.mlbstatic.com` — the batter headshot
  on the ballpark's video board is the only cross-origin image. It is loaded
  with `crossOrigin="anonymous"` so the canvas can read its pixels; if that URL
  ever moves host, this line has to move with it or the board goes blank.
- `connect-src 'self' blob: …` — every API call is same-origin because this
  Caddy serves both halves; `blob:` is needed because GLTFLoader turns embedded
  textures into object URLs and fetches them. The two named hosts are
  first-frame dependencies of the 3D stack, not of this app: the DRACO decoder
  base is on `www.gstatic.com` and troika's unicode font resolver uses
  `cdn.jsdelivr.net`.

  drei's `<Environment preset="park" />` was a third and is gone: it resolved to
  a `raw.githack.com` URL that 302s to `raw.githubusercontent.com`, and the CSP
  evaluates the redirect target, so the env map failed and the error boundary
  took the whole canvas down. The same HDR now ships at
  `frontend/public/env/rooitou_park_1k.hdr` (1.5 MB, drei-assets @ `456060a`)
  and is loaded through `src/util/assetUrl.js` so the Pages subpath still works.
  That made the most fragile entry in this policy disappear rather than adding
  a second host to it. Because the filename is stable it is not covered by the
  `immutable` rule for `/assets/*`, so `/env/*` gets its own 30-day
  `Cache-Control`; swapping the HDR in place would serve the old one until then.
- `font-src 'self'` — Rubik ships in the repo (`frontend/src/fonts`).
- `object-src 'none'`, `frame-ancestors 'none'`, `base-uri 'self'`,
  `form-action 'self'`, `upgrade-insecure-requests` — no plugin, embed, base tag
  or form anywhere in the app, so forbidding them costs nothing.

A Pages build talks to this origin from another one, but its CSP comes from
GitHub Pages, which sends none, so it is unaffected.

A CSP fails closed in the browser, where a violation is a console message rather
than a status code — so after changing it, load the page once with devtools open
and watch the console, then confirm the headers on the wire:

```bash
curl -sSI https://$SITE_ADDRESS/ \
  | grep -iE 'content-security|strict-transport|x-frame|permissions|cross-origin'
curl -sSI https://$SITE_ADDRESS/api/game-status | grep -i content-security
```

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
