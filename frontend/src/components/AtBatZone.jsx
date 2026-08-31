import React, { useState } from 'react';
import { pitchTypeColor } from '../util/pitchType';

// Tunneling color code, matching the at-bat spec:
//   red = strike, blue = in play (no outs), purple = in play (outs),
//   green = ball, orange = foul.
const OUTCOME_COLORS = {
  strike: '#ff5f5f',
  in_play: '#4da6ff',
  in_play_outs: '#c15cff',
  ball: '#7ee0a0',
  foul: '#ffa64d',
  other: '#cccccc',
};

const OUTCOME_LABELS = {
  strike: 'Strike',
  in_play: 'In play (no out)',
  in_play_outs: 'In play (out)',
  ball: 'Ball',
  foul: 'Foul',
  other: 'Other',
};

/**
 * Gameday-style strike zone (catcher's perspective) with every pitch of an
 * at-bat drawn as a numbered, color-coded circle. Clicking a replayable pitch
 * hands it back via ``onSelect`` so the parent can replay that pitch/play.
 *
 * With ``showPitchType`` the circles are labeled with the pitch type code
 * (FF / SL / ...) instead of the pitch number and clicking is disabled, which
 * powers the whole-game "all pitches the batter has faced" view.
 */
export function AtBatZone({ pitches = [], szTop = 3.5, szBot = 1.5, activePitchNumber = null, onSelect, selectionMode = false, selectedPlayIds = null, onToggleSelect, showPitchType = false, colorBy = 'outcome' }) {
  const W = 200;
  const H = 250;
  const plateWidthFt = 17 / 12; // 1.4167 ft
  const zoneH_ft = szTop - szBot;
  const zoneW_ft = plateWidthFt;
  const padding = 0.8; // ft of padding around the zone
  const viewW_ft = zoneW_ft + 2 * padding;
  const viewH_ft = zoneH_ft + 2 * padding;

  // Uniform scale so the zone keeps its real 1:1 aspect ratio.
  const scale = Math.min(W / viewW_ft, H / viewH_ft);
  const offsetX = (W - viewW_ft * scale) / 2;
  const offsetY = (H - viewH_ft * scale) / 2;
  const zoneCenterX = 0; // pX=0 is the plate center
  const zoneCenterZ = (szTop + szBot) / 2;

  const ftX = (ft) => offsetX + ((ft - zoneCenterX) + viewW_ft / 2) * scale;
  const ftY = (ft) => offsetY + (-(ft - zoneCenterZ) + viewH_ft / 2) * scale;

  const zoneLeft = ftX(-plateWidthFt / 2);
  const zoneRight = ftX(plateWidthFt / 2);
  const zoneTop = ftY(szTop);
  const zoneBottom = ftY(szBot);
  const zoneW = zoneRight - zoneLeft;
  const zoneH = zoneBottom - zoneTop;

  // Stable identity for a dot, unique across at-bats (the game view mixes
  // pitches from several at-bats where pitch_number repeats).
  const dotKey = (p) => p.play_id ?? `${p.at_bat_index ?? '?'}-${p.pitch_number}`;

  const dots = pitches
    .map((p) => {
      const px = p.statcast_px_mid ?? p.statcast_px;
      const pz = p.statcast_pz_mid ?? p.statcast_pz;
      if (px == null || pz == null) return null;
      return { ...p, x: ftX(px), y: ftY(pz) };
    })
    .filter(Boolean);

  // The hovered dot is drawn LAST so it sits on top of overlapping neighbors
  // (SVG paints later elements over earlier ones). In the dense game view the
  // circles overlap heavily, so this keeps the one under the cursor readable.
  const [hoveredKey, setHoveredKey] = useState(null);
  const orderedDots = hoveredKey == null
    ? dots
    : [...dots].sort((a, b) => {
        const aHovered = dotKey(a) === hoveredKey;
        const bHovered = dotKey(b) === hoveredKey;
        if (aHovered && !bHovered) return 1;
        if (bHovered && !aHovered) return -1;
        return 0;
      });

  return (
    <svg
      width={W}
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      style={{
        display: 'block',
        margin: '2px auto',
        background: 'rgba(16,20,28,0.92)',
        borderRadius: 6,
        border: '1px solid rgba(255,255,255,0.14)',
      }}
    >
      {/* Strike zone box */}
      <rect
        x={zoneLeft}
        y={zoneTop}
        width={zoneW}
        height={zoneH}
        fill="none"
        stroke="rgba(255,255,255,0.8)"
        strokeWidth={2}
      />
      {/* Thirds */}
      <line x1={zoneLeft + zoneW / 3} y1={zoneTop} x2={zoneLeft + zoneW / 3} y2={zoneBottom} stroke="rgba(255,255,255,0.3)" strokeWidth={1} />
      <line x1={zoneLeft + (2 * zoneW) / 3} y1={zoneTop} x2={zoneLeft + (2 * zoneW) / 3} y2={zoneBottom} stroke="rgba(255,255,255,0.3)" strokeWidth={1} />
      <line x1={zoneLeft} y1={zoneTop + zoneH / 3} x2={zoneRight} y2={zoneTop + zoneH / 3} stroke="rgba(255,255,255,0.3)" strokeWidth={1} />
      <line x1={zoneLeft} y1={zoneTop + (2 * zoneH) / 3} x2={zoneRight} y2={zoneTop + (2 * zoneH) / 3} stroke="rgba(255,255,255,0.3)" strokeWidth={1} />

      {/* Pitch location dots, numbered in the order they were thrown */}
      {orderedDots.map((p) => {
        const key = dotKey(p);
        // ``colorBy='pitchType'`` (the whole-game view's pitch-type filter)
        // colours the dots by the pitch's type instead of its outcome.
        const color = colorBy === 'pitchType'
          ? pitchTypeColor(p.pitch_type ?? (p.pitch || {}).pitch_type ?? null)
          : OUTCOME_COLORS[p.outcome] || OUTCOME_COLORS.other;
        // The whole-game view shows every pitch as a read-only summary, so
        // replay (and compare selection) are disabled there.
        const clickable = !showPitchType && !!p.replayable;
        const isActive = activePitchNumber != null && p.pitch_number === activePitchNumber;
        const isSelected = selectionMode && selectedPlayIds?.has(p.play_id);
        // Hovering raises the dot above its neighbors: full opacity (the game
        // view's read-only dots sit at 0.5 otherwise) and a thin white ring.
        const hovered = hoveredKey === key;
        // Hover pop-up meta: speed, pitch type, and the ball–strike count in
        // effect when thrown. The game view's pitches carry speed/type at the
        // top level (no full payload), so each field is read from either.
        // The type CODE is already its own tooltip line, so the description
        // line shows only the full name — never the code a second time.
        const pmeta = p.pitch || {};
        const pitchType = p.pitch_type ?? pmeta.pitch_type ?? null;
        const speedMph = p.speed_mph ?? pmeta.speed_mph ?? null;
        const typeDescription = p.pitch_type_description ?? pmeta.pitch_type_description ?? null;
        const metaLines = [
          speedMph != null ? `${Number(speedMph.toFixed(1))} mph` : null,
          typeDescription || null,
          pmeta.game_state?.count?.balls != null && pmeta.game_state?.count?.strikes != null
            ? `Count ${pmeta.game_state.count.balls}–${pmeta.game_state.count.strikes}`
            : null,
        ].filter(Boolean);
        const handleClick = () => {
          if (!clickable) return;
          if (selectionMode) {
            if (onToggleSelect) onToggleSelect(p);
          } else if (onSelect) {
            onSelect(p);
          }
        };
        return (
          <g
            key={key}
            onClick={handleClick}
            onMouseEnter={() => setHoveredKey(key)}
            onMouseLeave={() => setHoveredKey((k) => (k === key ? null : k))}
            style={{ cursor: clickable ? 'pointer' : 'default', opacity: hovered ? 1 : clickable ? 1 : 0.5 }}
          >
            <title>
              {`Pitch ${p.pitch_number} — ${OUTCOME_LABELS[p.outcome] || 'Other'}`}
              {pitchType ? `\n${pitchType}` : ''}
              {metaLines.map((l) => `\n${l}`)}
              {p.description ? `\n${p.description}` : ''}
              {p.outs > 0 ? `\n${p.outs} out${p.outs === 1 ? '' : 's'}` : ''}
              {!clickable ? '\n(no replay data)' : ''}
              {selectionMode ? (isSelected ? '\nselected for compare' : '\nclick to select for compare') : ''}
            </title>
            {hovered && (
              <circle cx={p.x} cy={p.y} r={13} fill="none" stroke="rgba(255,255,255,0.9)" strokeWidth={1.5} />
            )}
            {isActive && (
              <circle cx={p.x} cy={p.y} r={14} fill="none" stroke="#ffd166" strokeWidth={2} />
            )}
            {isSelected && (
              <circle cx={p.x} cy={p.y} r={16} fill="none" stroke="#22cccc" strokeWidth={2.5} strokeDasharray="3 3" />
            )}
            <circle cx={p.x} cy={p.y} r={11} fill={color} stroke="#fff" strokeWidth={1.5} />
            <text
              x={p.x}
              y={p.y + 3.5}
              textAnchor="middle"
              fontSize={showPitchType ? 10 : 11}
              fontWeight="bold"
              fill="#fff"
              stroke="#0a0e14"
              strokeWidth={1}
              paintOrder="stroke"
              pointerEvents="none"
            >
              {showPitchType ? (pitchType || '?') : p.pitch_number}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/**
 * Skeleton placeholder shown while the at-bat pitch list is loading.
 * Mirrors the AtBatZone layout (same dimensions, strike-zone box, and
 * thirds lines) so the panel stays visibly expanded instead of collapsing
 * to a one-line loading message during back-to-live and game-switch fetches.
 */
export function AtBatLoadingPlaceholder({ szTop = 3.5, szBot = 1.5 }) {
  const W = 200;
  const H = 250;
  const plateWidthFt = 17 / 12;
  const zoneH_ft = szTop - szBot;
  const zoneW_ft = plateWidthFt;
  const padding = 0.8;
  const viewW_ft = zoneW_ft + 2 * padding;
  const viewH_ft = zoneH_ft + 2 * padding;

  const scale = Math.min(W / viewW_ft, H / viewH_ft);
  const offsetX = (W - viewW_ft * scale) / 2;
  const offsetY = (H - viewH_ft * scale) / 2;

  const ftX = (ft) => offsetX + (ft + viewW_ft / 2) * scale;
  const ftY = (ft) => offsetY + (-(ft - (szTop + szBot) / 2) + viewH_ft / 2) * scale;

  const zoneLeft = ftX(-plateWidthFt / 2);
  const zoneRight = ftX(plateWidthFt / 2);
  const zoneTop = ftY(szTop);
  const zoneBottom = ftY(szBot);
  const zoneW = zoneRight - zoneLeft;
  const zoneH = zoneBottom - zoneTop;

  return (
    <svg
      width={W}
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      className="at-bat-skeleton"
      style={{
        display: 'block',
        margin: '2px auto',
        background: 'rgba(16,20,28,0.92)',
        borderRadius: 6,
        border: '1px solid rgba(255,255,255,0.14)',
      }}
    >
      {/* Strike zone box */}
      <rect
        x={zoneLeft}
        y={zoneTop}
        width={zoneW}
        height={zoneH}
        fill="none"
        stroke="rgba(255,255,255,0.35)"
        strokeWidth={2}
      />
      {/* Thirds */}
      <line x1={zoneLeft + zoneW / 3} y1={zoneTop} x2={zoneLeft + zoneW / 3} y2={zoneBottom} stroke="rgba(255,255,255,0.15)" strokeWidth={1} />
      <line x1={zoneLeft + (2 * zoneW) / 3} y1={zoneTop} x2={zoneLeft + (2 * zoneW) / 3} y2={zoneBottom} stroke="rgba(255,255,255,0.15)" strokeWidth={1} />
      <line x1={zoneLeft} y1={zoneTop + zoneH / 3} x2={zoneRight} y2={zoneTop + zoneH / 3} stroke="rgba(255,255,255,0.15)" strokeWidth={1} />
      <line x1={zoneLeft} y1={zoneTop + (2 * zoneH) / 3} x2={zoneRight} y2={zoneTop + (2 * zoneH) / 3} stroke="rgba(255,255,255,0.15)" strokeWidth={1} />
      {/* Loading label */}
      <text
        x={W / 2}
        y={H / 2 + 3}
        textAnchor="middle"
        fontSize={12}
        fill="rgba(255,255,255,0.45)"
        fontFamily="monospace"
      >
        Loading…
      </text>
    </svg>
  );
}
