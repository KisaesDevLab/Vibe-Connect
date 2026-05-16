// Effective SITE_URL / PORTAL_URL resolver.
//
// Reads firm_settings.site_url and firm_settings.portal_url and falls back
// to env.siteUrl / env.portalUrl when either is null/empty. Surfaces both
// the resolved value AND the env default so the admin settings UI can show
// "currently overridden in DB" vs "using env default" without a second
// query.
//
// Used by every server-side surface that emits a URL into a message sent
// to a client (tokenized intake link emails/SMS, invite links, offline
// notifications, etc.) so a DB override propagates uniformly.
//
// No in-process cache: firm_settings is a single row keyed by id=1, the
// query is cheap, and bootstrap.ts already hits the same row on every SPA
// load with the same pattern. If profiling ever flags this as hot, the
// cache shape should match bootstrap.ts's 60s window so an admin-saved
// change still propagates within a minute.
//
// Pre-migration / DB outage tolerance: a failing query falls through to
// env values rather than throwing. This matches bootstrap.ts's "never let
// a settings-table failure brick the SPA" invariant — the worst case is
// the operator's env defaults take effect, which is what would happen
// without this feature anyway.

import { db } from '../db/knex.js';
import { env } from '../env.js';

export interface EffectiveUrls {
  /** Resolved site URL (DB override if set, else env default). Always populated. */
  siteUrl: string;
  /** Resolved portal URL (DB override if set, else env default). Always populated. */
  portalUrl: string;
  /** What env.siteUrl resolved to. Surfaced so the admin UI can show "vs env default". */
  envSiteUrl: string;
  /** What env.portalUrl resolved to. */
  envPortalUrl: string;
  /** DB override value, or null if not set. Surfaced for the admin UI. */
  dbSiteUrl: string | null;
  /** DB override value, or null if not set. */
  dbPortalUrl: string | null;
}

export async function effectiveUrls(): Promise<EffectiveUrls> {
  let dbSiteUrl: string | null = null;
  let dbPortalUrl: string | null = null;
  try {
    const row = await db('firm_settings').where({ id: 1 }).first('site_url', 'portal_url');
    dbSiteUrl = (row?.site_url as string | null | undefined) ?? null;
    dbPortalUrl = (row?.portal_url as string | null | undefined) ?? null;
  } catch {
    // Fall through with env values. See module header for rationale.
  }
  const trimmedSite = dbSiteUrl && dbSiteUrl.trim() ? dbSiteUrl.trim() : null;
  const trimmedPortal = dbPortalUrl && dbPortalUrl.trim() ? dbPortalUrl.trim() : null;
  return {
    siteUrl: trimmedSite ?? env.siteUrl,
    portalUrl: trimmedPortal ?? env.portalUrl,
    envSiteUrl: env.siteUrl,
    envPortalUrl: env.portalUrl,
    dbSiteUrl: trimmedSite,
    dbPortalUrl: trimmedPortal,
  };
}
