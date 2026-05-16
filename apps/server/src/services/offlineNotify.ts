// Offline notification fanout. When a new message lands in a conversation,
// each staff member who isn't presently connected over a socket gets pinged
// via their configured fallback channels (push, email, SMS) — subject to
// per-user DND windows and urgent-only filters.
//
// CRYPTO: outbound payloads are metadata-only. Subject + body never include
// the message text. Bridged-out content is the staff-app's responsibility,
// not this service's. See vibe-connect-build-plan.md "metadata-only
// notifications" for the rationale.
//
// Wiring: call notifyForNewMessage() once per `message:new` realtime event
// (after the publish() that delivers ciphertext to live sockets). Do it
// fire-and-forget — a slow email/SMS provider must not block the request
// path. Errors are logged, never thrown to the caller.
import type { Knex } from 'knex';
import { db } from '../db/knex.js';
import { env } from '../env.js';
import { effectiveUrls } from './effectiveUrls.js';
import { logger } from '../logger.js';
import { getEmailProvider } from '../bridges/email/index.js';
import { getSmsProvider } from '../bridges/sms/index.js';
import { sendPushForUser } from '../routes/notifications.js';

export interface OfflineNotifyArgs {
  conversationId: string;
  messageId: string;
  /** Staff sender — the user who triggered this message. Null for portal-originated messages. */
  senderUserId: string | null;
  /** External (client) sender — for portal-originated messages. Null otherwise. */
  senderExternalIdentityId: string | null;
  urgent: boolean;
}

interface RecipientRow {
  user_id: string;
  display_name: string;
  email: string | null;
  phone: string | null;
  socket_count: number;
  dnd_enabled: boolean;
  dnd_start: string;
  dnd_end: string;
  timezone: string;
  urgent_overrides_dnd: boolean;
  email_fallback_enabled: boolean;
  email_fallback_urgent_only: number;
  sms_fallback_enabled: boolean;
  sms_fallback_urgent_only: number;
}

interface SenderInfo {
  displayName: string;
}

/**
 * Resolve the human-readable name we attribute the notification to. Used in
 * subject lines + SMS bodies. Falls back to a neutral "your firm" label when
 * the row can't be loaded so notifications never leak "(unknown sender)" or
 * raw IDs to recipients.
 */
async function loadSender(args: OfflineNotifyArgs, trx?: Knex.Transaction): Promise<SenderInfo> {
  const exec = trx ?? db;
  if (args.senderUserId) {
    const row = await exec('users').where({ id: args.senderUserId }).first('display_name');
    if (row?.display_name) return { displayName: row.display_name as string };
  }
  if (args.senderExternalIdentityId) {
    const row = await exec('external_identities')
      .where({ id: args.senderExternalIdentityId })
      .first('display_name');
    if (row?.display_name) return { displayName: row.display_name as string };
  }
  return { displayName: 'A teammate' };
}

/**
 * Returns true if the recipient's local clock falls inside their DND window.
 * Windows that wrap past midnight (e.g., 20:00 → 08:00) are handled by the
 * `start > end` branch. Invalid `HH:MM` strings or unrecognized timezones
 * fall back to "no DND" so a malformed setting can never silently swallow
 * notifications.
 */
function isWithinDnd(
  now: Date,
  prefs: {
    dnd_enabled: boolean;
    dnd_start: string;
    dnd_end: string;
    timezone: string;
  },
): boolean {
  if (!prefs.dnd_enabled) return false;
  const m = /^(\d{2}):(\d{2})$/;
  const ms = m.exec(prefs.dnd_start);
  const me = m.exec(prefs.dnd_end);
  if (!ms || !me) return false;
  const startMin = Number(ms[1]) * 60 + Number(ms[2]);
  const endMin = Number(me[1]) * 60 + Number(me[2]);
  let localMin: number;
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: prefs.timezone || 'UTC',
    });
    const parts = fmt.formatToParts(now);
    // Intl quirk: 'en-US' with hour12:false reports midnight as "24" instead
    // of "00" on Node. Normalize so 24:xx is treated as 0:xx — without this
    // the DND window check returns the wrong answer for an hour every night.
    const rawHour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
    const hour = rawHour === 24 ? 0 : rawHour;
    const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
    localMin = hour * 60 + minute;
  } catch {
    return false;
  }
  if (startMin === endMin) return false;
  if (startMin < endMin) {
    return localMin >= startMin && localMin < endMin;
  }
  // Wrap-around window (overnight). Inside DND if we're past start OR before end.
  return localMin >= startMin || localMin < endMin;
}

