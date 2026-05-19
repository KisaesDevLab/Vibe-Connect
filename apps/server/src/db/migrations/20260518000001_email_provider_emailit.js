/**
 * Adds 'emailit' to the email_provider enum so admins can pick Emailit
 * (https://emailit.com — v2 transactional API) from the Admin → Settings
 * dropdown. The bridge ships with a matching EmailitProvider; selecting it
 * without storing email.emailit.api_key first is blocked by the pre-flight
 * check in PATCH /admin/settings.
 *
 * Postgres 12+ allows ALTER TYPE … ADD VALUE inside a transaction so long
 * as the new value isn't used in the same transaction — which is the case
 * here (no row writes 'emailit' yet). IF NOT EXISTS guards the down-then-up
 * dev case.
 */
exports.up = async function up(knex) {
  await knex.raw(`ALTER TYPE email_provider ADD VALUE IF NOT EXISTS 'emailit'`);
};

// Postgres has no DROP VALUE for enums. Rolling back requires recreating
// the type without 'emailit' and rewriting every column that uses it —
// overkill for a forward-only enum extension. The down() is a no-op; a
// fresh DB built from migrations re-applies up() and ends in the same
// state, which is what matters.
exports.down = async function down() {};
