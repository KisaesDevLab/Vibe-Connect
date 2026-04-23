import { db } from '../db/knex.js';

export interface AuditWrite {
  actorUserId?: string | null;
  actorExternalIdentityId?: string | null;
  action: string;
  targetType: string;
  targetId?: string | null;
  details?: Record<string, unknown>;
  ipAddress?: string | null;
}

export const auditRepo = {
  async write(entry: AuditWrite): Promise<void> {
    // AUDIT: every privileged action funnels through here.
    await db('audit_log').insert({
      actor_user_id: entry.actorUserId ?? null,
      actor_external_identity_id: entry.actorExternalIdentityId ?? null,
      action: entry.action,
      target_type: entry.targetType,
      target_id: entry.targetId ?? null,
      details: entry.details ?? {},
      ip_address: entry.ipAddress ?? null,
    });
  },
  list(params: { limit?: number; offset?: number; action?: string } = {}) {
    let q = db('audit_log').orderBy('created_at', 'desc');
    if (params.action) q = q.where({ action: params.action });
    if (params.limit) q = q.limit(params.limit);
    if (params.offset) q = q.offset(params.offset);
    return q;
  },
};
