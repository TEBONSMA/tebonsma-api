import { Hono, type Context } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { bodyLimit } from 'hono/body-limit'
import { requireCaller, type Env } from './auth.ts'
import { bad, readBody, readText, UPLOAD_HEADERS, viewerOf } from './feedRoutes.ts'
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
import { getSettings, saveSettings } from './mail/settings.ts'
import { openConversation } from './mail/threads.ts'
import { composeFrom, deleteDraft, readCompose, saveDraft, type ComposeMode } from './mail/compose.ts'
import { cancelSend, sendMail } from './mail/outbox.ts'
import { deleteUploads, MAX_UPLOAD_BYTES, readUpload, saveUpload } from './mail/uploads.ts'
import { listMembers } from './members.ts'
import { getAutoReply, readAutoReply, saveAutoReply } from './mail/autoReply.ts'
import { readUntil, releaseDue, snoozeMessages } from './mail/snooze.ts'
import { finishOffline, hasOfflineToken, offlineAvailable, revokeOffline, startOffline } from './mail/offline.ts'
import { cancelScheduled, readSendAt, rescheduleMail, scheduleMail, scheduledTimes, settleFailed } from './mail/scheduled.ts'
import { forgetInboxCount, markMailOpened } from './mail/notifications.ts'
import { deleteShared, countShared, listShared, readNote, readShared, readSharedFile, shareToFeed, shareWithMember } from './mail/share.ts'
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
mailRoutes.use('/mail/drafts/*', bodyLimit({ maxSize: 2 * 1024 * 1024 }))
mailRoutes.use('/mail/send', bodyLimit({ maxSize: 2 * 1024 * 1024 }))
mailRoutes.use('/mail/outbox/*', jsonLimit)
mailRoutes.use('/mail/scheduled/*', jsonLimit)
mailRoutes.use('/mail/shared/*', jsonLimit)
mailRoutes.use('/mail/offline/*', jsonLimit)
mailRoutes.use('/mail/offline', jsonLimit)

const ownerOf = (c: Context<Env>) => c.get('caller').username

// Whatever changes mail here may change how many are unread, so the count is worked out again at the next look
mailRoutes.use('/mail/*', async (c, next) => {
  await next()
  const caller = c.get('caller')
  if (caller && c.req.method !== 'GET') forgetInboxCount(caller.username)
})

