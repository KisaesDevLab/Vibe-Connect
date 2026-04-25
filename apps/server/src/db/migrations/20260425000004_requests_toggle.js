/**
 * Firm-wide kill switch for the Phase 24 Client Requests feature. Mirrors
 * the existing `client_messaging_enabled` toggle (see migration
 * 20260423000004). When disabled:
 *   - Every `/request-lists`, `/request-items`, `/request-templates`, and
 *     `/requests/dashboard` endpoint returns 403 `requests_disabled`.
 *   - Portal `/portal/request-lists` returns an empty `{stepupRequired:
 *     false, lists: [], requestsDisabled: true}` so existing portal sessions
 *     that have the panel open silently lose new content rather than
 *     throwing.
 *   - The auto-nudge sweeper short-circuits at the firm-settings read.
 *   - The scheduled-message ticker still drains existing nudge rows but
 *     skips the actual broadcast (audit trail preserved as `nudge_skipped`).
 *   - Existing lists + items remain readable for audit; nothing is
 *     destroyed or auto-archived. Re-enabling restores the previous state.
 *
 * Default ON so existing installs upgrade without losing the feature; an
 * admin who wants to disable it does so deliberately via Admin → Settings.
 */
exports.up = async function up(knex) {
  await knex.schema.alterTable('firm_settings', (t) => {
    t.boolean('requests_enabled').notNullable().defaultTo(true);
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('firm_settings', (t) => {
    t.dropColumn('requests_enabled');
  });
};
