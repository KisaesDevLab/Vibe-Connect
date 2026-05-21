/**
 * Admin-editable sender address. Pre-this-migration, the From header on
 * every outbound email came from the EMAIL_FROM env var (default
 * `Vibe Connect <noreply@vibeconnect.local>`). That default can never
 * be a verified sender on a real provider (Postmark/Emailit reject any
 * From whose domain isn't on their verified-domains list), so every
 * appliance that shipped without an env-edit-and-restart silently 422'd
 * on the first send.
 *
 * The column is NULLable so an empty firm_settings row falls back to
 * `env.emailFrom` — preserves the prior shape for installs that already
 * set EMAIL_FROM in their .env. The provider boundary
 * (apps/server/src/bridges/email/index.ts) prefers DB → env.
 */
exports.up = async function up(knex) {
  await knex.schema.alterTable('firm_settings', (t) => {
    t.text('email_from').nullable();
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('firm_settings', (t) => {
    t.dropColumn('email_from');
  });
};
