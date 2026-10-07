import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { config } from './config.ts'

mkdirSync(config.dataDir, { recursive: true })

// One connection for the whole API; each module creates its own tables
export const db = new DatabaseSync(join(config.dataDir, 'tebonsma.db'))
db.exec('PRAGMA foreign_keys = ON')

// What is to happen once the transaction that is running has been saved
let committed: (() => void)[] | null = null

export function transaction<T>(work: () => T): T {
  db.exec('BEGIN')
  committed = []
  try {
    const result = work()
    db.exec('COMMIT')
    const then = committed
    committed = null
    for (const next of then) next()
    return result
  } catch (err) {
    committed = null
    db.exec('ROLLBACK')
    throw err
  }
}

// For things that must not happen for a change that is rolled back, like a push notification.
// Outside a transaction it runs at once.
export function afterCommit(next: () => void) {
  if (committed) committed.push(next)
  else next()
}
