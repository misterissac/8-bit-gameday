import test from 'node:test'
import assert from 'node:assert/strict'

import { groupGameLogPlays } from '../src/util/gameLog.js'

test('game log groups consecutive plays under top/bottom inning headings', () => {
  const groups = groupGameLogPlays([
    { inning: 8, half_inning: 'Top', description: 'George Springer singles' },
    { inning: 8, half_inning: 'Top', description: 'Vladimir Guerrero Jr. scores' },
    { inning: 8, half_inning: 'Bottom', description: 'Miles Straw grounds out' },
  ])

  assert.deepEqual(groups.map(({ title, plays }) => ({ title, descriptions: plays.map((p) => p.description) })), [
    { title: 'Top 8th', descriptions: ['George Springer singles', 'Vladimir Guerrero Jr. scores'] },
    { title: 'Bottom 8th', descriptions: ['Miles Straw grounds out'] },
  ])
})

test('game log preserves chronological order when the feed changes innings', () => {
  const groups = groupGameLogPlays([
    { inning: 1, half_inning: 'Top', description: 'First' },
    { inning: 1, half_inning: 'Bottom', description: 'Second' },
    { inning: 2, half_inning: 'Top', description: 'Third' },
  ])
  assert.deepEqual(groups.map((group) => group.title), ['Top 1st', 'Bottom 1st', 'Top 2nd'])
})
