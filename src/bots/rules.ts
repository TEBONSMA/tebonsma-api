// How the bot decides a market, kept with the market as JSON: a question Claude made and looks
// up the answer to.

// A market Claude made: how it is decided, in the words members see, from when the answer
// should be known, and where Claude means to look it up
export interface ClaudeRule {
  type: 'claude'
  how: string
  decideAfter: string
  sources: string[]
}

export type Rule = ClaudeRule

// What a rule came to: the outcome by its place, on a multi market every outcome that came
// true, the number for over/under, or nothing to decide on, in which case the market is called
// off. With what the bot found, and a link.
export type Verdict = ({ outcome: number } | { outcomes: number[] } | { value: number } | { void: true }) & {
  note: string
  url?: string
}

// What members see on the market: how it will be decided
export const describeRule = (rule: Rule) => `Avgjøres automatisk av Claude: ${rule.how}`
