import { randomUUID } from 'node:crypto'
import { HTTPException } from 'hono/http-exception'
import { db } from '../db.ts'
import { sniffImage } from '../feed.ts'

// Files that have been attached to a mail that is being written, the same way the feed keeps
// files for a post that hasn't been published yet: they belong to the member who uploaded them
// and are removed when the mail is sent or a day has passed.
db.exec(`
  CREATE TABLE IF NOT EXISTS mail_uploads (
    id         TEXT PRIMARY KEY,
    owner      TEXT NOT NULL,
    name       TEXT NOT NULL,
    mime       TEXT NOT NULL,
    size       INTEGER NOT NULL,
    is_image   INTEGER NOT NULL,
    data       BLOB NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS mail_uploads_owner ON mail_uploads (owner);
`)

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024
export const MAX_MAIL_BYTES = 25 * 1024 * 1024
const KEEP_MS = 24 * 60 * 60 * 1000
const MAX_PER_MEMBER = 30

export interface Upload {
  id: string
  name: string
  mime: string
  size: number
  isImage: boolean
  url: string
}

const cleanName = (name: string) =>
  name
    .replace(/[\u0000-\u001f\u007f/\\]/g, '')
    .trim()
    .slice(-120) || 'fil'

const toUpload = (row: { id: string; name: string; mime: string; size: number; is_image: number }): Upload => ({
  id: row.id,
  name: row.name,
  mime: row.mime,
  size: row.size,
  isImage: row.is_image === 1,
  url: `/mail/uploads/${row.id}`,
})

export function saveUpload(owner: string, file: { name: string; type: string; bytes: Uint8Array }): Upload {
  db.prepare('DELETE FROM mail_uploads WHERE created_at < ?').run(new Date(Date.now() - KEEP_MS).toISOString())
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM mail_uploads WHERE owner = ?').get(owner) as { n: number }
  if (n >= MAX_PER_MEMBER) throw new HTTPException(429, { message: 'Du har lastet opp mange filer uten å sende. Prøv igjen senere.' })

  const image = sniffImage(file.bytes)
  const mime = image ?? (/^[\w.+-]+\/[\w.+-]+$/.test(file.type) ? file.type : 'application/octet-stream')
  const row = { id: randomUUID(), name: cleanName(file.name), mime, size: file.bytes.length, is_image: image ? 1 : 0 }
  db.prepare('INSERT INTO mail_uploads (id, owner, name, mime, size, is_image, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    row.id,
    owner,
    row.name,
    row.mime,
    row.size,
    row.is_image,
    file.bytes,
    new Date().toISOString(),
  )
  return toUpload(row)
}

// The member's own uploads, in the order asked for. One that is gone (a day passed) is an error.
export function takeUploads(owner: string, ids: string[]) {
  return ids.map(id => {
    const row = db.prepare('SELECT id, name, mime, size, is_image, data FROM mail_uploads WHERE id = ? AND owner = ?').get(id, owner) as
      | { id: string; name: string; mime: string; size: number; is_image: number; data: Uint8Array }
      | undefined
    if (!row) throw new HTTPException(400, { message: 'Et vedlegg finnes ikke lenger. Last det opp på nytt.' })
    return { upload: toUpload(row), content: Buffer.from(row.data) }
  })
}

export function readUpload(owner: string, id: string) {
  const [found] = (() => {
    try {
      return takeUploads(owner, [id])
    } catch {
      throw new HTTPException(404, { message: 'Vedlegget finnes ikke' })
    }
  })()
  return { name: found.upload.name, mime: found.upload.mime, isImage: found.upload.isImage, content: found.content }
}

export function deleteUploads(owner: string, ids: string[]) {
  for (const id of ids) db.prepare('DELETE FROM mail_uploads WHERE id = ? AND owner = ?').run(id, owner)
}
