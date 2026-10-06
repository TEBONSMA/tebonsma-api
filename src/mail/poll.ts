import { accountFor } from './mail.ts'
import { checkInbox, listMailNotifications } from './notifications.ts'
import { settleFailed } from './scheduled.ts'
import { releaseDue } from './snooze.ts'

// What the bell asks for every minute: first the things that happen to a member's mail with time,
// then new mail in the inbox, then the notifications about mail. A mail server that doesn't answer
// must not take the other notifications with it, so its trouble is logged and the rest is shown.
export async function pollMail(owner: string, token: string) {
  let mailUnread = 0
  try {
    const account = await accountFor(owner, token)
    await releaseDue(account, owner)
    await settleFailed(account, owner)
    mailUnread = await checkInbox(account, owner)
  } catch (err) {
    console.error(`Looking at ${owner}'s mailbox for notifications failed:`, err)
  }
  return { ...(await listMailNotifications(owner)), mailUnread }
}
