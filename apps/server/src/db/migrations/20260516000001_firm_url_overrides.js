/**
 * Admin-settable overrides for SITE_URL and PORTAL_URL. Null falls back to
 * the env-var values (env.siteUrl / env.portalUrl), which themselves fall
 * back to localhost defaults — that chain is unchanged. The DB-side
 * override exists because the appliance bootstrap's auto-derivation of
 * SITE_URL from the manifest subdomain template doesn't always fire on
 * upgraded installs, leaving the env at the dev default. Surfacing this
 * in Admin → Settings lets a firm admin fix client-facing URLs (intake
 * links, invite emails, offline notifications) without SSH access to
 * the appliance's /opt/vibe/env files.
 *
 * Same string(1024) cap as logo_url so a runaway paste can't fill the row.
 * Nullable + no default so an unfilled value cleanly differs from "" (which
 * we coerce to null at the route level — same pattern as app_name).
 */
exports.up = async function up(knex) {
  await knex.schema.alterTable('firm_settings', (t) => {
    t.string('site_url', 1024).nullable();
    t.string('portal_url', 1024).nullable();
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('firm_settings', (t) => {
    t.dropColumn('site_url');
    t.dropColumn('portal_url');
  });
};
