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
shape, Caddy, the unit, the monthly egress guard, the idle-reclaim guard — then
proves the site answers over HTTPS. Copy it over and pass the public name (a real domain with an A
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
| Prewarm | only a game in the cached today±1 schedule; at most 2 builds in flight, one per client and game per 30 s; a declined call returns `queued: false` |
| Global rate limit | a second bucket shared by every caller: 200 req/s, 400 burst, then `429`. A per-client bucket cannot slow a flood spread over many addresses |
| `pitcher_id` / `year` | 4–7 digits and 2008+; at most 2 Savant lookups in flight, 256 pitchers cached, then `503` |
| Schedule | `/api/live-games` is cached 15 s and single-flighted, so the drawer cannot be turned into a statsapi flood |

Three CPU amplifiers are closed in the app itself. `after_play_id` is normalized
against the current feed, so an invented cursor cannot mint a new cache entry
(and a new simulation) per request; unknown batted-ball cursors collapse into
one entry. `/api/at-bat`, which simulates every pitch in the at-bat, caches its
finished payload for 30 s (32 entries). `/api/trajectory/compare` now reuses the
live/default trajectory caches instead of building both on every call.

The rate limit keys on the client address the connection actually proves. The
API listens on loopback, so its trusted peer set is loopback only by default:
Caddy's `header_up X-Forwarded-For {remote_host}` overwrites whatever the
browser sent, and a caller that somehow reaches the port another way is keyed
on its own address with the header ignored — a forged `X-Forwarded-For` (or
`CF-Connecting-IP`) cannot manufacture a fresh bucket. `TRUSTED_PROXY_CIDRS`
(comma separated CIDRs) widens that set, and is only needed when a proxy in
front of Caddy appends to the header instead of resolving the client itself;
the CDN section covers which case applies. The parser drops unparseable CIDRs
rather than guessing, so a typo narrows trust instead of widening it.

Tune it in the unit's `Environment=` lines: `RATE_LIMIT_PER_SECOND`,
`RATE_LIMIT_BURST`, `RATE_LIMIT_GLOBAL_PER_SECOND`,
`RATE_LIMIT_GLOBAL_BURST`, `TRUSTED_PROXY_CIDRS`, and `ALLOWED_ORIGINS` (comma
separated) when the SPA is served from another origin.

## Flood protection and spend caps

Only one resource here is metered: **outbound data transfer**. Always Free
includes 10 TB/month, and on an upgraded (Pay As You Go) tenancy usage above
that is billed. 10 TB averages to roughly 31 Mbps across a month, so a sustained
100 Mbps response flood spends the whole allowance in about nine days. The
guards below are listed in the order traffic meets them.

| Layer | What it does | Where |
|---|---|---|
| CDN (recommended) | unmetered L3–7 DDoS mitigation, no bandwidth charge, and cached assets stop leaving Oracle | Cloudflare free plan, below |
| Caddy | `read_header`/`read_body`/`idle` timeouts; write methods (anything but GET/HEAD/OPTIONS) refused with `405`; `X-Forwarded-For` overwritten; `Server` removed | `deploy/Caddyfile` |
| uvicorn | `--limit-concurrency 64` answers `503` past that instead of queueing work; `--backlog 512`; 15 s keep-alive | `deploy/mlb-live.service` |
| Per-client bucket | 20 req/s, 40 burst per source address | `RATE_LIMIT_PER_SECOND` / `RATE_LIMIT_BURST` |
| Global bucket | 200 req/s, 400 burst over all sources, so a distributed flood stops reaching the expensive paths | `RATE_LIMIT_GLOBAL_PER_SECOND` / `RATE_LIMIT_GLOBAL_BURST` |
| Outbound caches | feed 1 s, schedule 15 s, trajectory per cursor, at-bat 30 s, Savant 6 h | `main.py` |
| Kernel | SYN cookies, 2048 SYN backlog, 1024 accept backlog, `rp_filter`, no source routing or redirects | `/etc/sysctl.d/60-mlb-live.conf` |
| Monthly egress guard | at 9,000 GB outbound it disables Caddy + the API; re-enables on the UTC month rollover | `deploy/egress-guard.sh` |

The box itself remains the weak point: one worker on 2 OCPU cannot absorb a
volume flood and no application code changes that. What these layers protect is
the *bill* and the *origin* — Caddy sheds connections cheaply, the buckets keep
CPU-heavy paths from being reached at all, and the kernel refuses work it cannot
queue (which is also what keeps the box from swapping itself to death).

### Put a CDN in front (the only real DDoS defence)

Cloudflare's free plan is a genuine fit for this deployment, in three ways:
DDoS mitigation is unmetered on layers 3–7 for proxied traffic, there is no
bandwidth charge, and cached assets stop leaving Oracle at all. It also includes
one rate-limiting rule at no extra cost (one on Free, two on Pro), worth pointing
at `/api/*` as a coarse backstop — its counters are per data centre, so the API's
own buckets remain the real limiter.

Two limits matter before planning around it:

- **The current hostname cannot be proxied.** `147-5-107-10.sslip.io` lives in
  sslip.io's zone, not yours, and Cloudflare only proxies records in a zone it
  hosts — a full setup means moving the domain's nameservers to Cloudflare.
  Proxying therefore needs a real domain you control; until then the box is
  reachable by IP and every origin guard on this page is what protects it.
- **It does not replace the origin guards.** Cloudflare assumes the origin is
  only reachable through it. If 443 stays open to the world, a flood can bypass
  the CDN and land on Caddy directly. The CDN is an addition, not a substitute.

Steps, in order:

1. Point a domain you control at Cloudflare, add an `A` record for the instance
   and proxy it (orange cloud), then set SSL/TLS to **Full (strict)**.
2. Give the origin a certificate Cloudflare will trust without depending on
   ACME through the proxy: build Caddy with the Cloudflare DNS module and use
   DNS-01, or install a free Cloudflare Origin CA certificate and load it with
   `tls /etc/caddy/origin.pem /etc/caddy/origin.key`. HTTP-01 only works while
   port 80 stays open and nothing redirects it, and closing 80 is the point of
   the exercise.
3. Restrict 443 at the origin to Cloudflare's published ranges, then close 80
   once the certificate no longer needs it.
4. Keep Cloudflare's visitor address arriving at the API. On the packaged
   Caddy 2.6.x that is a pass-through, not a trusted-proxy directive:

   ```caddyfile
   header_up X-Forwarded-For {header.X-Forwarded-For}
   ```

   Two measured reasons, both on this pinned 2.6.2 binary. `trusted_proxies`
   does not exist in 2.6 — the proxy refuses to load the config with
   `unrecognized servers option 'trusted_proxies'`, and the client-IP parsing it
   feeds only appears in later releases. And
   simply deleting the `header_up` line makes the proxy *replace*
   `X-Forwarded-For` with its own socket peer, so every visitor collapses into
   one bucket: in that shape one visitor who had spent the burst caused two
   unrelated visitors to be throttled on their next request. With the
   pass-through above the same test kept three independent buckets. If Caddy is
   upgraded to 2.7 or newer, `servers { trusted_proxies static <ranges> }` is the
   cleaner form; it is not used here because it has not been validated on the
   pinned version.

   The pass-through is safe only because step 3 closes 443 to everything but
   Cloudflare: the header is now taken as authoritative, so any caller able to
   reach the origin directly could choose its own bucket.
5. Keep `/api/*` out of the cache. Those endpoints answer live game state, and a
   cached 200 would freeze the app on a stale pitch. Cloudflare does not cache
   JSON by default; an explicit bypass Cache Rule records the intent. Let
   `/assets/*` cache (immutable, already hashed) and add a Cache Rule for
   `/models/*`, `/textures/*` and `/env/*` if `.glb` and `.hdr` are skipped —
   that is where the ~10 MB of first-load bytes live.

Traffic above this layer never reaches the instance, which is the only way to
keep a flood from both the CPU and the egress meter. It is also the largest
single cut to the 10 TB allowance: edge-cached assets cost nothing, and a
revalidated poll is ~300 B of headers.

### What the edge actually does (measured)

Measured through this exact Caddy 2.6.2 binary in front of this exact uvicorn
command line (`--limit-concurrency 64 --backlog 512`), with the app's default
limits, over HTTP to the proxy port. "Allowed" means the request reached the
app; the probe route answers `400` without an outbound fetch, so no MLB traffic
is involved except where noted. Outbound fetches were counted by the app's own
CONNECT requests to statsapi.

| Probe | Result |
|---|---|
| 120 requests, one client, no pause | 41 allowed, **79 × 429** in 60 ms; allowed again 2.5 s later |
| Two real peers (IPv4 and IPv6 loopback) | peer A: 40 of 70 allowed then 429; peer B: 5 of 5 allowed |
| 10 requests with unique `X-Forwarded-For` + `CF-Connecting-IP` after the bucket was spent | **0 allowed, 10 × 429** |
| The same with `TRUSTED_PROXY_CIDRS=10.0.0.0/8` (peer not trusted) | 0 allowed, 10 × 429 |
| 70 simultaneous requests | 40 × 200, 23 × 429, **7 × 503**; next request 400, process healthy |
| 20 identical `/api/live-games` from a cold 15 s cache | 1 statsapi fetch, then **19 requests with 0 fetches** |
| 440 requests from 220 distinct client keys | 410 allowed, 30 × 429; a brand-new key mid-flood got **429**, allowed after 3 s |
| 660 requests to `/api/live-games` from 220 keys | 502 allowed, 158 × 429, **1** outbound fetch |
| 100 requests, each naming a different `game_pk` | 100 allowed, **100 outbound fetches** |

The last row is the honest limit. The global bucket bounds how fast work
arrives (200/s), not what each request costs, so a distributed flood naming
different games still produces one MLB fetch per allowed request. And the box
cannot absorb volume at all: at 70 simultaneous requests one worker already
refused 7 and the shared bucket refused 23 more. A sustained flood saturates the
2 OCPU instance and its uplink long before Caddy can answer `429`, which is why
the CDN plus a firewalled origin is the only defence against volume — nothing in
this repository can out-serve a link flood.

### Validation status

`caddy validate` on the deployed Caddyfile and the CDN variant both report
`Valid configuration`, and the backend suite covers the limiter, the trusted
proxy decision and the caches offline. The systemd unit was **not** validated on the macOS workstation (no systemd and
no container runtime to borrow one). It was installed on the VM on 2026-11-06
and `systemd-analyze verify` reported no problems with `mlb-live.service`,
`mlb-egress-guard.service` or `mlb-egress-guard.timer` — the only output was
about unrelated, pre-existing Oracle agent units. `bash -n` and a dry run
against a fake `/sys/class/net` exercise the egress guard's baseline, latch and
month-rollover paths.

### Edge package patches

Ubuntu ships Caddy 2.6.2, far behind upstream 2.11; Ubuntu backports security
fixes into `2.6.2-6ubuntu0.24.04.x`, so the package revision matters more than
the upstream tag. The 2026 advisories include a host-routing bypass through
Host-header casing (CVE-2026-27588), underscore-header identity injection via
`forward_auth` + FastCGI (CVE-2026-52845), and admin-API issues
(CVE-2026-27589). This deployment uses one host block, no `forward_auth`, no
FastCGI and no `vars_regexp`, and the admin API is now `admin off`, so those
paths are not reachable here — but the package still needs its patches:

```bash
apt policy caddy
sudo apt-get update && sudo apt-get install --only-upgrade caddy
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl restart caddy
```

Verified on the VM on 2026-11-06: `2.6.2-6ubuntu0.24.04.3` is installed and is
also the current `noble-updates`/`noble-security` candidate. Re-check with
`apt policy caddy` after `apt-get update`; the package revision, not the
upstream `2.6.2` tag, carries the backported fixes.

### Exposed directly: per-IP connection cap

Without a CDN, cap how fast one address may open new connections. Polling rides
keep-alive, so this only throttles connection churn:

```bash
sudo iptables -I INPUT -p tcp --dport 443 -m conntrack --ctstate NEW \
  -m hashlimit --hashlimit-name mlb443 --hashlimit-mode srcip \
  --hashlimit-above 60/minute --hashlimit-burst 10 -j DROP
sudo netfilter-persistent save
```

Do **not** install this with a CDN in front: every connection then arrives from
the CDN's addresses and the rule throttles all visitors at once.

`setup-vm.sh` installs `/etc/sysctl.d/60-mlb-live.conf` (SYN cookies, backlog
sizes, reverse-path filtering) and deliberately stops there.

### Keeping the bill at zero

- **Budgets → Create Budget**, scoped to the compartment, amount `$1`, alerts
  at 50 % and 100 % to an address you read. Budgets are free and do not cap
  anything; they only tell you.
- **Billing → Cost Analysis** once a month. For this shape the only line that
  can move is outbound transfer beyond 10 TB; compute, block storage under
  200 GB and the reserved public IP sit inside Always Free (confirm the IP in
  your own tenancy rather than taking it on faith).
- The Always Free flexible load balancer is capped at 10 Mbps and filters
  nothing. It is not a substitute for the CDN; it would only add a hop.
- The other way this starts costing money is a bigger shape, a larger boot
  volume, or a second instance "to handle load". None of those is needed for a
  game-night audience, and the caches above are what make that true.

### The egress circuit breaker (installed by `setup-vm.sh`)

Budgets only alert; they do not stop usage. The one resource that can actually
bill is outbound transfer, so the box carries a hard stop. Every five minutes
`mlb-egress-guard.timer` reads the interface transmit counters, adds the delta
to a UTC-month total in `/var/lib/mlb-egress-guard/state`, and at
`EGRESS_LIMIT_GB` (default **9000**, i.e. 1 TB below the 10 TB allowance)
disables `caddy` and `mlb-live`. When the month rolls over it re-enables them.
All interface egress is counted, not only HTTP, which is the conservative
reading.

It starts counting at installation: the first run baselines the counters, so
bytes sent before the guard existed are not retroactively charged to the month.
Check it with:

```bash
sudo cat /var/lib/mlb-egress-guard/state   # "YYYY-MM total_bytes last_raw" (root-only)
journalctl -t mlb-egress-guard -n 20       # latch / reset decisions
systemctl list-timers mlb-egress-guard.timer
```

To change the cap, edit `/etc/default/mlb-egress-guard` and restart the timer.
To clear a latch early (after confirming the traffic was legitimate and the
budget still has room), remove the latch and start the services:

```bash
sudo rm -f /var/lib/mlb-egress-guard/latched
sudo systemctl enable --now caddy mlb-live
```

A latch is a deliberate outage, not a failure: the site returns a connection
error until the month changes or an operator clears it. That is the only way an
application on a metered link can promise the bill stays at zero.

### Verified spend state (2026-11-06)

Read with the `oci` CLI against the tenancy that owns `147.5.107.10`:

| Check | Result |
|---|---|
| Compute instances | 1 — `mlb-live`, `VM.Standard.A1.Flex`, 2 OCPU / 12 GB, `RUNNING` (Always Free shape) |
| Boot volumes | 1 — 47 GB (Always Free allows 200 GB total) |
| Block volumes | none |
| Load balancers | none |
| Reserved public IPs | 1 — `147.5.107.10`, `ASSIGNED` (no charge for a reserved IP) |
| Budget | `$1`/month, 2 alert rules, actual spend `$0.00` |
| Usage API, Oct 2026 | 0 cost rows, `$0.00` |
| Usage API, 1–6 Nov 2026 | `$0.00` |

The budget is a notification, not a cap; the egress guard above is the cap.
Re-check after any shape, volume, instance or load-balancer change:

```bash
TENANCY=ocid1.tenancy.…
oci compute instance list --compartment-id "$TENANCY" --all
oci bv boot-volume list --compartment-id "$TENANCY" --all
oci lb load-balancer list --compartment-id "$TENANCY" --all
oci budgets budget budget list --compartment-id "$TENANCY" --all
```

## Live verification (2026-11-06)

Installed from this working tree and checked over the public hostname:

| Check | Result |
|---|---|
| Edge | `/` and `/api/live-games` `200`; HSTS, CSP, `X-Frame-Options`, `nosniff`, `Referrer-Policy` and `Permissions-Policy` present; no `Server` header |
| Docs | `/docs` and `/openapi.json` return the 2,075-byte SPA |
| CORS | `https://misterissac.github.io` granted, `https://evil.example` not granted |
| Caddy admin | `127.0.0.1:2019` refuses the connection (`admin off`) |
| Rate limit, public IP | 80-request burst, 20 concurrent: 51 × `200`, 29 × `429` |
| Rate limit, loopback | 80-request burst, 20 concurrent: 72 × `200`, 8 × `429`; 20 parallel TLS handshakes let the 20/s bucket refill between them |
| Cursor normalization | `after_play_id=invented-a` then `invented-b`: 0.295 s / 0.072 s, both 164,830 B; the second request logs `TRAJECTORY CACHE HIT` |
| Compare reuse | first call hits the live cache and builds default; second call logs `TRAJECTORY CACHE HIT` for both `env=live` and `env=default` |
| At-bat cache | first call 0.284 s, second 0.125 s, same 668,456 B payload |
| Egress guard | timer active, next run in 5 min, baselined at 353,377,211 bytes, no latch; the one-shot exits `0` |
| Services | `mlb-live` active, `NRestarts=0`, `ExecMainStatus=0`; Caddy active |
| Package | `caddy 2.6.2-6ubuntu0.24.04.3`, the current `noble-updates`/`noble-security` candidate |
| Deployed hashes | `main.py`, `Caddyfile`, both units, the timer and the guard script match this working tree byte-for-byte |
| Unit verification | `systemd-analyze verify` clean for the three project units; only unrelated Oracle agent warnings |

The timings are single observations, not a benchmark. The rate-limit bursts
come from one address; a flood spread over many addresses is still bounded only
by the global bucket and the edge firewall/CDN, as above.

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

Measured on the live box rather than derived from body size: a repeat poll of
`/api/trajectory` transferred **300 B** in Chromium while reporting
`encodedBodySize` 60,687 B and `decodedBodySize` 164,832 B. Transfer far below
the encoded body is the signature of a revalidated cache hit, so at the 1 s
cadence (`LIVE_POLL_MS` in `frontend/src/App.jsx`) an idle tab costs roughly
1 MB/hour. Sending the body every second instead would cost about 220 MB/hour;
that figure is the reason the validators exist, not the current cost. A new
pitch advances `after_play_id`, which is a different URL and so one real body —
that per-pitch cost, not the poll interval, is what a live viewer actually pays.

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
