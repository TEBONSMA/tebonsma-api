import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { requireCaller, type Env } from './auth.ts'
import { bad, readBody, readText, UPLOAD_HEADERS } from './feedRoutes.ts'
import {
  changeLabels,
  createOwnFolder,
  deleteForever,
  emptyTrash,
  moveMessages,
  readIds,
  readLabelIds,
  restoreMessages,
  setSeenAndFlagged,
} from './mail/actions.ts'
import { createLabel, deleteLabel, listLabels, updateLabel } from './mail/labels.ts'
import {
  accountFor,
  folderViews,
  listMessages,
  openMailbox,
  readAttachment,
  readMessage,
  SORTS,
  type Filter,
  type Sort,
} from './mail/mail.ts'

const PAGE_SIZE = 30
const MAX_PAGE_SIZE = 100

// Opens the mailbox of whoever is calling, with their own token
const accountOf = (c: Context<Env>) => accountFor(c.get('caller').username, c.get('token'))

export const mailRoutes = new Hono<Env>()

// Everything except file uploads is a small JSON body
const jsonLimit = bodyLimit({ maxSize: 512 * 1024 })
mailRoutes.use('/mail/folders', jsonLimit)
mailRoutes.use('/mail/messages/*', jsonLimit)
mailRoutes.use('/mail/labels/*', jsonLimit)
mailRoutes.use('/mail/labels', jsonLimit)

const ownerOf = (c: Context<Env>) => c.get('caller').username

mailRoutes.get('/mail/folders', requireCaller, async c => {
  const mailbox = await openMailbox(await accountOf(c))
  return c.json({ folders: folderViews(mailbox), labels: listLabels(ownerOf(c)) })
})

mailRoutes.post('/mail/folders', requireCaller, async c => {
  const { name } = await readBody(c)
  await createOwnFolder(await accountOf(c), name)
  const mailbox = await openMailbox(await accountOf(c))
  return c.json({ folders: folderViews(mailbox) }, 201)
})

const readDate = (raw: string | undefined) => {
  if (raw === undefined) return undefined
  const date = new Date(raw)
  if (Number.isNaN(date.getTime())) throw bad('Ugyldig dato')
  return date
}

const readTerm = (c: Context<Env>, name: string, what: string) => {
  const raw = c.req.query(name)
  if (raw === undefined || raw === '') return undefined
  return readText(raw, what, 200) || undefined
}

function readFilter(c: Context<Env>): Filter {
  const label = c.req.query('label')
  if (label !== undefined && !/^[0-9a-f]{8}$/.test(label)) throw bad('Ugyldig etikett')
  return {
    unread: c.req.query('unread') === '1' || undefined,
    flagged: c.req.query('flagged') === '1' || undefined,
    attachment: c.req.query('attachment') === '1' || undefined,
    text: readTerm(c, 'q', 'Søket'),
    from: readTerm(c, 'from', 'Avsenderen'),
    to: readTerm(c, 'to', 'Mottakeren'),
    subject: readTerm(c, 'subject', 'Emnet'),
    keyword: label && `$teb_${label}`,
    since: readDate(c.req.query('since')),
    before: readDate(c.req.query('before')),
  }
}

mailRoutes.get('/mail/messages', requireCaller, async c => {
  const sort = c.req.query('sort') ?? 'new'
  if (!SORTS.includes(sort as Sort)) throw bad('Ukjent sortering')
  const offset = Math.max(0, Math.trunc(Number(c.req.query('offset') ?? 0)) || 0)
  const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.trunc(Number(c.req.query('limit') ?? PAGE_SIZE)) || PAGE_SIZE))
  return c.json(
    await listMessages(await accountOf(c), {
      folder: c.req.query('folder') ?? 'inbox',
      offset,
      limit,
      sort: sort as Sort,
      filter: readFilter(c),
    }),
  )
})

// --- Changing mails. All of these take a list, so one mail and a selection are the same call. ---

mailRoutes.post('/mail/messages/flags', requireCaller, async c => {
  const body = await readBody(c)
  const { seen, flagged } = body
  if ((seen !== undefined && typeof seen !== 'boolean') || (flagged !== undefined && typeof flagged !== 'boolean')) throw bad('Ugyldig forespørsel')
  await setSeenAndFlagged(await accountOf(c), readIds(body.ids), { seen, flagged })
  return c.json({ ok: true })
})

mailRoutes.post('/mail/messages/labels', requireCaller, async c => {
  const body = await readBody(c)
  await changeLabels(await accountOf(c), ownerOf(c), readIds(body.ids), readLabelIds(body.add), readLabelIds(body.remove))
  return c.json({ ok: true })
})

// With restore, mails in the bin go back to where they came from instead of to a folder
mailRoutes.post('/mail/messages/move', requireCaller, async c => {
  const body = await readBody(c)
  const ids = readIds(body.ids)
  const account = await accountOf(c)
  if (body.restore === true) return c.json({ moved: await restoreMessages(account, ownerOf(c), ids) })
  if (typeof body.folder !== 'string') throw bad('Velg en mappe')
  return c.json({ moved: await moveMessages(account, ownerOf(c), ids, body.folder) })
})

mailRoutes.post('/mail/messages/delete', requireCaller, async c => {
  const { ids } = await readBody(c)
  return c.json({ deleted: await deleteForever(await accountOf(c), readIds(ids)) })
})

mailRoutes.post('/mail/trash/empty', requireCaller, async c => c.json({ deleted: await emptyTrash(await accountOf(c)) }))

// --- Labels ---

mailRoutes.get('/mail/labels', requireCaller, c => c.json(listLabels(ownerOf(c))))

mailRoutes.post('/mail/labels', requireCaller, async c => {
  const { name, color } = await readBody(c)
  return c.json(createLabel(ownerOf(c), name, color), 201)
})

mailRoutes.patch('/mail/labels/:id', requireCaller, async c => {
  const { name, color } = await readBody(c)
  return c.json(updateLabel(ownerOf(c), c.req.param('id'), { name, color }))
})

mailRoutes.delete('/mail/labels/:id', requireCaller, c => {
  deleteLabel(ownerOf(c), c.req.param('id'))
  return c.json({ ok: true })
})

mailRoutes.get('/mail/messages/:id', requireCaller, async c =>
  c.json(await readMessage(await accountOf(c), c.req.param('id'), c.req.query('images') === '1')),
)

mailRoutes.get('/mail/messages/:id/attachments/:n', requireCaller, async c => {
  const n = Number(c.req.param('n'))
  if (!Number.isInteger(n) || n < 0) throw bad('Ugyldig vedlegg')
  const file = await readAttachment(await accountOf(c), c.req.param('id'), n)
  return c.body(new Uint8Array(file.content), 200, {
    ...UPLOAD_HEADERS,
    'Content-Type': file.mime,
    // Whatever a mail contains, it is only ever offered as a download
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
    'Cache-Control': 'private, no-store',
  })
})
