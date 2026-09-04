import test from 'node:test';
import assert from 'node:assert/strict';

// Helper representing the pitch panel slide styling logic
function computePitchPanelStyle({ panelSlidOut, pitchPanelOpen = true }) {
  return {
    transform: panelSlidOut ? 'translateX(calc(-100% - 40px))' : 'translateX(0)',
    transition: 'transform 0.4s cubic-bezier(0.16, 1, 0.3, 1), min-width 0.3s ease, min-height 0.3s ease, padding 0.3s ease',
    pointerEvents: panelSlidOut ? 'none' : 'auto',
    ariaHidden: panelSlidOut,
    padding: pitchPanelOpen ? '10px 14px' : '4px 12px',
    headerMinHeight: pitchPanelOpen ? 24 : 19,
    headerMarginBottom: pitchPanelOpen ? 8 : 0,
  };
}

// State reducer simulating the play animation lifecycle vs manual collapse/expand
function panelReducer(state, action) {
  switch (action.type) {
    case 'NEW_PLAY_STARTED':
      // A new play is about to animate: slide the panel out to the left
      // do NOT alter pitchPanelOpen (keep user expand/collapse preference)
      return {
        ...state,
        panelSlidOut: true,
      };
    case 'PLAY_COMPLETED':
      // Play fully animated: slide the panel back in
      // do NOT overwrite pitchPanelOpen (keep user preference)
      return {
        ...state,
        panelSlidOut: false,
      };
    case 'USER_TOGGLE_PANEL':
      // User manually toggles expand/collapse when they want more space
      return {
        ...state,
        pitchPanelOpen: !state.pitchPanelOpen,
      };
    default:
      return state;
  }
}

test('pitch panel styles slide off-screen to the left when panelSlidOut is true', () => {
  const style = computePitchPanelStyle({ panelSlidOut: true });
  assert.equal(style.transform, 'translateX(calc(-100% - 40px))');
  assert.equal(style.pointerEvents, 'none');
  assert.equal(style.ariaHidden, true);
});

test('pitch panel styles return to screen when panelSlidOut is false', () => {
  const style = computePitchPanelStyle({ panelSlidOut: false });
  assert.equal(style.transform, 'translateX(0)');
  assert.equal(style.pointerEvents, 'auto');
  assert.equal(style.ariaHidden, false);
});

test('new play slides panel out without collapsing user-expanded state', () => {
  let state = { pitchPanelOpen: true, panelSlidOut: false };

  // New play starts
  state = panelReducer(state, { type: 'NEW_PLAY_STARTED' });
  assert.equal(state.panelSlidOut, true, 'Panel should slide out of the screen');
  assert.equal(state.pitchPanelOpen, true, 'User expanded preference must be preserved');

  // Play completes
  state = panelReducer(state, { type: 'PLAY_COMPLETED' });
  assert.equal(state.panelSlidOut, false, 'Panel should slide back in');
  assert.equal(state.pitchPanelOpen, true, 'Panel remains expanded as preferred');
});

test('user collapse preference is preserved across play animation lifecycle', () => {
  let state = { pitchPanelOpen: true, panelSlidOut: false };

  // User manually collapses panel for more space in the interface
  state = panelReducer(state, { type: 'USER_TOGGLE_PANEL' });
  assert.equal(state.pitchPanelOpen, false, 'Panel is collapsed by user');

  // New play starts
  state = panelReducer(state, { type: 'NEW_PLAY_STARTED' });
  assert.equal(state.panelSlidOut, true, 'Panel slides out off-screen');
  assert.equal(state.pitchPanelOpen, false, 'Panel remains collapsed');

  // Play finishes animation
  state = panelReducer(state, { type: 'PLAY_COMPLETED' });
  assert.equal(state.panelSlidOut, false, 'Panel slides back in');
  assert.equal(state.pitchPanelOpen, false, 'Panel remains collapsed, not forced open');
});

test('collapsed pitch panel has shorter padding, smaller minHeight, and no bottom margin', () => {
  const expanded = computePitchPanelStyle({ panelSlidOut: false, pitchPanelOpen: true });
  const collapsed = computePitchPanelStyle({ panelSlidOut: false, pitchPanelOpen: false });

  assert.equal(expanded.padding, '10px 14px');
  assert.equal(expanded.headerMinHeight, 24);
  assert.equal(expanded.headerMarginBottom, 8);

  assert.equal(collapsed.padding, '4px 12px');
  assert.equal(collapsed.headerMinHeight, 19);
  assert.equal(collapsed.headerMarginBottom, 0);
});

