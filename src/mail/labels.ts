import { randomBytes } from 'node:crypto'
import { HTTPException } from 'hono/http-exception'
import { db } from '../db.ts'

// A label is a name and a colour kept here, and a keyword on each mail that has it. The keyword
// is what other mail clients see; the name and colour only exist on the site.
db.exec(`
  CREATE TABLE IF NOT EXISTS mail_labels (
    owner      TEXT NOT NULL,
    id         TEXT NOT NULL,
    name       TEXT NOT NULL,
    color      TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (owner, id)
  );
`)

export const LABEL_COLORS = ['orange', 'green', 'blue', 'purple', 'pink', 'yellow', 'red', 'gray'] as const
export type LabelColor = (typeof LABEL_COLORS)[number]

export const MAX_LABELS = 50
const MAX_NAME_LENGTH = 30

export interface Label {
  id: string
  name: string
  color: LabelColor
}

export const listLabels = (owner: string) =>
  db.prepare('SELECT id, name, color FROM mail_labels WHERE owner = ? ORDER BY name COLLATE NOCASE').all(owner) as unknown as Label[]

export const labelIds = (owner: string) => new Set(listLabels(owner).map(label => label.id))

function readName(owner: string, raw: unknown, ignoring?: string) {
  if (typeof raw !== 'string') throw new HTTPException(400, { message: 'Etiketten trenger et navn' })
  const name = raw.replace(/\s+/g, ' ').trim()
  if (!name) throw new HTTPException(400, { message: 'Etiketten trenger et navn' })
  if (name.length > MAX_NAME_LENGTH) throw new HTTPException(400, { message: `Navnet kan ikke være lengre enn ${MAX_NAME_LENGTH} tegn` })
  const taken = listLabels(owner).some(label => label.id !== ignoring && label.name.toLowerCase() === name.toLowerCase())
  if (taken) throw new HTTPException(409, { message: 'Du har allerede en etikett med det navnet' })
  return name
}

function readColor(raw: unknown): LabelColor {
  if (!LABEL_COLORS.includes(raw as LabelColor)) throw new HTTPException(400, { message: 'Ukjent farge' })
  return raw as LabelColor
}

export function createLabel(owner: string, name: unknown, color: unknown): Label {
  if (listLabels(owner).length >= MAX_LABELS) throw new HTTPException(400, { message: `Du kan ha opptil ${MAX_LABELS} etiketter` })
  const label = { id: randomBytes(4).toString('hex'), name: readName(owner, name), color: readColor(color ?? 'orange') }
  db.prepare('INSERT INTO mail_labels (owner, id, name, color, created_at) VALUES (?, ?, ?, ?, ?)').run(
    owner,
    label.id,
    label.name,
    label.color,
    new Date().toISOString(),
  )
  return label
}

export function updateLabel(owner: string, id: string, changes: { name?: unknown; color?: unknown }): Label {
  const label = listLabels(owner).find(l => l.id === id)
  if (!label) throw new HTTPException(404, { message: 'Etiketten finnes ikke' })
  const next = {
    id,
    name: changes.name === undefined ? label.name : readName(owner, changes.name, id),
    color: changes.color === undefined ? label.color : readColor(changes.color),
  }
  db.prepare('UPDATE mail_labels SET name = ?, color = ? WHERE owner = ? AND id = ?').run(next.name, next.color, owner, id)
  return next
}

// The keyword stays on the mails that have it; without a name it is not shown anywhere
export function deleteLabel(owner: string, id: string) {
  const { changes } = db.prepare('DELETE FROM mail_labels WHERE owner = ? AND id = ?').run(owner, id)
  if (changes === 0) throw new HTTPException(404, { message: 'Etiketten finnes ikke' })
}