/**
 * Pull every staff member of a conversation alongside their presence and
 * notification settings — single query so we don't N+1 against larger
 * conversation rosters. Excludes the sender so they never get notified about
 * their own message. External-identity members (portal clients) are skipped
 * entirely; their notification path is the access-code email/SMS flow, not
 * this service.
 */
async function loadRecipients(
  conversationId: string,
  excludeUserId: string | null,
): Promise<RecipientRow[]> {
  let q = db('conversation_members as cm')
    .leftJoin('users as u', 'u.id', 'cm.user_id')
    .leftJoin('user_presence as up', 'up.user_id', 'cm.user_id')
    .leftJoin('notification_prefs as np', 'np.user_id', 'cm.user_id')
    .whereNull('cm.removed_at')
    .whereNotNull('cm.user_id')
    .where('cm.conversation_id', conversationId)
    .andWhere('u.is_active', true)
    .select(
      'cm.user_id as user_id',
      'u.display_name as display_name',
      'u.email as email',
      'u.phone as phone',
      db.raw('COALESCE(up.socket_count, 0) as socket_count'),
      db.raw('COALESCE(np.dnd_enabled, false) as dnd_enabled'),
      db.raw(`COALESCE(np.dnd_start, '20:00') as dnd_start`),
      db.raw(`COALESCE(np.dnd_end, '08:00') as dnd_end`),
      db.raw(`COALESCE(np.timezone, 'UTC') as timezone`),
      db.raw('COALESCE(np.urgent_overrides_dnd, true) as urgent_overrides_dnd'),
      db.raw('COALESCE(np.email_fallback_enabled, true) as email_fallback_enabled'),
      db.raw('COALESCE(np.email_fallback_urgent_only, 1) as email_fallback_urgent_only'),
      db.raw('COALESCE(np.sms_fallback_enabled, false) as sms_fallback_enabled'),
      db.raw('COALESCE(np.sms_fallback_urgent_only, 1) as sms_fallback_urgent_only'),
    );
  if (excludeUserId) q = q.andWhere('cm.user_id', '!=', excludeUserId);
  const rows = await q;
  return rows.map((r) => ({
    user_id: String(r.user_id),
    display_name: String(r.display_name ?? ''),
    email: (r.email as string | null) ?? null,
    phone: (r.phone as string | null) ?? null,
    socket_count: Number(r.socket_count ?? 0),
    dnd_enabled: Boolean(r.dnd_enabled),
    dnd_start: String(r.dnd_start ?? '20:00'),
    dnd_end: String(r.dnd_end ?? '08:00'),
    timezone: String(r.timezone ?? 'UTC'),
    urgent_overrides_dnd: Boolean(r.urgent_overrides_dnd),
    email_fallback_enabled: Boolean(r.email_fallback_enabled),
    email_fallback_urgent_only: Number(r.email_fallback_urgent_only ?? 1),
    sms_fallback_enabled: Boolean(r.sms_fallback_enabled),
    sms_fallback_urgent_only: Number(r.sms_fallback_urgent_only ?? 1),
  }));
}

interface DispatchResult {
  userId: string;
  push: boolean;
  email: 'sent' | 'failed' | 'skipped';
  sms: 'sent' | 'failed' | 'skipped';
}

/**
 * Returns whether the configured SMS provider is reachable. Mirrors the
 * /firm/security-policy logic — staff dev appliances run with 'mock' so
 * tests work, but a missing/unrecognized provider value means "no SMS".
 */
async function smsProviderAvailable(): Promise<boolean> {
  try {
    const row = await db('firm_settings').where({ id: 1 }).first('sms_provider');
    const provider = ((row?.sms_provider as string | undefined) ?? env.smsProvider) || 'mock';
    return provider === 'textlink' || provider === 'twilio' || provider === 'mock';
  } catch {
    return false;
  }
}

async function loadFirmName(): Promise<string> {
  try {
    const row = await db('firm_settings').where({ id: 1 }).first('firm_name');
    return ((row?.firm_name as string | undefined) ?? '').trim() || 'Your firm';
  } catch {
    return 'Your firm';
  }
}

/**
 * Public entry point. Designed to be safe to await OR to fire-and-forget;
 * any per-recipient failure is caught and logged, never thrown. Returns the
 * per-recipient dispatch outcome so tests can assert behaviour without
 * mocking the providers themselves.
 */
