// Defense-panel data helpers shared by the live feed and at-bat review paths.
//
// The backend attaches a ``defenseAlignment`` (position code -> player) and
// ``defenseFormation`` (Standard / Strategic / Infield In / ...) to every
// pitch snapshot in /api/at-bat and to /api/game-state. These helpers map a
// snapshot onto the Defense panel's data shape and encode the review-mode
// lifecycle: replayed at-bat snapshots drive the panel while rewinding, and
// Return to Live restores the alignment captured when review started.

/**
 * Map a pitch snapshot (``game_state`` / ``game_state_before``) to Defense
 * panel data. Returns ``{ alignment, formation }`` when the snapshot carries a
 * usable alignment, otherwise ``null`` so callers keep showing the current
 * live data instead of blanking the panel (a mid-at-bat snapshot can predate
 * any defense block in the feed).
 */
export function defenseFromSnapshot(snapshot) {
  const alignment = snapshot?.defenseAlignment;
  if (!alignment || Object.keys(alignment).length === 0) return null;
  return {
    alignment,
    formation: snapshot.defenseFormation ?? 'Standard',
  };
}

/**
 * Return-to-live restore: prefer the alignment captured when review started
 * over whatever replayed snapshots put on the panel, and keep the current
 * data when nothing was captured (defense may simply have been absent).
 */
export function restoreLiveDefense(current, captured) {
  return captured ?? current;
}

// Base fielding spots per position code on the DefenseDiagram's 320×260
// canvas (bird's-eye broadcast orientation: outfield at the top, home plate
// at the bottom). Mirrors the old inline table in App.jsx.
const DEFENSE_BASE_POSITIONS = {
  LF: { x: 44, y: 48 },
  CF: { x: 160, y: 34 },
  RF: { x: 276, y: 48 },
  '3B': { x: 64, y: 120 },
  SS: { x: 112, y: 102 },
  '2B': { x: 208, y: 102 },
  '1B': { x: 256, y: 120 },
  P: { x: 160, y: 178 },
  C: { x: 160, y: 222 },
};

// Per-formation offsets applied on top of the base spots. ``Infield In``
// crowds the infielders toward home plate (+y on this orientation).
// ``Strategic`` overloads the field toward the pull side (to the right here),
// with the middle infielders shading past the bag and the outfield shading
// that way too. Unknown formations get no offsets (standard alignment).
const DEFENSE_FORMATION_OFFSETS = {
  'Infield In': {
    '1B': { x: 0, y: 36 },
    '2B': { x: 0, y: 40 },
    '3B': { x: 0, y: 32 },
    SS: { x: 0, y: 40 },
    P: { x: 0, y: 16 },
  },
  Strategic: {
    '3B': { x: 32, y: -10 },
    SS: { x: 38, y: -10 },
    '2B': { x: 36, y: -2 },
    '1B': { x: 16, y: 2 },
    CF: { x: 24, y: -4 },
    RF: { x: 8, y: -8 },
  },
};

/**
 * Fielding coordinates for a formation: the base spots plus that formation's
 * offsets. Returns a fresh map for every call so the DefenseDiagram can
 * transition each fielder between formations (Standard → Infield In → …)
 * without mutating shared state.
 */
export function defensePositions(formation) {
  const offsets = DEFENSE_FORMATION_OFFSETS[formation] ?? {};
  const positions = {};
  for (const [pos, base] of Object.entries(DEFENSE_BASE_POSITIONS)) {
    const offset = offsets[pos] ?? { x: 0, y: 0 };
    positions[pos] = { x: base.x + offset.x, y: base.y + offset.y };
  }
  return positions;
}
