import test from 'node:test';
import assert from 'node:assert/strict';
import {
  defenseFromSnapshot,
  restoreLiveDefense,
  defensePositions,
} from '../src/util/defense.js';

// The defensive alignment the live feed reports while the user is watching.
const LIVE_ALIGNMENT = {
  P: { id: 91, name: 'Nestor Cortes' },
  C: { id: 92, name: 'Austin Wells' },
  '1B': { id: 93, name: 'Ben Rice' },
  '2B': { id: 94, name: 'Jazz Chisholm Jr.' },
  '3B': { id: 95, name: 'Jon Berti' },
  SS: { id: 96, name: 'Anthony Volpe' },
  LF: { id: 97, name: 'Alex Verdugo' },
  CF: { id: 98, name: 'Aaron Judge' },
  RF: { id: 99, name: 'Juan Soto' },
};

// The alignment in effect for the at-bat being rewound.
const REPLAY_ALIGNMENT = {
  P: { id: 11, name: 'Max Fried' },
  C: { id: 12, name: 'Sean Murphy' },
  '1B': { id: 13, name: 'Matt Olson' },
  '2B': { id: 14, name: 'Ozzie Albies' },
  '3B': { id: 15, name: 'Austin Riley' },
  SS: { id: 16, name: 'Orlando Arcia' },
  LF: { id: 17, name: 'Jarred Kelenic' },
  CF: { id: 18, name: 'Michael Harris II' },
  RF: { id: 19, name: 'Ronald Acuña Jr.' },
};

test('a replayed at-bat pitch snapshot drives the defense panel', () => {
  const snapshot = {
    count: { balls: 0, strikes: 1 },
    defenseAlignment: REPLAY_ALIGNMENT,
    defenseFormation: 'Infield In',
  };
  assert.deepEqual(defenseFromSnapshot(snapshot), {
    alignment: REPLAY_ALIGNMENT,
    formation: 'Infield In',
  });
});

test('formation defaults to Standard when the snapshot omits it', () => {
  const snapshot = { defenseAlignment: REPLAY_ALIGNMENT };
  assert.deepEqual(defenseFromSnapshot(snapshot), {
    alignment: REPLAY_ALIGNMENT,
    formation: 'Standard',
  });
});

test('snapshots without a usable alignment return null so live data is kept', () => {
  // A mid-at-bat snapshot can predate any defense block in the feed.
  assert.equal(defenseFromSnapshot(null), null);
  assert.equal(defenseFromSnapshot({}), null);
  assert.equal(defenseFromSnapshot({ count: { balls: 1, strikes: 1 } }), null);
  assert.equal(defenseFromSnapshot({ defenseAlignment: {} }), null);
});

test('return to live restores the captured live alignment over replayed snapshots', () => {
  const replayDefense = { alignment: REPLAY_ALIGNMENT, formation: 'Infield In' };
  const capturedLive = { alignment: LIVE_ALIGNMENT, formation: 'Standard' };

  // Review overwrote the panel with the replayed at-bat's alignment...
  let panel = defenseFromSnapshot({
    defenseAlignment: REPLAY_ALIGNMENT,
    defenseFormation: 'Infield In',
  });
  assert.deepEqual(panel, replayDefense);

  // ...and Return to Live hands it back the captured live alignment.
  assert.deepEqual(restoreLiveDefense(panel, capturedLive), capturedLive);

  // When nothing was captured, the current panel data is preserved.
  assert.deepEqual(restoreLiveDefense(panel, null), panel);
});

test('full review lifecycle: replay updates the panel, return-to-live restores it', () => {
  const liveDefense = { alignment: LIVE_ALIGNMENT, formation: 'Standard' };

  // enterReview: capture the live alignment (liveDefenseRef).
  const captured = liveDefense;

  // Selecting/completing a replayed pitch maps its snapshot onto the panel.
  const replayDefense = defenseFromSnapshot({
    defenseAlignment: REPLAY_ALIGNMENT,
    defenseFormation: 'Infield In',
  });
  assert.deepEqual(replayDefense, {
    alignment: REPLAY_ALIGNMENT,
    formation: 'Infield In',
  });

  // A mid-at-bat snapshot without an alignment must not clobber the panel.
  assert.equal(
    defenseFromSnapshot({ count: { balls: 1, strikes: 2 }, bases: ['1B'] }),
    null,
  );

  // backToLive: restore the captured live alignment.
  assert.deepEqual(restoreLiveDefense(replayDefense, captured), liveDefense);
});

test('defensePositions returns the standard spots for an unknown or absent formation', () => {
  const standard = defensePositions('Standard');
  // Spot-checks of the base alignment on the 320×260 canvas.
  assert.deepEqual(standard.P, { x: 160, y: 178 });
  assert.deepEqual(standard.C, { x: 160, y: 222 });
  assert.deepEqual(standard.SS, { x: 112, y: 102 });
  assert.deepEqual(standard.CF, { x: 160, y: 34 });
  assert.deepEqual(defensePositions(undefined), standard);
  assert.deepEqual(defensePositions('Wacky Shift'), standard);
});

test('Infield In pulls the infielders toward home plate and leaves the outfield alone', () => {
  const standard = defensePositions('Standard');
  const infieldIn = defensePositions('Infield In');
  for (const pos of ['1B', '2B', '3B', 'SS', 'P']) {
    // Closer to the plate means a larger y on this orientation.
    assert.ok(infieldIn[pos].y > standard[pos].y, `${pos} should play in`);
    assert.equal(infieldIn[pos].x, standard[pos].x, `${pos} should not shift horizontally`);
  }
  // The catcher is already at the plate and the outfield stays put.
  assert.deepEqual(infieldIn.C, standard.C);
  for (const pos of ['LF', 'CF', 'RF']) {
    assert.deepEqual(infieldIn[pos], standard[pos]);
  }
});

test('Strategic shift overloads the field toward the pull side', () => {
  const standard = defensePositions('Standard');
  const strategic = defensePositions('Strategic');
  // Middle infielders shade past the bag toward the pull side (+x).
  for (const pos of ['SS', '2B', '3B']) {
    assert.ok(strategic[pos].x > standard[pos].x, `${pos} should shade right`);
  }
  // The outfield shades that way too, and the catcher/pitcher stay anchored.
  assert.ok(strategic.CF.x > standard.CF.x);
  assert.deepEqual(strategic.P, standard.P);
  assert.deepEqual(strategic.C, standard.C);
});

test('every formation returns all nine positions so the diagram never drops a fielder', () => {
  for (const formation of ['Standard', 'Strategic', 'Infield In', undefined]) {
    const positions = defensePositions(formation);
    assert.equal(Object.keys(positions).length, 9);
    for (const { x, y } of Object.values(positions)) {
      assert.equal(typeof x, 'number');
      assert.equal(typeof y, 'number');
    }
  }
});
