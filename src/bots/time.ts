// Days and times as they are in Norway, where the members are
const TIME_ZONE = 'Europe/Oslo'
const DAY_MS = 24 * 60 * 60 * 1000

// YYYY-MM-DD in Norway
export const osloDate = (time: Date | string) => new Intl.DateTimeFormat('sv-SE', { timeZone: TIME_ZONE }).format(new Date(time))

// Midnight at the start of a date in Norway, as an ISO time. Norway is one or two hours ahead
// of UTC depending on the season, so the right one is the one that lands on that date.
export function osloMidnight(date: string) {
  for (const offset of ['+01:00', '+02:00']) {
    const time = new Date(`${date}T00:00:00${offset}`)
    const hour = new Intl.DateTimeFormat('en-GB', { timeZone: TIME_ZONE, hour: '2-digit', hourCycle: 'h23' }).format(time)
    if (osloDate(time) === date && hour === '00') return time.toISOString()
  }
  throw new Error(`No midnight on ${date}`)
}

export const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T12:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10)

// 0 is Monday
export const weekday = (date: string) => (new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7

// "lør. 14. nov."
export const shortDay = (time: string) =>
  new Intl.DateTimeFormat('nb-NO', { timeZone: TIME_ZONE, weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(time))
