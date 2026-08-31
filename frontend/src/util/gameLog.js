const ordinal = (value) => {
  const number = Number(value)
  if (!Number.isFinite(number)) return String(value ?? '')
  const suffix = number % 100 >= 11 && number % 100 <= 13
    ? 'th'
    : ({ 1: 'st', 2: 'nd', 3: 'rd' }[number % 10] || 'th')
  return `${number}${suffix}`
}

export const gameLogInningHeading = (play) => (
  play?.inning_label
  || `${play?.half_inning || ''} ${ordinal(play?.inning)}`.trim()
)

export const groupGameLogPlays = (plays = []) => {
  const groups = []
  for (const play of plays) {
    const key = `${play?.half_inning || ''}-${play?.inning || ''}`
    let group = groups[groups.length - 1]
    if (!group || group.key !== key) {
      group = { key, title: gameLogInningHeading(play), plays: [] }
      groups.push(group)
    }
    group.plays.push(play)
    if (play.score_after) {
      group.plays.push({
        id: `${play.id}-score`,
        isScoreUpdate: true,
        scoreAfter: play.score_after,
      })
    }
  }
  return groups
}
