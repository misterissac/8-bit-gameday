// Pitch-type colour code (Statcast codes). Distinct hues so each type is
// recognizable at a glance in the game view; unknown codes fall back to a
// stable hue derived from the code string.
export const PITCH_TYPE_COLORS = {
  FF: '#ff5f5f', // four-seam fastball
  FT: '#ff9f5f', // two-seam fastball
  SI: '#ffb84d', // sinker
  FC: '#ffd166', // cutter
  FS: '#4da6ff', // splitter
  FO: '#6fb7ff', // forkball
  SC: '#4dc9ff', // screwball
  SL: '#c15cff', // slider
  SV: '#e07bff', // slurve
  CU: '#7ee0a0', // curveball
  CB: '#57c98a', // curveball (alt code)
  KC: '#9be7c0', // knuckle curve
  CH: '#ff7fd1', // changeup
  KN: '#ffa9e4', // knuckleball
  EP: '#e0e0e0', // eephus
  PO: '#8a94a0', // pitchout
};

const FALLBACK_HUES = [200, 25, 130, 290, 350, 90, 40, 170, 250, 310, 15, 60, 220, 340, 110, 160, 280, 55];

export const pitchTypeColor = (code) => {
  if (!code) return '#cccccc';
  if (PITCH_TYPE_COLORS[code]) return PITCH_TYPE_COLORS[code];
  let hash = 0;
  for (let i = 0; i < code.length; i += 1) hash = (hash * 31 + code.charCodeAt(i)) >>> 0;
  return `hsl(${FALLBACK_HUES[hash % FALLBACK_HUES.length]}, 85%, 65%)`;
};
