import { Hono, type Context } from 'hono'
import { requireCaller, type Env } from './auth.ts'
import { bad, UPLOAD_HEADERS } from './feedRoutes.ts'
import { accountFor, folderViews, listMessages, openMailbox, readAttachment, readMessage } from './mail/mail.ts'

const PAGE_SIZE = 30
const MAX_PAGE_SIZE = 100

// Opens the mailbox of whoever is calling, with their own token
const accountOf = (c: Context<Env>) => accountFor(c.get('caller').username, c.get('token'))

export const mailRoutes = new Hono<Env>()

mailRoutes.get('/mail/folders', requireCaller, async c => {
  const mailbox = await openMailbox(await accountOf(c))
  return c.json({ folders: folderViews(mailbox) })
})

mailRoutes.get('/mail/messages', requireCaller, async c => {
  const sort = c.req.query('sort') ?? 'new'
  if (sort !== 'new' && sort !== 'old') throw bad('Ukjent sortering')
  const offset = Math.max(0, Math.trunc(Number(c.req.query('offset') ?? 0)) || 0)
  const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.trunc(Number(c.req.query('limit') ?? PAGE_SIZE)) || PAGE_SIZE))
  return c.json(
    await listMessages(await accountOf(c), {
      folder: c.req.query('folder') ?? 'inbox',
      offset,
      limit,
      unread: c.req.query('unread') === '1',
      sort,
    }),
  )
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
