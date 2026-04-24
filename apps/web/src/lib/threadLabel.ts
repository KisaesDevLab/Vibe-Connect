// Shared label-builder for internal conversations that aren't 1:1 DMs.
//
// Named groups (conversation.displayName set) render as the firm-chosen name.
// Ad-hoc "Message N" threads (displayName null) are labelled by comma-joining
// the other members' display names — this replaces the anemic "(direct)"
// fallback that the inbox used before we had a sidebar surface for them.
//
// Consumed by: Sidebar's Threads section, the Inbox, and the QuickSwitcher.
import type { ConversationSummary, PublicUser } from '@vibe-connect/shared-types';

/** Maximum names to render before we collapse into "X, Y + N others". */
const MAX_VISIBLE_NAMES = 3;

export function threadLabel(
  c: ConversationSummary,
  usersById: Record<string, PublicUser>,
  meId: string | null,
): string {
  if (c.displayName && c.displayName.trim().length > 0) return c.displayName;

  // "Notes to self" — a 1-member internal conversation whose only member is me.
  // Caller may or may not filter these out before asking for a label; handle
  // defensively so the inbox never renders "(direct)" for this case.
  if (c.memberUserIds.length === 1 && meId && c.memberUserIds[0] === meId) {
    return 'Notes to self';
  }

  const others = c.memberUserIds.filter((id) => id !== meId);
  const names = others.map((id) => usersById[id]?.displayName ?? 'Unknown');
  if (names.length === 0) return 'Conversation';
  if (names.length <= MAX_VISIBLE_NAMES) return names.join(', ');
  const head = names.slice(0, MAX_VISIBLE_NAMES).join(', ');
  return `${head} + ${names.length - MAX_VISIBLE_NAMES} more`;
}

/** True when the conversation is a multi-person internal thread (not a 1:1 DM
 *  and not Notes-to-self). Used to decide sidebar Threads-section membership. */
export function isMultiPersonThread(c: ConversationSummary, meId: string | null): boolean {
  if (c.type !== 'internal') return false;
  if (c.memberUserIds.length < 2) return false;
  // 1:1 DMs are already rendered via staff-user rows in the sidebar — don't
  // duplicate them in the Threads section.
  if (c.memberUserIds.length === 2 && meId && c.memberUserIds.includes(meId)) return false;
  return true;
}
