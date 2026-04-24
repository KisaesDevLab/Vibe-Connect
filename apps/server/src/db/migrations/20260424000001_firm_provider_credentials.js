/**
 * Provider credentials (Twilio, TextLink, Postmark, SMTP, etc.) moved off
 * env vars onto admin-writable DB rows. Each value is encrypted at rest
 * with a KEK derived from SESSION_SECRET so a DB-only leak (backups, WAL,
 * replica) doesn't expose credentials without the KEK also escaping.
 *
 * Schema choices:
 *   - Single key-value table keyed by a dotted registry string (e.g.
 *     'sms.twilio.auth_token') so adding a provider later is a code-only
 *     change, not a migration.
 *   - nonce stored alongside ciphertext. XChaCha20-Poly1305 nonce is 24
 *     bytes; we'd roll our own inside the encrypted_value blob but
 *     persisting it separately makes rotation debugging easier.
 *   - last4 kept in cleartext so the UI can show "…xyzw" without decrypting.
 *     For numeric tokens this is meaningless; for API keys it lets staff
 *     cross-check with the provider's dashboard.
 *   - updated_by_user_id audits who last rotated each key; complements the
 *     audit_log rows emitted on every write.
 */
exports.up = async function up(knex) {
  await knex.schema.createTable('firm_provider_credentials', (t) => {
    t.string('key', 64).primary();
    // NaCl secretbox: base64(nonce || ciphertext). Single column because the
    // shared @vibe-connect/crypto.secretboxEncrypt helper packs both together.
    t.text('sealed_value').notNullable();
    t.string('last4', 4).nullable();
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.uuid('updated_by_user_id').nullable().references('id').inTable('users').onDelete('SET NULL');
  });
  await knex.raw(
    `CREATE INDEX idx_firm_provider_credentials_updated_at ON firm_provider_credentials (updated_at DESC)`,
  );
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS idx_firm_provider_credentials_updated_at');
  await knex.schema.dropTableIfExists('firm_provider_credentials');
};