export async function notifyForNewMessage(args: OfflineNotifyArgs): Promise<DispatchResult[]> {
  const out: DispatchResult[] = [];
  try {
    const recipients = await loadRecipients(args.conversationId, args.senderUserId);
    if (recipients.length === 0) return out;
    const [sender, smsAvailable, firmName] = await Promise.all([
      loadSender(args),
      smsProviderAvailable(),
      loadFirmName(),
    ]);
    const now = new Date();
    // Honors admin-side DB override of PORTAL_URL via firm_settings; falls
    // back to env. Resolved once per dispatch — the loop below reuses it for
    // every recipient.
    const urls = await effectiveUrls();
    const portalUrl = urls.portalUrl.replace(/\/$/, '');
    const siteUrl = urls.siteUrl;
    for (const r of recipients) {
      const result: DispatchResult = {
        userId: r.user_id,
        push: false,
        email: 'skipped',
        sms: 'skipped',
      };
      // Online recipients see the message immediately over their socket. We
      // still emit a metadata push so a backgrounded tab can surface it, but
      // skip the heavyweight email/SMS — those are explicitly "fallback".
      const online = r.socket_count > 0;
      try {
        await sendPushForUser(r.user_id, {
          conversationId: args.conversationId,
          messageId: args.messageId,
          urgent: args.urgent,
          senderDisplayName: sender.displayName,
        });
        result.push = true;
      } catch (err) {
        logger.warn('offline_notify.push_failed', {
          userId: r.user_id,
          err: err instanceof Error ? err.message : String(err),
        });
      }
      if (online) {
        out.push(result);
        continue;
      }
      const inDnd = isWithinDnd(now, r);
      const dndBlocks = inDnd && !(args.urgent && r.urgent_overrides_dnd);
      // Email path. Default-on for staff in the seeded prefs, urgent-only by
      // default — flipping the "Only urgent" toggle off escalates the volume
      // deliberately, matching the existing UI semantics.
      if (
        !dndBlocks &&
        r.email_fallback_enabled &&
        r.email &&
        (r.email_fallback_urgent_only === 0 || args.urgent)
      ) {
        try {
          const provider = await getEmailProvider();
          await provider.send({
            to: r.email,
            subject: args.urgent
              ? `[Urgent] New ${firmName} message from ${sender.displayName}`
              : `New ${firmName} message from ${sender.displayName}`,
            text:
              `Hi ${r.display_name},\n\n` +
              `${sender.displayName} sent you a new message in ${firmName}.\n` +
              (args.urgent ? `It is marked urgent.\n` : '') +
              `\nOpen the app to read it: ${portalUrl || siteUrl}\n\n` +
              `This email never includes the message body — sign in to read it.\n`,
          });
          result.email = 'sent';
        } catch (err) {
          result.email = 'failed';
          logger.warn('offline_notify.email_failed', {
            userId: r.user_id,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }
      // SMS path — gated on (1) firm-level provider availability, (2) staff
      // member having a phone on file, (3) per-user opt-in. Off by default
      // because the firm pays per-message and SMS is more intrusive than
      // email; the staff member must deliberately enable it.
      if (
        !dndBlocks &&
        smsAvailable &&
        r.sms_fallback_enabled &&
        r.phone &&
        (r.sms_fallback_urgent_only === 0 || args.urgent)
      ) {
        try {
          const provider = await getSmsProvider();
          const prefix = args.urgent ? `[Urgent] ${firmName}: ` : `${firmName}: `;
          const open = portalUrl || siteUrl;
          await provider.sendMessage({
            to: r.phone,
            body: `${prefix}${sender.displayName} sent you a new message. Open: ${open}`,
          });
          result.sms = 'sent';
        } catch (err) {
          result.sms = 'failed';
          logger.warn('offline_notify.sms_failed', {
            userId: r.user_id,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }
      out.push(result);
    }
  } catch (err) {
    logger.error('offline_notify.fanout_failed', {
      conversationId: args.conversationId,
      messageId: args.messageId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
  return out;
}

// ---------------- Phase 24 client-side fanout ----------------

interface ExternalRecipientRow {
  external_identity_id: string;
  display_name: string;
  email: string | null;
  phone: string | null;
  email_notifications: boolean;
  sms_notifications: boolean;
}

async function loadExternalRecipients(conversationId: string): Promise<ExternalRecipientRow[]> {
  // Active external_identity members of the conversation, with their
  // notification prefs. We read from `external_identities.preferences` JSONB
  // (set at invite time and patched via /portal/me) — `email_notifications`
  // and `sms_notifications` default to true if missing so a freshly-invited
  // client still gets out-of-band reminders.
  const rows = await db('conversation_members as cm')
    .innerJoin('external_identities as ei', 'ei.id', 'cm.external_identity_id')
    .where('cm.conversation_id', conversationId)
    .whereNull('cm.removed_at')
    .whereNull('ei.deactivated_at')
    .whereNotNull('cm.external_identity_id')
    .select(
      'cm.external_identity_id as external_identity_id',
      'ei.display_name as display_name',
      'ei.email as email',
      'ei.phone as phone',
      'ei.preferences as preferences',
    );
  return rows.map((r) => {
    const prefs = (r.preferences as Record<string, unknown> | null) ?? {};
    const email =
      typeof r.email === 'string' && !/@placeholder\.invalid$/i.test(r.email) ? r.email : null;
    return {
      external_identity_id: String(r.external_identity_id),
      display_name: String(r.display_name ?? ''),
      email,
      phone: (r.phone as string | null) ?? null,
      email_notifications:
        typeof prefs.email_notifications === 'boolean' ? prefs.email_notifications : true,
      sms_notifications:
        typeof prefs.sms_notifications === 'boolean' ? prefs.sms_notifications : false,
    };
  });
}

export interface ClientNotifyArgs {
  conversationId: string;
  /**
   * Pre-rendered SHORT cleartext payload — what the client actually receives
   * via email/SMS. CRYPTO: must be metadata-only (sender name + "open the
   * portal" link), never message body content. Capped at ~280 chars to fit
   * comfortably in one SMS segment.
   */
  shortBody: string;
  /** Subject line for email. */
  subject: string;
}

interface ClientDispatchResult {
  externalIdentityId: string;
  email: 'sent' | 'failed' | 'skipped';
  sms: 'sent' | 'failed' | 'skipped';
}

/**
 * Phase 24: client out-of-band fanout for request-list nudges + revision
 * announcements. Walks every active external_identity member of the
 * conversation and dispatches via email + SMS based on their stored prefs.
 *
 * The payload is METADATA-ONLY by construction — callers compose `shortBody`
 * + `subject` from cleartext list titles + portal links. Never include
 * decrypted message content; this path doesn't have the conversation key
 * anyway.
 *
 * Failures are caught + logged + reflected in the per-recipient result so
 * callers (and tests) can see what landed. Fire-and-forget at the call site.
 */
export async function notifyExternalRecipients(
  args: ClientNotifyArgs,
): Promise<ClientDispatchResult[]> {
  const out: ClientDispatchResult[] = [];
  try {
    const recipients = await loadExternalRecipients(args.conversationId);
    if (recipients.length === 0) return out;
    // Honors admin-side DB override of PORTAL_URL / SITE_URL via firm_settings.
    const urls = await effectiveUrls();
    const portalUrl = urls.portalUrl.replace(/\/$/, '') || urls.siteUrl;
    const firmName = await loadFirmName();
    const smsAvailable = await smsProviderAvailable();
    for (const r of recipients) {
      const result: ClientDispatchResult = {
        externalIdentityId: r.external_identity_id,
        email: 'skipped',
        sms: 'skipped',
      };
      if (r.email_notifications && r.email) {
        try {
          const provider = await getEmailProvider();
          await provider.send({
            to: r.email,
            subject: args.subject,
            text:
              `Hi ${r.display_name},\n\n${args.shortBody}\n\n` +
              `Open ${firmName}: ${portalUrl}\n\n` +
              `This email is metadata-only — sign in to read full message content.\n`,
          });
          result.email = 'sent';
        } catch (err) {
          result.email = 'failed';
          logger.warn('client_notify.email_failed', {
            externalIdentityId: r.external_identity_id,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }
      if (smsAvailable && r.sms_notifications && r.phone) {
        try {
          const provider = await getSmsProvider();
          await provider.sendMessage({
            to: r.phone,
            body: `${firmName}: ${args.shortBody} ${portalUrl}\nReply STOP to opt out.`,
          });
          result.sms = 'sent';
        } catch (err) {
          result.sms = 'failed';
          logger.warn('client_notify.sms_failed', {
            externalIdentityId: r.external_identity_id,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }
      out.push(result);
    }
  } catch (err) {
    logger.error('client_notify.fanout_failed', {
      conversationId: args.conversationId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
  return out;
}

// Test-only helper so unit tests can exercise the DND math without standing
// up the rest of the harness. Not part of the public surface.
export const __testing = { isWithinDnd };
