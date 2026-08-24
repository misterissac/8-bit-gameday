// Client-side broadcast-delay buffer.
//
// Live endpoints expose the newest feed state, not a durable event stream with
// reliable event timestamps. The safest client-side approximation is to start
// the delay when a response is received and release it only after the complete
// configured interval. This keeps every consumer (plays, status, scorebug, and
// read-only panels) behind the same wall-clock boundary.

export const BROADCAST_DELAY_OPTIONS = [0, 5, 10, 15, 30, 60]
export const MAX_BROADCAST_DELAY_SECONDS = 300

export const normalizeBroadcastDelaySeconds = (value) => {
  const numeric = typeof value === 'string' && value.trim() !== ''
    ? Number(value)
    : value
  if (!Number.isFinite(numeric)) return 0
  return Math.min(MAX_BROADCAST_DELAY_SECONDS, Math.max(0, numeric))
}

const normalizeDelayMs = (value) => {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? Math.max(0, numeric) : 0
}

export const serializeBroadcastDelayValue = (value) => {
  try {
    return JSON.stringify(value)
  } catch {
    // A response should be JSON-safe, but a caller can still provide a custom
    // value in tests or another UI path. A constant version is safer than
    // making the delay buffer throw and stopping live playback.
    return String(value)
  }
}

// Holds values until ``delayMs`` has elapsed. Entries can either be coalesced
// by an id (useful for one play being enriched while it waits) or appended as
// distinct versions (useful for successive scoreboard snapshots, each of
// which must retain its own original delay).
export class BroadcastDelayBuffer {
  constructor(onReady, {
    delayMs = 0,
    now = () => Date.now(),
    schedule = (callback, wait) => setTimeout(callback, wait),
    cancel = (timer) => clearTimeout(timer),
  } = {}) {
    this.onReady = onReady
    this.delayMs = normalizeDelayMs(delayMs)
    this.now = now
    this.schedule = schedule
    this.cancel = cancel
    this.pending = new Map()
    this.delivered = new Map()
  }

  _deliveredVersions(id) {
    let versions = this.delivered.get(id)
    if (!versions) {
      versions = new Set()
      this.delivered.set(id, versions)
    }
    return versions
  }

  _scheduleEntry(entry) {
    const wait = Math.max(0, entry.readyAt - this.now())
    entry.timer = this.schedule(() => {
      if (this.pending.get(entry.pendingKey) !== entry) return
      this.pending.delete(entry.pendingKey)
      this._deliveredVersions(entry.id).add(entry.version)
      this.onReady(entry.value)
    }, wait)
  }

  enqueue(id, value, { version = serializeBroadcastDelayValue(value), coalesce = true } = {}) {
    const normalizedId = String(id)
    const normalizedVersion = String(version)
    if (this._deliveredVersions(normalizedId).has(normalizedVersion)) return false

    const pendingKey = coalesce
      ? normalizedId
      : `${normalizedId}\u0000${normalizedVersion}`
    const existing = this.pending.get(pendingKey)
    if (existing) {
      if (existing.version === normalizedVersion) return false
      this.cancel(existing.timer)
    }

    const entry = {
      id: normalizedId,
      value,
      version: normalizedVersion,
      pendingKey,
      // When a coalesced value is enriched before release, never release it
      // until the newest version has also spent the complete delay in the
      // buffer. ``Math.max`` preserves the original deadline for harmless
      // replacements but extends it for a genuinely late result, so an update
      // received moments ago cannot spoil a broadcast that is still live.
      readyAt: existing
        ? Math.max(existing.readyAt, this.now() + this.delayMs)
        : this.now() + this.delayMs,
      timer: null,
    }
    this.pending.set(pendingKey, entry)
    this._scheduleEntry(entry)
    return true
  }

  setDelay(delayMs) {
    this.delayMs = normalizeDelayMs(delayMs)
    const now = this.now()
    for (const entry of this.pending.values()) {
      this.cancel(entry.timer)
      // Changing the setting is an explicit user action. Re-anchor pending
      // values to the new interval so lowering the delay can release them
      // promptly and increasing it cannot expose a value too early.
      entry.readyAt = now + this.delayMs
      this._scheduleEntry(entry)
    }
  }

  clear({ resetDelivered = true } = {}) {
    for (const entry of this.pending.values()) this.cancel(entry.timer)
    this.pending.clear()
    if (resetDelivered) this.delivered.clear()
  }

  get size() {
    return this.pending.size
  }
}
