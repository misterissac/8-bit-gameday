#!/usr/bin/env bash
#
# One-shot setup for the 8-bit Play-by-play VM. Run this ON the instance, after
# it is RUNNING and you can `ssh ubuntu@<ip>`.
#
#   scp deploy/setup-vm.sh ubuntu@<ip>:~/
#   ssh ubuntu@<ip> 'sudo bash setup-vm.sh 130-61-12-34.sslip.io'
#
# The argument is the public name Caddy should serve and get a certificate for:
# either a real domain whose A record already points at the instance, or the
# sslip.io name that encodes the public IP (203.0.113.10 -> 203-0-113-10.sslip.io).
#
# What it does, in order: opens 80/443 above Oracle's image-level iptables
# REJECT rule, installs git/python3-venv/rsync/curl/caddy, creates the `mlb`
# service user and a shallow checkout at /srv/mlb-live, builds the venv, adds
# swap and a tighter MemoryMax on a 1 GB shape, installs the Caddyfile, unit
# and monthly egress guard from deploy/, then proves the site answers over HTTPS.
#
# It does NOT build the SPA: Vite 8 needs Node >= 20.19, which Ubuntu's nodejs
# package is not. Build on your laptop and copy frontend/dist here; the script
# prints the exact rsync command if the directory is still empty.
#
# Re-running is safe. Packages, the user and the venv are only created when
# missing, the checkout is fast-forwarded, and the Caddyfile and unit are
# refreshed from the checkout each time.
#
# Overridable for a staged test: APP_DIR, APP_USER, REPO_URL, BRANCH, MEMINFO.
# DIST_SRC=/tmp/mlb-dist installs an already-uploaded SPA build (rsync it from
# the laptop first; this is how the build reaches a box that has no Node).
set -euo pipefail

