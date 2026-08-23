import React from 'react';

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
 */
export function AtBatZone({ pitches = [], szTop = 3.5, szBot = 1.5, activePitchNumber = null, onSelect, selectionMode = false, selectedPlayIds = null, onToggleSelect }) {
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

  const dots = pitches
    .map((p) => {
      const px = p.statcast_px_mid ?? p.statcast_px;
      const pz = p.statcast_pz_mid ?? p.statcast_pz;
      if (px == null || pz == null) return null;
      return { ...p, x: ftX(px), y: ftY(pz) };
    })
    .filter(Boolean);

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
      {dots.map((p) => {
        const color = OUTCOME_COLORS[p.outcome] || OUTCOME_COLORS.other;
        const clickable = !!p.replayable;
        const isActive = activePitchNumber != null && p.pitch_number === activePitchNumber;
        const isSelected = selectionMode && selectedPlayIds?.has(p.play_id);
        // Hover pop-up meta from the pitch payload (null when not replayable):
        // speed, pitch type, and the ball–strike count in effect when thrown.
        const pmeta = p.pitch || {};
        const metaLines = [
          pmeta.speed_mph != null ? `${Number(pmeta.speed_mph.toFixed(1))} mph` : null,
          pmeta.pitch_type_description || pmeta.pitch_type || null,
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
            key={p.pitch_number}
            onClick={handleClick}
            style={{ cursor: clickable ? 'pointer' : 'default', opacity: clickable ? 1 : 0.5 }}
          >
            <title>
              {`Pitch ${p.pitch_number} — ${OUTCOME_LABELS[p.outcome] || 'Other'}`}
              {metaLines.map((l) => `\n${l}`)}
              {p.description ? `\n${p.description}` : ''}
              {p.outs > 0 ? `\n${p.outs} out${p.outs === 1 ? '' : 's'}` : ''}
              {!clickable ? '\n(no replay data)' : ''}
              {selectionMode ? (isSelected ? '\nselected for compare' : '\nclick to select for compare') : ''}
            </title>
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
              fontSize={11}
              fontWeight="bold"
              fill="#fff"
              stroke="#0a0e14"
              strokeWidth={1}
              paintOrder="stroke"
              pointerEvents="none"
            >
              {p.pitch_number}
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
