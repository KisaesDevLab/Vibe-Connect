import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { requireAdmin, requireAuth } from '../middleware/auth.js';
import { auditRepo } from '../repositories/audit.js';
import { groupsRepo } from '../repositories/groups.js';
import { publicGroup } from '../util/presenters.js';

export const groupsRouter = Router();

groupsRouter.get(
  '/',
  requireAuth,
  asyncHandler(async (_req, res) => {
    const [rows, membership] = await Promise.all([groupsRepo.all(), groupsRepo.membersByGroup()]);
    res.json({
      groups: rows.map((r) => publicGroup(r, membership[r.id] ?? [])),
    });
  }),
);

const createSchema = z.object({
  name: z.string().min(1).max(80),
  sortOrder: z.number().int().min(0).max(9_999).default(0),
});

groupsRouter.post(
  '/',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'bad_request', details: parsed.error.flatten() });
      return;
    }
    const row = await groupsRepo.create(parsed.data.name, parsed.data.sortOrder);
    await auditRepo.write({
      actorUserId: req.session.userId!,
      action: 'admin.group_created',
      targetType: 'group',
      targetId: row.id,
      details: { name: row.name },
    });
    res.status(201).json({ group: publicGroup(row, []) });
  }),
);

const renameSchema = z.object({ name: z.string().min(1).max(80) });

groupsRouter.patch(
  '/:id',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const parsed = renameSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'bad_request', details: parsed.error.flatten() });
      return;
    }
    const row = await groupsRepo.rename(req.params.id!, parsed.data.name);
    if (!row) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    await auditRepo.write({
      actorUserId: req.session.userId!,
      action: 'admin.group_renamed',
      targetType: 'group',
      targetId: row.id,
    });
    res.json({ group: publicGroup(row, []) });
  }),
);

const reorderSchema = z.object({
  updates: z.array(z.object({ id: z.string().uuid(), sortOrder: z.number().int().min(0) })),
});

groupsRouter.post(
  '/reorder',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const parsed = reorderSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'bad_request', details: parsed.error.flatten() });
      return;
    }
    await groupsRepo.reorder(parsed.data.updates);
    await auditRepo.write({
      actorUserId: req.session.userId!,
      action: 'admin.group_reordered',
      targetType: 'group',
      details: { count: parsed.data.updates.length },
    });
    res.json({ ok: true });
  }),
);

groupsRouter.delete(
  '/:id',
  requireAdmin,
  asyncHandler(async (req, res) => {
    await groupsRepo.remove(req.params.id!);
    await auditRepo.write({
      actorUserId: req.session.userId!,
      action: 'admin.group_removed',
      targetType: 'group',
      targetId: req.params.id!,
    });
    res.json({ ok: true });
  }),
);

const memberSchema = z.object({ userId: z.string().uuid() });

groupsRouter.post(
  '/:id/members',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const parsed = memberSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'bad_request', details: parsed.error.flatten() });
      return;
    }
    await groupsRepo.addMember(req.params.id!, parsed.data.userId);
    await auditRepo.write({
      actorUserId: req.session.userId!,
      action: 'admin.group_member_added',
      targetType: 'group',
      targetId: req.params.id!,
      details: { userId: parsed.data.userId },
    });
    res.json({ ok: true });
  }),
);

groupsRouter.delete(
  '/:id/members/:userId',
  requireAdmin,
  asyncHandler(async (req, res) => {
    await groupsRepo.removeMember(req.params.id!, req.params.userId!);
    await auditRepo.write({
      actorUserId: req.session.userId!,
      action: 'admin.group_member_removed',
      targetType: 'group',
      targetId: req.params.id!,
      details: { userId: req.params.userId },
    });
    res.json({ ok: true });
  }),
);
