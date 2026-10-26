import { HTTPException } from 'hono/http-exception'
import { db } from './db.ts'

// The vedtekter as the vedtekter repo builds them: the document as JSON (paragraphs with their
// text as HTML and as written, footnotes, sources) and the PDF. Every version published is kept;
// the newest is the one in force.
db.exec(`
  CREATE TABLE IF NOT EXISTS vedtekter_versions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    -- The commit in the vedtekter repo it was built from
    commit_sha   TEXT NOT NULL,
    document     TEXT NOT NULL,
    pdf          BLOB NOT NULL,
    published_at TEXT NOT NULL
  );
`)

const MAX_DOCUMENT = 2 * 1024 * 1024
const MAX_PDF = 5 * 1024 * 1024
const TEXT_FIELDS = ['tittel', 'navn', 'vedtatt', 'versjon', 'dato'] as const

const bad = (message: string) => new HTTPException(400, { message })

interface VersionRow {
  id: number
  commit_sha: string
  document: string
  published_at: string
}

function readDocument(text: string) {
  if (text.length > MAX_DOCUMENT) throw bad('Dokumentet er for stort')
  let document: unknown
  try {
    document = JSON.parse(text)
  } catch {
    throw bad('Dokumentet er ikke JSON')
  }
  const fields = document as Record<string, unknown> | null
  if (!fields || typeof fields !== 'object' || !Array.isArray(fields.paragrafer)) throw bad('Dokumentet mangler paragrafer')
  for (const field of TEXT_FIELDS) {
    if (typeof fields[field] !== 'string') throw bad(`Dokumentet mangler ${field}`)
  }
  return fields
}

// A build from the vedtekter repo. The same commit again (a rerun) replaces the newest version
// instead of adding one.
export function publishVersion(commit: string, documentText: string, pdf: Uint8Array) {
  if (!/^[0-9a-f]{40}$/.test(commit)) throw bad('Ugyldig commit')
  const document = readDocument(documentText)
  if (pdf.length > MAX_PDF) throw bad('PDF-en er for stor')
  if (Buffer.from(pdf.subarray(0, 5)).toString('latin1') !== '%PDF-') throw bad('Ikke en PDF')
  const now = new Date().toISOString()
  const latest = db.prepare('SELECT id, commit_sha FROM vedtekter_versions ORDER BY id DESC LIMIT 1').get() as
    | { id: number; commit_sha: string }
    | undefined
  if (latest?.commit_sha === commit) {
    db.prepare('UPDATE vedtekter_versions SET document = ?, pdf = ?, published_at = ? WHERE id = ?').run(
      JSON.stringify(document),
      pdf,
      now,
      latest.id,
    )
  } else {
    db.prepare('INSERT INTO vedtekter_versions (commit_sha, document, pdf, published_at) VALUES (?, ?, ?, ?)').run(
      commit,
      JSON.stringify(document),
      pdf,
      now,
    )
  }
  return { commit, publisert: now }
}

// The vedtekter in force, with when they came to the website
export function currentVersion() {
  const row = db
    .prepare('SELECT id, commit_sha, document, published_at FROM vedtekter_versions ORDER BY id DESC LIMIT 1')
    .get() as VersionRow | undefined
  if (!row) return null
  return { ...(JSON.parse(row.document) as Record<string, unknown>), commit: row.commit_sha, publisert: row.published_at }
}

export function currentPdf() {
  const row = db.prepare('SELECT pdf FROM vedtekter_versions ORDER BY id DESC LIMIT 1').get() as { pdf: Uint8Array } | undefined
  return row?.pdf ?? null
}
