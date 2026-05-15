import type { PublicUser, Group } from '@vibe-connect/shared-types';
import type { UserRow } from '../repositories/users.js';
import type { GroupRow } from '../repositories/groups.js';

export function publicUser(row: UserRow): PublicUser {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    email: row.email,
    phone: row.phone,
    avatarUrl: row.avatar_url,
    isAdmin: row.is_admin,
    isActive: row.is_active,
    status: row.status,
    lastSeenAt: row.last_seen_at,
    showOnIntakeCard: row.show_on_intake_card,
  };
}

export function publicGroup(row: GroupRow, memberIds: string[]): Group {
  return {
    id: row.id,
    name: row.name,
    sortOrder: row.sort_order,
    members: memberIds,
  };
}
