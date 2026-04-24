/**
 * Adds invite token columns to external_identities so staff can send a client
 * a message BEFORE the client has logged into the portal.
 *
 * The invite token is 32 random bytes:
 *   - first 16 bytes → bcrypt-hashed into `invite_token_hash` for verification
 *   - last 16 bytes  → seed for an X25519 keypair (derived client-side from the
 *                      raw token; server only stores the public half)
 *
 * Staff wraps conversation keys to `invite_public_key` at send time. The client
 * reconstructs the matching private key in their browser on first portal load
 * using the full token from the invite URL, then proves possession to create a
 * session whose public key is the same invite_public_key. No private key ever
 * leaves the client's machine; the server never sees plaintext.
 */
exports.up = async function up(knex) {
  await knex.schema.alterTable('external_identities', (t) => {
    t.string('invite_token_hash', 255).nullable();
    t.text('invite_public_key').nullable();
    t.timestamp('invited_at', { useTz: true }).nullable();
    t.string('invited_via', 16).nullable(); // 'email' | 'sms'
  });
  await knex.raw(
    `CREATE INDEX idx_external_identities_invite_active ON external_identities (invite_token_hash) WHERE invite_token_hash IS NOT NULL`,
  );
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS idx_external_identities_invite_active');
  await knex.schema.alterTable('external_identities', (t) => {
    t.dropColumn('invited_via');
    t.dropColumn('invited_at');
    t.dropColumn('invite_public_key');
    t.dropColumn('invite_token_hash');
  });
};