mailRoutes.get('/mail/folders', requireCaller, async c => {
  const account = await accountOf(c)
  // Snoozed mails whose time is up come back to the inbox first, so the counts are right
  await releaseDue(account, ownerOf(c)).catch(err => console.error('Bringing back snoozed mail failed:', err))
  // Scheduled mails that could not be sent go to Drafts now that the mailbox is open
  await settleFailed(account, ownerOf(c)).catch(err => console.error('Moving unsent mail to Drafts failed:', err))
  const mailbox = await openMailbox(account)
  return c.json({ folders: folderViews(mailbox), labels: listLabels(ownerOf(c)), shared: countShared(ownerOf(c)) })
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
  const folder = c.req.query('folder') ?? 'inbox'
  // Mails other members have shared are kept here, not in the mailbox, and listed the same way
  if (folder === 'shared') {
    const filter = readFilter(c)
    return c.json(await listShared(ownerOf(c), offset, limit, sort === 'old' ? 'old' : 'new', { unread: filter.unread, q: filter.text }))
  }
  const page = await listMessages(await accountOf(c), {
    folder,
    offset,
    limit,
    sort: sort as Sort,
    filter: readFilter(c),
    conversations: getSettings(ownerOf(c)).conversations,
  })
  // A scheduled mail is listed at the time it will be sent, not the time it was written
  if (folder === 'scheduled') {
    const times = scheduledTimes(ownerOf(c))
    for (const mail of page.messages) mail.date = (mail.messageId && times.get(mail.messageId)) || mail.date
  }
  return c.json(page)
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

// With null, snoozing is taken off and the mails go back to the inbox
mailRoutes.post('/mail/messages/snooze', requireCaller, async c => {
  const body = await readBody(c)
  const ids = readIds(body.ids)
  if (body.until === undefined) throw bad('Velg når mailen skal komme tilbake')
  return c.json({ moved: await snoozeMessages(await accountOf(c), ownerOf(c), ids, readUntil(body.until)) })
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

// The whole conversation a mail is part of, oldest first
mailRoutes.get('/mail/threads/:id', requireCaller, async c => {
  const conversation = await openConversation(await accountOf(c), c.req.param('id'))
  markMailOpened(ownerOf(c), conversation.messages)
  return c.json(conversation)
})

// --- Settings ---

mailRoutes.use('/mail/settings', jsonLimit)
mailRoutes.get('/mail/settings', requireCaller, c => c.json(getSettings(ownerOf(c))))
mailRoutes.put('/mail/settings', requireCaller, async c => c.json(saveSettings(ownerOf(c), await readBody(c))))

mailRoutes.get('/mail/messages/:id', requireCaller, async c => {
  const message = await readMessage(await accountOf(c), c.req.param('id'), c.req.query('images') === '1')
  markMailOpened(ownerOf(c), [message])
  return c.json(message)
})

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

// --- Writing ---

// A mail that is being written can have files attached; they are uploaded as they are chosen
mailRoutes.post(
  '/mail/uploads',
  requireCaller,
  // Room for the multipart wrapping around the file itself
  bodyLimit({
    maxSize: MAX_UPLOAD_BYTES + 64 * 1024,
    onError: () => {
      throw new HTTPException(413, { message: 'Filen er for stor' })
    },
  }),
  async c => {
    const form = await c.req.parseBody().catch(() => null)
    const file = form?.file
    if (!(file instanceof File)) throw bad('Mangler fil')
    if (file.size === 0) throw bad('Filen er tom')
    if (file.size > MAX_UPLOAD_BYTES) throw new HTTPException(413, { message: 'Filen er for stor' })
    const bytes = new Uint8Array(await file.arrayBuffer())
    return c.json(saveUpload(ownerOf(c), { name: file.name, type: file.type, bytes }), 201)
  },
)

mailRoutes.get('/mail/uploads/:id', requireCaller, c => {
  const file = readUpload(ownerOf(c), c.req.param('id'))
  return c.body(new Uint8Array(file.content), 200, {
    ...UPLOAD_HEADERS,
    'Content-Type': file.mime,
    'Content-Disposition': `${file.isImage ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
    'Cache-Control': 'private, max-age=3600',
  })
})

mailRoutes.delete('/mail/uploads/:id', requireCaller, c => {
  deleteUploads(ownerOf(c), [c.req.param('id')])
  return c.json({ ok: true })
})

// What a new mail starts with when it answers, forwards or continues another
mailRoutes.get('/mail/messages/:id/compose', requireCaller, async c => {
  const mode = c.req.query('mode')
  if (mode !== 'reply' && mode !== 'replyAll' && mode !== 'forward' && mode !== 'draft') throw bad('Ukjent type')
  return c.json(await composeFrom(await accountOf(c), ownerOf(c), c.req.param('id'), mode as ComposeMode))
})

// Drafts are saved as they are written. The id is made by the site, and a new save replaces the old.
mailRoutes.put('/mail/drafts/:id', requireCaller, async c => {
  const body = await readBody(c)
  const input = await readCompose({ ...body, draftId: c.req.param('id') }, { forSending: false })
  return c.json({ draftId: await saveDraft(await accountOf(c), ownerOf(c), input) })
})

mailRoutes.delete('/mail/drafts/:id', requireCaller, async c => {
  await deleteDraft(await accountOf(c), c.req.param('id'))
  return c.json({ ok: true })
})

// With sendAt the mail is kept until then instead of being sent now
mailRoutes.post('/mail/send', requireCaller, async c => {
  const body = await readBody(c)
  const input = await readCompose(body, { forSending: true })
  if (body.sendAt !== undefined && body.sendAt !== null) {
    return c.json(await scheduleMail(await accountOf(c), ownerOf(c), input, readSendAt(body.sendAt)))
  }
  return c.json(await sendMail(await accountOf(c), ownerOf(c), input))
})

// :id is the mail's id in the Scheduled folder
mailRoutes.patch('/mail/scheduled/:id', requireCaller, async c => {
  const { sendAt } = await readBody(c)
  await rescheduleMail(await accountOf(c), ownerOf(c), c.req.param('id'), readSendAt(sendAt))
  return c.json({ ok: true })
})

// The mail goes back to Drafts, and the id of the draft is returned
mailRoutes.delete('/mail/scheduled/:id', requireCaller, async c => c.json(await cancelScheduled(await accountOf(c), ownerOf(c), c.req.param('id'))))

// --- Permission to send later ---

mailRoutes.get('/mail/offline', requireCaller, c => c.json({ available: offlineAvailable(), enabled: hasOfflineToken(ownerOf(c)) }))
mailRoutes.post('/mail/offline/start', requireCaller, c => c.json(startOffline(ownerOf(c))))
mailRoutes.post('/mail/offline/callback', requireCaller, async c => {
  const { code, state } = await readBody(c)
  if (typeof code !== 'string' || typeof state !== 'string' || !code || !state) throw bad('Ugyldig forespørsel')
  await finishOffline(ownerOf(c), code, state)
  return c.json({ available: true, enabled: true })
})
mailRoutes.delete('/mail/offline', requireCaller, async c => {
  await revokeOffline(ownerOf(c))
  return c.json({ available: offlineAvailable(), enabled: false })
})

mailRoutes.delete('/mail/outbox/:id', requireCaller, c => c.json(cancelSend(ownerOf(c), c.req.param('id'))))

// Who can be chosen as a recipient or to share with. No usernames or addresses: the id is the random one used in the feed.
mailRoutes.get('/members', requireCaller, async c => c.json(await listMembers(ownerOf(c))))

// --- Auto-reply, kept as a script on the mail server so it works while the member is logged out ---

mailRoutes.use('/mail/auto-reply', jsonLimit)
mailRoutes.get('/mail/auto-reply', requireCaller, async c => c.json(await getAutoReply(await accountOf(c))))
mailRoutes.put('/mail/auto-reply', requireCaller, async c =>
  c.json(await saveAutoReply(await accountOf(c), readAutoReply(await readBody(c)))),
)

// --- Sharing ---

// The member's copy of a mail goes to another member, who finds it under "Delt med meg"
mailRoutes.post('/mail/messages/:id/share/member', requireCaller, async c => {
  const body = await readBody(c)
  if (typeof body.memberId !== 'string') throw bad('Velg et medlem')
  await shareWithMember(await accountOf(c), ownerOf(c), c.req.param('id'), body.memberId, readNote(body.note))
  return c.json({ ok: true }, 201)
})

// The mail is quoted in a post in the feed, with the files it came with
mailRoutes.post('/mail/messages/:id/share/feed', requireCaller, async c => {
  const body = await readBody(c)
  const visibility = body.visibility ?? 'members'
  if (visibility !== 'public' && visibility !== 'members') throw bad('Velg hvem som skal se innlegget')
  const comment = readText(body.comment ?? '', 'Kommentaren', 1000)
  const { post, skipped } = await shareToFeed(await accountOf(c), viewerOf(c), c.req.param('id'), { comment, visibility })
  return c.json({ post, skipped }, 201)
})

mailRoutes.get('/mail/shared/:id', requireCaller, async c => {
  const shared = await readShared(ownerOf(c), c.req.param('id'))
  markMailOpened(ownerOf(c), [{ id: shared.id, messageId: null }])
  return c.json(shared)
})

mailRoutes.get('/mail/shared/:id/attachments/:n', requireCaller, c => {
  const n = Number(c.req.param('n'))
  if (!Number.isInteger(n) || n < 0) throw bad('Ugyldig vedlegg')
  const file = readSharedFile(ownerOf(c), c.req.param('id'), n)
  return c.body(new Uint8Array(file.content), 200, {
    ...UPLOAD_HEADERS,
    'Content-Type': file.mime,
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
    'Cache-Control': 'private, no-store',
  })
})

// Takes mails off the member's list of shared mail. The sender's own mail is not touched.
mailRoutes.delete('/mail/shared/:id', requireCaller, c => {
  deleteShared(ownerOf(c), [c.req.param('id')])
  return c.json({ ok: true })
})
mailRoutes.post('/mail/shared/delete', requireCaller, async c => {
  const { ids } = await readBody(c)
  deleteShared(ownerOf(c), readIds(ids))
  return c.json({ ok: true })
})
