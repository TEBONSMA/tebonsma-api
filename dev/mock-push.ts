import type { PushSubscription } from '../src/push.ts'

// Stands in for the push services (Google, Apple, Mozilla) during local development: a push is
// printed instead of sent, as one line the tests read
export const mockPush = async ({ endpoint }: PushSubscription, payload: string) => {
  console.log(`[push] ${JSON.stringify({ endpoint, ...JSON.parse(payload) })}`)
}