APP_DIR=${APP_DIR:-/srv/mlb-live}
APP_USER=${APP_USER:-mlb}
REPO_URL=${REPO_URL:-https://github.com/misterissac/8-bit-gameday.git}
BRANCH=${BRANCH:-main}
MEMINFO=${MEMINFO:-/proc/meminfo}

SITE=
DIST_OK=0

say()  { printf '\n==> %s\n' "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die()  { printf 'error: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

# sudo when we are not root; plain execution otherwise.
run() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  else
    sudo "$@"
  fi
}

# Run as the service user with that user's HOME, so git and pip do not try to
# read root's or ubuntu's dotfiles.
as_user() { sudo -H -u "$APP_USER" "$@"; }

usage() {
  cat >&2 <<'EOF'
usage: sudo bash setup-vm.sh <site-address>

  <site-address>  public hostname Caddy should serve, e.g.
                  130-61-12-34.sslip.io   (encodes the public IPv4)
                  play.example.com        (A record must already point here)
EOF
  exit 1
}

normalize_site() {
  local s=$1
  s=${s#http://}
  s=${s#https://}
  s=${s%%/*}
  printf '%s' "$s"
}

mem_total_mb() {
  awk '/^MemTotal:/ { printf "%d", $2 / 1024; exit }' "${1:-/proc/meminfo}"
}

# Insert an ACCEPT rule above the image's blanket REJECT rather than appending
# below it, which is where Oracle's Ubuntu image puts a catch-all reject.
open_port() {
  local port=$1
  if run iptables -C INPUT -p tcp --dport "$port" -j ACCEPT 2>/dev/null; then
    info "tcp/$port already accepted"
    return 0
  fi
  local reject
  reject=$(run iptables -L INPUT -n --line-numbers 2>/dev/null \
    | awk '$2 == "REJECT" { print $1; exit }')
  if [ -n "$reject" ]; then
    run iptables -I INPUT "$reject" -p tcp --dport "$port" -j ACCEPT
  else
    run iptables -A INPUT -p tcp --dport "$port" -j ACCEPT
  fi
  info "accepted tcp/$port above the REJECT rule"
}

preflight() {
  [ "$(uname -s)" = "Linux" ] || die "this script targets the Linux VM, not $(uname -s)"
  have apt-get || die "apt-get not found — this does not look like Ubuntu"
  have sudo || die "sudo not found; run as a user that can sudo"
  if [ "$(id -u)" -ne 0 ]; then
    # `sudo -v` refreshes the credential cache and asks for a password even
    # with NOPASSWD; testing a real command is what actually proves the rule.
    sudo -n true 2>/dev/null || die "sudo needs a password; this script expects passwordless sudo"
  fi
  local free_mb
  free_mb=$(df -Pk / | awk 'NR == 2 { print int($4 / 1024) }')
  if [ "${free_mb:-0}" -lt 2500 ]; then
    warn "only ${free_mb} MB free on /; the venv, caddy and the checkout want ~2 GB"
  fi
}

step_packages() {
  say "Installing packages"
  run env DEBIAN_FRONTEND=noninteractive apt-get update -qq
  run env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
    -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold \
    git python3-venv python3-pip rsync curl caddy cron
  if ! run env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
    -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold \
    iptables-persistent; then
    warn "iptables-persistent unavailable; the firewall rules will not survive a reboot"
  fi
}

step_firewall() {
  say "Host firewall (the security list is a separate layer)"
  if ! have iptables; then
    warn "iptables not found; skipping the host firewall step"
    return 0
  fi
  open_port 80
  open_port 443
  if have netfilter-persistent; then
    run netfilter-persistent save
    info "saved to /etc/iptables/rules.v4"
  fi
}

# Kernel-level flood handling. None of this filters legitimate traffic; these
# are the settings that make a SYN flood and a connection-table overflow cost an
# attacker more than they cost this box. A per-IP connection limit is
# deliberately NOT installed here: if a CDN is later put in front, every
# connection arrives from its addresses and such a rule would throttle every
# visitor at once. The README describes the rule to add when the box is exposed
# directly.
step_sysctl() {
  say "Kernel network hardening"
  run install -d -m 755 /etc/sysctl.d
  printf '%s\n' \
    '# 8-bit Play-by-play: flood handling. Written by deploy/setup-vm.sh.' \
    'net.ipv4.tcp_syncookies = 1' \
    'net.ipv4.tcp_synack_retries = 2' \
    'net.ipv4.tcp_max_syn_backlog = 2048' \
    'net.ipv4.tcp_rfc1337 = 1' \
    'net.core.somaxconn = 1024' \
    'net.ipv4.conf.all.rp_filter = 1' \
    'net.ipv4.conf.all.accept_source_route = 0' \
    'net.ipv4.conf.all.accept_redirects = 0' \
    'net.ipv4.conf.all.secure_redirects = 0' \
    'net.ipv4.icmp_echo_ignore_broadcasts = 1' \
    'net.ipv6.conf.all.accept_source_route = 0' \
    'net.ipv6.conf.all.accept_redirects = 0' \
    | run tee /etc/sysctl.d/60-mlb-live.conf >/dev/null
  if run sysctl -q -p /etc/sysctl.d/60-mlb-live.conf 2>/dev/null; then
    info "applied /etc/sysctl.d/60-mlb-live.conf"
  else
    warn "some sysctls could not be applied; the file stays in place for next boot"
  fi
}

step_checkout() {
  say "Service user and checkout"
  if ! id -u "$APP_USER" >/dev/null 2>&1; then
    run adduser --system --group --home "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"
  fi
  run install -d -m 755 -o "$APP_USER" -g "$APP_USER" "$APP_DIR"

  if [ -d "$APP_DIR/.git" ]; then
    if as_user git -C "$APP_DIR" pull --ff-only origin "$BRANCH" >/dev/null 2>&1; then
      info "fast-forwarded $APP_DIR to origin/$BRANCH"
    else
      warn "could not fast-forward $APP_DIR; using the working tree as it is"
    fi
  elif [ -z "$(ls -A "$APP_DIR")" ]; then
    as_user git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
  else
    die "$APP_DIR is not empty and is not a git checkout; move it aside first"
  fi
}

step_python() {
  say "Python environment"
  if [ ! -x "$APP_DIR/venv/bin/python" ]; then
    as_user python3 -m venv "$APP_DIR/venv"
  fi
  as_user "$APP_DIR/venv/bin/pip" install --quiet --disable-pip-version-check \
    -r "$APP_DIR/backend/requirements.txt"
  info "requirements installed (all wheels on arm64, nothing compiled)"
}

step_dist_check() {
  as_user mkdir -p "$APP_DIR/frontend/dist"
  if [ -n "${DIST_SRC:-}" ]; then
    if [ -f "$DIST_SRC/index.html" ]; then
      say "Frontend build from $DIST_SRC"
      run rsync -a --delete "$DIST_SRC"/ "$APP_DIR/frontend/dist"/
      run chown -R "$APP_USER:$APP_USER" "$APP_DIR/frontend/dist"
      info "installed $(find "$DIST_SRC" -type f | wc -l | tr -d ' ') files"
    else
      warn "DIST_SRC=$DIST_SRC has no index.html; ignoring it"
    fi
  fi
  if [ -f "$APP_DIR/frontend/dist/index.html" ]; then
    DIST_OK=1
    info "frontend build found at $APP_DIR/frontend/dist"
  else
    warn "no frontend build at $APP_DIR/frontend/dist yet"
  fi
}

# A 1 OCPU / 1 GB instance cannot hold this service in RAM. The unit's 3 GB
# MemoryMax is a cap on a bigger box, not a promise; on 1 GB it has to come down
# and the overflow has to land on swap.
step_memory() {
  local mem_mb
  mem_mb=$(mem_total_mb "$MEMINFO")
  say "Memory: ${mem_mb} MB"
  if [ "$mem_mb" -lt 1500 ]; then
    info "small shape: enabling swap and capping the service at 800M"
    if ! run swapon --show | grep -q .; then
      local avail_mb
      avail_mb=$(df -Pk / | awk 'NR == 2 { print int($4 / 1024) }')
      if [ "${avail_mb:-0}" -ge 3000 ]; then
        run fallocate -l 2G /swapfile
        run chmod 600 /swapfile
        run mkswap /swapfile >/dev/null
        run swapon /swapfile
        if ! grep -q '^/swapfile' /etc/fstab; then
          printf '/swapfile none swap sw 0 0\n' | run tee -a /etc/fstab >/dev/null
        fi
        info "2 GB swap active and in /etc/fstab"
      else
        warn "only ${avail_mb} MB free; skipping swap"
      fi
    else
      info "swap already active"
    fi
    run install -d -m 755 /etc/systemd/system/mlb-live.service.d
    printf '[Service]\nMemoryMax=800M\n' \
      | run tee /etc/systemd/system/mlb-live.service.d/memory.conf >/dev/null
  else
    run rm -f /etc/systemd/system/mlb-live.service.d/memory.conf
  fi
}

step_caddy() {
  say "Caddy"
  run install -d -m 755 /etc/caddy /etc/systemd/system/caddy.service.d
  run install -m 644 "$APP_DIR/deploy/Caddyfile" /etc/caddy/Caddyfile
  printf '[Service]\nEnvironment=SITE_ADDRESS=%s\n' "$SITE" \
    | run tee /etc/systemd/system/caddy.service.d/site.conf >/dev/null
  run systemctl daemon-reload
  # Validate before restarting: a bad Caddyfile would otherwise take the site down.
  run env SITE_ADDRESS="$SITE" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
  run systemctl enable caddy >/dev/null 2>&1 || true
  run systemctl restart caddy
  info "serving $SITE"
}

step_service() {
  say "API service"
  run install -m 644 "$APP_DIR/deploy/mlb-live.service" /etc/systemd/system/mlb-live.service
  run systemctl daemon-reload
  run systemctl enable mlb-live >/dev/null 2>&1 || true
  run systemctl restart mlb-live
}

# Outbound transfer is the only metered resource here: Always Free includes
# 10 TB/month and a Pay As You Go tenancy bills above it. No request limit can
# bound total bytes, so install a monthly circuit breaker. At EGRESS_LIMIT_GB
# (default 9000, leaving 1 TB of headroom) it disables Caddy and the API, and
# re-enables them when the UTC month rolls over. It counts all interface
# egress, not just HTTP, which is the conservative reading.
step_egress_guard() {
  say "Monthly egress guard"
  run install -m 755 "$APP_DIR/deploy/egress-guard.sh" /usr/local/sbin/mlb-egress-guard
  run install -m 644 "$APP_DIR/deploy/mlb-egress-guard.service" \
    /etc/systemd/system/mlb-egress-guard.service
  run install -m 644 "$APP_DIR/deploy/mlb-egress-guard.timer" \
    /etc/systemd/system/mlb-egress-guard.timer
  if [ ! -f /etc/default/mlb-egress-guard ]; then
    printf 'EGRESS_LIMIT_GB=%s\n' "${EGRESS_LIMIT_GB:-9000}" \
      | run tee /etc/default/mlb-egress-guard >/dev/null
  fi
  run systemctl daemon-reload
  if ! run systemctl enable --now mlb-egress-guard.timer; then
    warn "could not start mlb-egress-guard.timer; the spend guard is not active"
  fi
  info "disables caddy + mlb-live at ${EGRESS_LIMIT_GB:-9000} GB outbound this month"
}

# Oracle reclaims an Always Free instance whose 7-day p95 CPU, network and
# memory are all under 20%. A game-night service is idle most of the day, so a
# short burn every ten minutes is what keeps the CPU percentile above it.
step_reclaim_guard() {
  say "Idle-reclaim guard"
  printf '%s\n' \
    "SHELL=/bin/sh" \
    "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    "# Oracle reclaims Always Free instances whose 7-day p95 CPU, network and" \
    "# memory all sit under 20%; this keeps CPU above the line between games." \
    "*/10 * * * * root timeout 60 sha256sum /dev/zero > /dev/null" \
    | run tee /etc/cron.d/mlb-keepalive >/dev/null
  run chmod 644 /etc/cron.d/mlb-keepalive
  if ! run systemctl enable --now cron >/dev/null 2>&1; then
    warn "cron is not running; the reclaim guard will not fire"
  fi
  info "scheduled a 60 s burn every 10 minutes (/etc/cron.d/mlb-keepalive)"
}

step_verify() {
  say "Verifying"
  local i api_ok=0
  for i in $(seq 1 30); do
    if curl -fsS -m 3 -o /dev/null http://127.0.0.1:8000/openapi.json 2>/dev/null; then
      api_ok=1
      break
    fi
    sleep 1
  done
  if [ "$api_ok" -ne 1 ]; then
    warn "uvicorn is not answering on 127.0.0.1:8000"
    run systemctl status mlb-live --no-pager || true
    run journalctl -u mlb-live -n 30 --no-pager || true
    die "the API did not start; see the journal above"
  fi
  info "API answers on 127.0.0.1:8000"

  if run ss -ltn 2>/dev/null | awk '{ print $4 }' | grep -qx '127.0.0.1:8000'; then
    info "uvicorn is bound to loopback only"
  else
    warn "uvicorn is not on 127.0.0.1:8000; Caddy's /api proxy will 502"
  fi

  if [ "$DIST_OK" -eq 0 ]; then
    warn "skipping the HTTPS check until frontend/dist is populated"
    return 0
  fi

  say "Waiting for the certificate (up to ~3 minutes)"
  local code=000
  for i in $(seq 1 60); do
    code=$(curl -sS -o /dev/null -w '%{http_code}' -m 5 "https://$SITE/" 2>/dev/null || true)
    [ "$code" = "200" ] && break
    sleep 3
  done
  if [ "$code" != "200" ]; then
    warn "https://$SITE/ returned '$code'"
    run systemctl status caddy --no-pager || true
    run journalctl -u caddy -n 30 --no-pager || true
    die "no certificate or no proxy; is DNS for $SITE this host, and are 80/443 open in the security list?"
  fi
  info "https://$SITE/ -> 200"

  # /api/* is the only path Caddy proxies; /openapi.json would be answered by the
  # SPA fallback and read as a pass, so check a real API route instead.
  local path
  for path in /api/game-status /models/player.glb; do
    code=$(curl -sS -o /dev/null -w '%{http_code}' -m 30 "https://$SITE$path" 2>/dev/null || true)
    if [ "$code" = "200" ]; then
      info "https://$SITE$path -> 200"
    else
      warn "https://$SITE$path -> $code"
    fi
  done
}

step_summary() {
  say "Done"
  cat <<EOF
  site        https://$SITE/
  api         https://$SITE/api/game-status   (proxied to 127.0.0.1:8000)
  unit        systemctl status mlb-live
  logs        journalctl -u mlb-live -f
  redeploy    sudo -H -u $APP_USER git -C $APP_DIR pull && sudo systemctl restart mlb-live
  frontend    copy frontend/dist here; Caddy serves it from disk, no restart needed
EOF
  if [ "$DIST_OK" -eq 0 ]; then
    cat <<EOF

  The site will 404 until the SPA is copied over. From your laptop:

    rsync -az frontend/dist/ ubuntu@<ip>:/tmp/mlb-dist/
    ssh ubuntu@<ip> 'DIST_SRC=/tmp/mlb-dist bash setup-vm.sh $SITE'

  The second command re-runs this script, which installs the build and
  finishes the HTTPS check. Doing it by hand also works:

    ssh ubuntu@<ip> 'sudo rsync -a --delete /tmp/mlb-dist/ $APP_DIR/frontend/dist/ \\
      && sudo chown -R $APP_USER:$APP_USER $APP_DIR/frontend/dist && rm -rf /tmp/mlb-dist'
EOF
  fi
}

main() {
  case "${1:-}" in
    -h|--help|"") usage ;;
  esac
  SITE=$(normalize_site "$1")
  case "$SITE" in
    *[!A-Za-z0-9.:-]*) die "site address may only contain letters, digits, dots, dashes and colons: $SITE" ;;
    *.*) ;;
    *) die "that does not look like a hostname: $SITE" ;;
  esac

  preflight
  step_packages
  step_firewall
  step_sysctl
  step_checkout
  step_python
  step_dist_check
  step_memory
  step_caddy
  step_service
  step_egress_guard
  step_reclaim_guard
  step_verify
  step_summary
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
