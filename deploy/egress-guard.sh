#!/usr/bin/env bash
#
# Monthly egress circuit breaker for the Always Free VM.
#
# Outbound data transfer is the only metered resource in this deployment: the
# first 10 TB/month is included, and on a Pay As You Go tenancy usage above
# that is billed. No request rate limit can bound total bytes -- a flood, or
# repeated fetches of the ~10 MB 3D assets, spends the allowance -- so this
# guard is the hard stop. It sums the interface transmit counters, persists the
# monthly total across reboots, and at EGRESS_LIMIT_GB (default 9000, leaving
# 1 TB of headroom) disables Caddy and the API. When the UTC month rolls over it
# re-enables them.
#
# It is deliberately a circuit breaker, not a traffic shaper: when the budget
# is gone the site is down, but the bill cannot grow. Check the journal
# (`journalctl -t mlb-egress-guard`) and the state file before raising the cap.
#
# State:  /var/lib/mlb-egress-guard/state    ("month total last_raw")
# Latch:  /var/lib/mlb-egress-guard/latched
#
# Testing without root or systemd:
#   SYS_CLASS_NET=/tmp/sys STATE_DIR=/tmp/state DRY_RUN=1 \
#     EGRESS_LIMIT_GB=0 bash deploy/egress-guard.sh

set -eu

SYS_CLASS_NET=${SYS_CLASS_NET:-/sys/class/net}
STATE_DIR=${STATE_DIR:-/var/lib/mlb-egress-guard}
LIMIT_GB=${EGRESS_LIMIT_GB:-9000}
DRY_RUN=${DRY_RUN:-0}
STATE="$STATE_DIR/state"
LATCH="$STATE_DIR/latched"

run() {
  if [ "$DRY_RUN" = "1" ]; then
    printf 'would: %s\n' "$*"
  else
    "$@"
  fi
}

log() {
  printf 'mlb-egress-guard: %s\n' "$*" >&2
  if [ "$DRY_RUN" != "1" ] && command -v logger >/dev/null 2>&1; then
    logger -t mlb-egress-guard -- "$*" || true
  fi
}

month=$(date -u +%Y-%m)
raw=0
for iface_dir in "$SYS_CLASS_NET"/*; do
  [ -d "$iface_dir" ] || continue
  [ "$(basename "$iface_dir")" = "lo" ] && continue
  counter="$iface_dir/statistics/tx_bytes"
  [ -r "$counter" ] || continue
  value=$(cat "$counter" 2>/dev/null || echo 0)
  case "$value" in
    *[!0-9]*|'') value=0 ;;
  esac
  raw=$((raw + value))
done

stored_month=""
total=0
last=0
if [ -r "$STATE" ]; then
  read -r stored_month total last < "$STATE" || true
fi
case "${stored_month:-}" in
  [0-9][0-9][0-9][0-9]-[0-9][0-9]) ;;
  *) stored_month="" ;;
esac
case "${total:-}" in
  *[!0-9]*|'') total=0 ;;
esac
case "${last:-}" in
  *[!0-9]*|'') last=0 ;;
esac

first_run=0
if [ -z "$stored_month" ]; then
  # No state yet: baseline the counter so bytes from before installation are
  # not attributed to this month.
  first_run=1
  stored_month=$month
  total=0
  last=$raw
elif [ "$stored_month" != "$month" ]; then
  # New UTC month: start the total over, but keep the counter baseline so the
  # bytes already counted last month are not counted again.
  stored_month=$month
  total=0
  last=$raw
elif [ "$raw" -ge "$last" ]; then
  total=$((total + raw - last))
  last=$raw
else
  # Counter wrapped or the host rebooted; count everything since boot.
  total=$((total + raw))
  last=$raw
fi

mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR" 2>/dev/null || true
tmp="$STATE.tmp.$$"
printf '%s %s %s\n' "$stored_month" "$total" "$last" > "$tmp"
mv "$tmp" "$STATE"

if [ "$first_run" = "1" ]; then
  log "baselined at $raw bytes; counting from now (limit ${LIMIT_GB} GB/month)"
  exit 0
fi

limit_bytes=$((LIMIT_GB * 1000000000))
if [ "$total" -ge "$limit_bytes" ]; then
  if [ ! -f "$LATCH" ]; then
    printf '%s\n' \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ) egress ${total} bytes >= ${limit_bytes}" \
      > "$LATCH"
    log "monthly egress ${total} bytes reached the ${LIMIT_GB} GB cap; disabling caddy and mlb-live"
  fi
  run systemctl disable --now caddy mlb-live || true
else
  if [ -f "$LATCH" ]; then
    rm -f "$LATCH"
    log "new UTC month: egress counter reset; re-enabling caddy and mlb-live"
    run systemctl enable --now caddy mlb-live || true
  fi
fi
