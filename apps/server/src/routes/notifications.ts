import { Router } from 'express';
import webPush from 'web-push';
import { z } from 'zod';
import { db } from '../db/knex.js';
import { env } from '../env.js';
import { logger } from '../logger.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { requireAuth } from '../middleware/auth.js';

export const notificationsRouter = Router();

if (env.vapidPublicKey && env.vapidPrivateKey) {
  webPush.setVapidDetails(env.vapidSubject, env.vapidPublicKey, env.vapidPrivateKey);
}

notificationsRouter.get(
  '/vapid-public-key',
  asyncHandler(async (_req, res) => {
    res.json({ publicKey: env.vapidPublicKey || null });
  }),
);

const subSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({ p256dh: z.string(), auth: z.string() }),
});

notificationsRouter.post(
  '/subscribe',
  requireAuth,
  asyncHandler(async (req, res) => {
    const parsed = subSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'bad_request' });
      return;
    }
    await db('push_subscriptions')
      .insert({
        user_id: req.session.userId!,
        endpoint: parsed.data.endpoint,
        p256dh: parsed.data.keys.p256dh,
        auth: parsed.data.keys.auth,
      })
      .onConflict(['user_id', 'endpoint'])
      .merge({ last_seen_at: db.fn.now() });
    res.json({ ok: true });
  }),
);

notificationsRouter.post(
  '/unsubscribe',
  requireAuth,
  asyncHandler(async (req, res) => {
    const body = z.object({ endpoint: z.string().url() }).safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'bad_request' });
      return;
    }
    await db('push_subscriptions')
      .where({ user_id: req.session.userId!, endpoint: body.data.endpoint })
      .del();
    res.json({ ok: true });
  }),
);

const prefsSchema = z.object({
  dndEnabled: z.boolean().optional(),
  dndStart: z
    .string()
    .regex(/^\d{2}:\d{2}$/)
    .optional(),
  dndEnd: z
    .string()
    .regex(/^\d{2}:\d{2}$/)
    .optional(),
  timezone: z.string().max(64).optional(),
  urgentOverridesDnd: z.boolean().optional(),
  emailFallbackEnabled: z.boolean().optional(),
  emailFallbackUrgentOnly: z.boolean().optional(),
});

notificationsRouter.get(
  '/prefs',
  requireAuth,
  asyncHandler(async (req, res) => {
    let row = await db('notification_prefs').where({ user_id: req.session.userId! }).first();
    if (!row) {
      await db('notification_prefs').insert({ user_id: req.session.userId! });
      row = await db('notification_prefs').where({ user_id: req.session.userId! }).first();
    }
    res.json({ prefs: row });
  }),
);

notificationsRouter.patch(
  '/prefs',
  requireAuth,
  asyncHandler(async (req, res) => {
    const parsed = prefsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'bad_request' });
      return;
    }
    const patch: Record<string, unknown> = {};
    if (parsed.data.dndEnabled !== undefined) patch.dnd_enabled = parsed.data.dndEnabled;
    if (parsed.data.dndStart !== undefined) patch.dnd_start = parsed.data.dndStart;
    if (parsed.data.dndEnd !== undefined) patch.dnd_end = parsed.data.dndEnd;
    if (parsed.data.timezone !== undefined) patch.timezone = parsed.data.timezone;
    if (parsed.data.urgentOverridesDnd !== undefined)
      patch.urgent_overrides_dnd = parsed.data.urgentOverridesDnd;
    if (parsed.data.emailFallbackEnabled !== undefined)
      patch.email_fallback_enabled = parsed.data.emailFallbackEnabled;
    if (parsed.data.emailFallbackUrgentOnly !== undefined)
      patch.email_fallback_urgent_only = parsed.data.emailFallbackUrgentOnly ? 1 : 0;
    if (Object.keys(patch).length > 0) {
      await db('notification_prefs')
        .where({ user_id: req.session.userId! })
        .update({ ...patch, updated_at: db.fn.now() });
    }
    res.json({ ok: true });
  }),
);

// ---------- Push sender (invoked from realtime layer when a message arrives) ----------
// Metadata-only payload — no message body ever.
export async function sendPushForUser(
  userId: string,
  payload: {
    conversationId: string;
    messageId: string;
    urgent: boolean;
    senderDisplayName?: string;
  },
): Promise<void> {
  if (!env.vapidPublicKey || !env.vapidPrivateKey) return;
  const subs = await db('push_subscriptions').where({ user_id: userId });
  const body = JSON.stringify({
    conversationId: payload.conversationId,
    messageId: payload.messageId,
    urgent: payload.urgent,
    senderDisplayName: payload.senderDisplayName,
  });
  await Promise.all(
    subs.map(async (s) => {
      try {
        await webPush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          body,
        );
      } catch (err) {
        logger.warn('push_send_failed', { endpoint: s.endpoint, err: String(err) });
        // Delete dead subscriptions (410 gone).
        if ((err as { statusCode?: number }).statusCode === 410) {
          await db('push_subscriptions').where({ endpoint: s.endpoint }).del();
        }
      }
    }),
  );
}
