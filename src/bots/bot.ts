import type { Viewer } from '../feed.ts'

// The bot opens and decides markets as an admin would. It isn't a member and never plays.
export const BOT: Viewer = { username: 'tebbet-bot', admin: true }
