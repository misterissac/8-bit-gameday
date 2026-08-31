import React, { useMemo } from 'react';
import { pitchTypeColor } from '../util/pitchType';

// ── Axis helpers ────────────────────────────────────────────────────────────
const niceMax = (max) => {
  if (max <= 0) return 5;
  const mag = Math.pow(10, Math.floor(Math.log10(max)));
  const norm = max / mag;
  let nice = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return nice * mag;
};

// ── Sign conventions ────────────────────────────────────────────────────────
// Statcast's induced horizontal break uses one FIXED sign convention for both
// hands (the same one Baseball Savant displays): positive pfx_x = break toward
// first base (catcher's right / viewer's right), negative = toward third
// base. The backend /api/pitcher-movement endpoint keeps the CSV pfx_x as-is
// (no LHP mirroring), and the live-feed payload's pfx_x comes from
// -breakHorizontal, which is already in this convention. So the ellipses and
// the current-pitch dot agree for lefties and righties with no mirroring.
// IVB (pfx_z) is positive up for every pitcher.

export const PitchMovementGraph = ({
  graphData,
  currentPitch,
  showCurrentDot,
  leagueAvg, // { x, z } in inches, same fixed convention + per-hand as the panel
  width = 280,
  height = 280,
}) => {
  const pad = { top: 20, right: 20, bottom: 34, left: 40 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  // Current pitch in the same fixed convention as the backend ellipses
  // (positive horizontal break = toward 1B, positive IVB = up).
  const currentHBreak = currentPitch?.pfx_x;
  const currentVBreak = currentPitch?.pfx_z;

  const { xMin, xMax, zMin, zMax, scaleX, scaleZ, ellipses } = useMemo(() => {
    if (!graphData || Object.keys(graphData).length === 0) {
      return { xMin: -25, xMax: 25, zMin: -25, zMax: 25, scaleX: 1, scaleZ: 1, ellipses: [] };
    }

    // Find the global range across all ellipses
    let globalXMin = Infinity, globalXMax = -Infinity;
    let globalZMin = Infinity, globalZMax = -Infinity;

    const entries = Object.entries(graphData);
    const items = entries.map(([type, d]) => {
      const a = d.a ?? 12;
      const b = d.b ?? 8;
      const cx = d.center_x ?? 0;
      const cz = d.center_z ?? 0;
      // Approximate bounding box of the ellipse
      const r = Math.max(a, b);
      return { type, cx, cz, a, b, angle: d.angle ?? 0, n: d.n ?? 0, r };
    });

    // Also consider the current pitch if showing (already the fixed convention)
    if (showCurrentDot && currentHBreak != null && currentVBreak != null) {
      globalXMin = Math.min(globalXMin, currentHBreak - 5);
      globalXMax = Math.max(globalXMax, currentHBreak + 5);
      globalZMin = Math.min(globalZMin, currentVBreak - 5);
      globalZMax = Math.max(globalZMax, currentVBreak + 5);
    }

    // The per-hand league-average reference point (same convention) should
    // never be clipped off the plot.
    if (leagueAvg && leagueAvg.x != null && leagueAvg.z != null) {
      globalXMin = Math.min(globalXMin, leagueAvg.x - 5);
      globalXMax = Math.max(globalXMax, leagueAvg.x + 5);
      globalZMin = Math.min(globalZMin, leagueAvg.z - 5);
      globalZMax = Math.max(globalZMax, leagueAvg.z + 5);
    }

    for (const item of items) {
      globalXMin = Math.min(globalXMin, item.cx - item.r);
      globalXMax = Math.max(globalXMax, item.cx + item.r);
      globalZMin = Math.min(globalZMin, item.cz - item.r);
      globalZMax = Math.max(globalZMax, item.cz + item.r);
    }

    // Pad the range
    const xRange = globalXMax - globalXMin || 10;
    const zRange = globalZMax - globalZMin || 10;
    const xPadded = xRange * 0.15;
    const zPadded = zRange * 0.15;

    const xMin = globalXMin - xPadded;
    const xMax = globalXMax + xPadded;
    const zMin = globalZMin - zPadded;
    const zMax = globalZMax + zPadded;

    return {
      xMin, xMax, zMin, zMax,
      scaleX: plotW / (xMax - xMin),
      scaleZ: plotH / (zMax - zMin),
      ellipses: items,
    };
  }, [graphData, currentHBreak, currentVBreak, showCurrentDot, leagueAvg, plotW, plotH]);

  // Project data coordinates to SVG pixel coordinates
  const toSvgX = (x) => pad.left + (x - xMin) * scaleX;
  const toSvgZ = (z) => pad.top + (zMax - z) * scaleZ; // invert: larger z = upward

  // Nice tick values
  const xNice = niceMax(Math.max(Math.abs(xMin), Math.abs(xMax)));
  const zNice = niceMax(Math.max(Math.abs(zMin), Math.abs(zMax)));

  return (
    <div style={{ width, height, margin: '4px auto', position: 'relative' }}>
      <svg width={width} height={height} style={{ display: 'block' }}>
        {/* Background */}
        <rect x={pad.left} y={pad.top} width={plotW} height={plotH}
          fill="rgba(20,24,30,0.9)" rx={2} />

        {/* Grid lines */}
        {[-xNice, -xNice / 2, 0, xNice / 2, xNice].map(v => {
          const sx = toSvgX(v);
          if (sx < pad.left || sx > pad.left + plotW) return null;
          return (
            <line key={`gx-${v}`} x1={sx} y1={pad.top} x2={sx} y2={pad.top + plotH}
              stroke={v === 0 ? 'rgba(255,255,255,0.3)' : 'rgba(255,255,255,0.08)'}
              strokeWidth={v === 0 ? 1 : 0.5} />
          );
        })}
        {[-zNice, -zNice / 2, 0, zNice / 2, zNice].map(v => {
          const sy = toSvgZ(v);
          if (sy < pad.top || sy > pad.top + plotH) return null;
          return (
            <line key={`gz-${v}`} x1={pad.left} y1={sy} x2={pad.left + plotW} y2={sy}
              stroke={v === 0 ? 'rgba(255,255,255,0.3)' : 'rgba(255,255,255,0.08)'}
              strokeWidth={v === 0 ? 1 : 0.5} />
          );
        })}

        {/* ── Horizontal axis (fixed Statcast convention for both hands):
            positive break = toward 1B (catcher's view, right side), negative
            = toward 3B. The ◀/▶ triangles mark which way each base lies. ── */}
        <text x={pad.left} y={height - 6} textAnchor="start"
          fill="rgba(157,208,255,0.8)" fontSize={9} fontWeight="bold" fontFamily="monospace">
          ◀ 3B
        </text>
        <text x={pad.left + plotW / 2} y={height - 6} textAnchor="middle"
          fill="rgba(255,255,255,0.5)" fontSize={9} fontFamily="monospace">
          H Break (in)
        </text>
        <text x={pad.left + plotW} y={height - 6} textAnchor="end"
          fill="rgba(157,208,255,0.8)" fontSize={9} fontWeight="bold" fontFamily="monospace">
          1B ▶
        </text>

        {/* ── Vertical axis: induced vertical break, positive up (ride) ── */}
        <text x={8} y={pad.top + plotH / 2} textAnchor="middle"
          fill="rgba(255,255,255,0.5)" fontSize={9} fontFamily="monospace"
          transform={`rotate(-90, 8, ${pad.top + plotH / 2})`}>
          IVB (in) ↑
        </text>

        {/* Tick labels */}
        {[-xNice, -xNice / 2, 0, xNice / 2, xNice].map(v => {
          const sx = toSvgX(v);
          if (sx < pad.left || sx > pad.left + plotW) return null;
          return (
            <text key={`tx-${v}`} x={sx} y={height - 16} textAnchor="middle"
              fill="rgba(255,255,255,0.45)" fontSize={8} fontFamily="monospace">
              {v}
            </text>
          );
        })}
        {[-zNice, -zNice / 2, 0, zNice / 2, zNice].map(v => {
          const sy = toSvgZ(v);
          if (sy < pad.left || sy > pad.top + plotH) return null;
          return (
            <text key={`tz-${v}`} x={pad.left - 6} y={sy + 3} textAnchor="end"
              fill="rgba(255,255,255,0.45)" fontSize={8} fontFamily="monospace">
              {v}
            </text>
          );
        })}

        {/* Confidence ellipses */}
        {ellipses.map(({ type, cx, cz, a, b, angle, n }) => {
          const color = pitchTypeColor(type);
          const sx = toSvgX(cx);
          const sz = toSvgZ(cz);
          // Semi-axes in SVG pixels, with the major axis a mapped to x scale
          // and minor axis b mapped to z scale. Since the SVG scales can differ
          // slightly, we approximate the ellipse shape in SVG space by scaling
          // each data-space semi-axis independently.
          const sa = a * scaleX;
          const sb = b * scaleZ;
          // Transform the angle from data space to SVG space accounting for
          // the y-axis inversion (z → -z) and the potentially different x/z
          // scales: tan(θ_svg) = (-scaleZ * sin(θ)) / (scaleX * cos(θ)).
          const svgAngleRad = Math.atan2(-scaleZ * Math.sin(angle), scaleX * Math.cos(angle));
          const svgAngleDeg = (svgAngleRad * 180) / Math.PI;

          return (
            <g key={type}>
              {/* Dotted ellipse */}
              <ellipse cx={sx} cy={sz} rx={sa} ry={sb}
                transform={`rotate(${svgAngleDeg}, ${sx}, ${sz})`}
                fill="none" stroke={color} strokeWidth={1.5}
                strokeDasharray="5 3" opacity={0.7} />
              {/* Center dot for the pitch type mean */}
              <circle cx={sx} cy={sz} r={2.5} fill={color} opacity={0.7} />
              {/* Pitch type label — place above the ellipse top edge */}
              <text x={sx} y={sz - sb - 6} textAnchor="middle"
                fill={color} fontSize={10} fontWeight="bold" fontFamily="monospace"
                opacity={0.9}>
                {type}
                <tspan fill="rgba(255,255,255,0.5)" fontSize={8} dx={2}>
                  {n}
                </tspan>
              </text>
            </g>
          );
        })}

        {/* League-average reference marker — the per-hand average for the
            current pitch's type, in the same fixed convention as the ellipses
            and the panel's H Break / IVB "vs avg" comparison. Drawn as a
            faint hollow crosshair so it reads as a reference point rather
            than a data dot, and shown regardless of the spoiler gate (league
            stats aren't the current pitch). */}
        {leagueAvg && leagueAvg.x != null && leagueAvg.z != null && (
          (() => {
            const mx = toSvgX(leagueAvg.x);
            const mz = toSvgZ(leagueAvg.z);
            return (
              <g opacity={0.4}>
                <circle cx={mx} cy={mz} r={5} fill="none" stroke="#e8eef5"
                  strokeWidth={1} strokeDasharray="3 2" />
                <line x1={mx - 2.2} y1={mz - 2.2} x2={mx + 2.2} y2={mz + 2.2}
                  stroke="#e8eef5" strokeWidth={1} />
                <line x1={mx - 2.2} y1={mz + 2.2} x2={mx + 2.2} y2={mz - 2.2}
                  stroke="#e8eef5" strokeWidth={1} />
                <text x={mx + 8} y={mz - 7} fill="rgba(255,255,255,0.55)"
                  fontSize={7} fontFamily="monospace">
                  lg avg
                </text>
              </g>
            );
          })()
        )}

        {/* Current pitch dot — plotted in the same fixed convention as the
            ellipses (positive H Break = toward 1B) */}
        {showCurrentDot && currentHBreak != null && currentVBreak != null && (
          (() => {
            const px = toSvgX(currentHBreak);
            const pz = toSvgZ(currentVBreak);
            const color = pitchTypeColor(currentPitch.pitch_type ?? 'FF');
            return (
              <g>
                {/* Outer glow ring */}
                <circle cx={px} cy={pz} r={7} fill="none" stroke={color}
                  strokeWidth={2.5} opacity={0.9} />
                {/* Inner filled dot */}
                <circle cx={px} cy={pz} r={4} fill={color} opacity={0.95} />
                {/* White center */}
                <circle cx={px} cy={pz} r={1.5} fill="white" opacity={0.8} />
              </g>
            );
          })()
        )}

        {/* Legend: what pitch types are shown */}
        <g transform={`translate(${pad.left + 4}, ${pad.top + 4})`}>
          {ellipses.map(({ type }, i) => (
            <text key={`leg-${type}`} x={0} y={i * 14 + 10}
              fill={pitchTypeColor(type)} fontSize={9} fontWeight="bold"
              fontFamily="monospace" opacity={0.85}>
              ● {type}
            </text>
          ))}
        </g>
      </svg>
    </div>
  );
};
