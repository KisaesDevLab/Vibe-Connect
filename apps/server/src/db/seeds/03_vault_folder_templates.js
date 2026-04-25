/**
 * Phase 26 — default Client Vault folder template.
 *
 * Idempotent: only writes when `firm_settings.vault_folder_templates` is
 * still empty (the migration default `[]`). An admin who has customised
 * the template list is left alone on re-seed.
 *
 * `nameTemplate` is cleartext config; the `{YYYY}` placeholder is replaced
 * at apply-time on the staff client, then the resulting folder name is
 * encrypted under the zone key before insert into vault_folders. Templates
 * themselves are firm-internal — the server never sees decrypted folder
 * names, so cleartext templates here aren't a leak.
 *
 * Default mirrors what tax firms use for engagement structure. Edit through
 * the admin UI to adapt for bookkeeping-only / advisory-only firms.
 */
exports.seed = async function seed(knex) {
  const row = await knex('firm_settings').where({ id: 1 }).first('vault_folder_templates');
  if (!row) return; // firm_settings not seeded yet — earlier seed will create it
  const existing = Array.isArray(row.vault_folder_templates)
    ? row.vault_folder_templates
    : JSON.parse(row.vault_folder_templates ?? '[]');
  if (existing.length > 0) return;

  const defaults = [
    { nameTemplate: 'Tax Year {YYYY}/Source Documents', zone: 'shared', retentionDays: null },
    { nameTemplate: 'Tax Year {YYYY}/Workpapers', zone: 'staff_only', retentionDays: null },
    { nameTemplate: 'Tax Year {YYYY}/Final Deliverables', zone: 'shared', retentionDays: null },
    { nameTemplate: 'Tax Year {YYYY}/Signed Forms', zone: 'shared', retentionDays: 2555 }, // 7y
    { nameTemplate: 'Permanent File', zone: 'staff_only', retentionDays: null },
    { nameTemplate: 'Bookkeeping', zone: 'shared', retentionDays: null },
  ];

  await knex('firm_settings')
    .where({ id: 1 })
    .update({ vault_folder_templates: JSON.stringify(defaults) });
};
