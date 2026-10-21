// How the bot decides a market, kept with the market as JSON: a football match's result,
// which a machine can check, or a question Claude made and looks up the answer to.

// A market on one of Norway's matches. The goals are those of normal time (90 minutes).
export interface FootballRule {
  type: 'football'
  // The match at ESPN, and the competition it is in there
  event: string
  league: string
  bet: 'winner' | 'goals' | 'team-goals' | 'scorer'
  // team-goals and scorer: Norway's id at ESPN
  team?: string
  // scorer: the player
  player?: string
}

// A market Claude made: how it is decided, in the words members see, from when the answer
// should be known, and where Claude means to look it up
export interface ClaudeRule {
  type: 'claude'
  how: string
  decideAfter: string
  sources: string[]
}

export type Rule = FootballRule | ClaudeRule

// What a rule came to: the outcome by its place, on a multi market every outcome that came
// true, the number for over/under, or nothing to decide on, in which case the market is called
// off. With what the bot found, and a link.
export type Verdict = ({ outcome: number } | { outcomes: number[] } | { value: number } | { void: true }) & {
  note: string
  url?: string
}

// What members see on the market: how it will be decided
export function describeRule(rule: Rule) {
  if (rule.type === 'claude') return `Avgjøres automatisk av Claude: ${rule.how}`
  switch (rule.bet) {
    case 'winner':
      return 'Avgjøres automatisk av resultatet etter ordinær tid (90 minutter).'
    case 'goals':
    case 'team-goals':
      return 'Avgjøres automatisk av målene i ordinær tid (90 minutter). Selvmål teller for laget som får det.'
    case 'scorer':
      return `Avgjøres automatisk: ja hvis ${rule.player} scorer i ordinær tid. Selvmål teller ikke. Annulleres hvis han ikke spiller.`
  }
}
