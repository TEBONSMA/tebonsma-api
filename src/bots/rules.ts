// How the bot decides a market, kept with the market as JSON: a football match's result,
// which a machine can check.

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

export type Rule = FootballRule

// What a rule came to: the outcome by its place, the number for over/under, or nothing to
// decide on, in which case the market is called off. With what the bot found, and a link.
export type Verdict = ({ outcome: number } | { value: number } | { void: true }) & { note: string; url?: string }

// What members see on the market: how it will be decided
export function describeRule(rule: Rule) {
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
