/**
 * Admin-driven Let's Encrypt TLS config + issued-cert metadata on firm_settings.
 *
 * - tls_staff_domain / tls_portal_domain: the two FQDNs the multi-SAN cert
 *   covers. Nullable so a freshly-installed appliance can still serve its
 *   self-signed bootstrap certs until an admin configures TLS here.
 * - tls_acme_email: ACME account contact. Used for expiry warnings from LE.
 * - tls_acme_environment: 'staging' | 'production'. Defaults to 'staging'
 *   so the first issuance from a fresh install can't accidentally burn the
 *   LE production rate-limit budget (50 certs / domain / week).
 * - tls_challenge_type: 'http-01' | 'dns-01'. DNS-01 is Phase 2; the column
 *   exists now so the Phase-2 migration is purely behavioral.
 * - tls_acme_account_key_sealed: the ACME account private key, XSalsa20-
 *   Poly1305 sealed via the same KEK pattern as providerSecrets (HKDF from
 *   SESSION_SECRET). Never returned by any HTTP endpoint; only the service
 *   module reads it.
 * - tls_cert_{subject,issuer,expires_at,requested_at}: parsed metadata for
 *   the status endpoint. The actual PEM lives on disk at env.tlsOutputDir.
 * - tls_last_error: most recent failure message for admin UX.
 */
exports.up = async function up(knex) {
  await knex.schema.alterTable('firm_settings', (t) => {
    t.text('tls_staff_domain').nullable();
    t.text('tls_portal_domain').nullable();
    t.text('tls_acme_email').nullable();
    t.string('tls_acme_environment', 16).notNullable().defaultTo('staging');
    t.string('tls_challenge_type', 16).notNullable().defaultTo('http-01');
    t.text('tls_acme_account_key_sealed').nullable();
    t.text('tls_cert_subject').nullable();
    t.text('tls_cert_issuer').nullable();
    t.timestamp('tls_cert_expires_at', { useTz: true }).nullable();
    t.timestamp('tls_cert_requested_at', { useTz: true }).nullable();
    t.text('tls_last_error').nullable();
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('firm_settings', (t) => {
    t.dropColumn('tls_last_error');
    t.dropColumn('tls_cert_requested_at');
    t.dropColumn('tls_cert_expires_at');
    t.dropColumn('tls_cert_issuer');
    t.dropColumn('tls_cert_subject');
    t.dropColumn('tls_acme_account_key_sealed');
    t.dropColumn('tls_challenge_type');
    t.dropColumn('tls_acme_environment');
    t.dropColumn('tls_acme_email');
    t.dropColumn('tls_portal_domain');
    t.dropColumn('tls_staff_domain');
  });
};
