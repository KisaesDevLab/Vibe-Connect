/**
 * Seed: default groups + Kurt (admin) + a few test staff.
 *
 * Passwords are bcrypt cost 12, generated from the strings below. Replace in prod.
 *   kurt     / kurt-dev-only-ChangeMe!
 *   alice    / alice-dev-only-ChangeMe!
 *   bob      / bob-dev-only-ChangeMe!
 *   carol    / carol-dev-only-ChangeMe!
 */
const bcrypt = require('bcryptjs');

exports.seed = async function seed(knex) {
  // Clear in FK-safe order. Phase 24 added request_templates / request_lists
  // / request_items with FKs back to users(id); wipe them BEFORE deleting
  // users so a re-seed against an existing DB doesn't trip the FK
  // ON DELETE RESTRICT. The IF EXISTS guards keep the seed safe to run on a
  // pre-Phase-24 database (e.g. in a downgrade scenario).
  const phase24Tables = ['request_items', 'request_lists', 'request_templates'];
  for (const t of phase24Tables) {
    const exists = await knex.schema.hasTable(t);
    if (exists) await knex(t).del();
  }
  await knex('user_groups').del();
  await knex('users').del();
  await knex('groups').del();

  const [payroll] = await knex('groups')
    .insert({ name: 'Payroll', sort_order: 1 })
    .returning(['id']);
  const [tax] = await knex('groups').insert({ name: 'Tax', sort_order: 2 }).returning(['id']);
  const [admin] = await knex('groups').insert({ name: 'Admin', sort_order: 3 }).returning(['id']);
  const [clients] = await knex('groups')
    .insert({ name: 'Clients', sort_order: 99 })
    .returning(['id']);

  const hash = (pw) => bcrypt.hashSync(pw, 12);

  const users = [
    {
      username: 'kurt',
      display_name: 'Kurt',
      email: 'kurt@vibeconnect.local',
      password_hash: hash('kurt-dev-only-ChangeMe!'),
      is_admin: true,
      is_active: true,
      status: 'active',
    },
    {
      username: 'alice',
      display_name: 'Alice (Payroll)',
      email: 'alice@vibeconnect.local',
      password_hash: hash('alice-dev-only-ChangeMe!'),
      is_admin: false,
      is_active: true,
      status: 'offline',
    },
    {
      username: 'bob',
      display_name: 'Bob (Tax)',
      email: 'bob@vibeconnect.local',
      password_hash: hash('bob-dev-only-ChangeMe!'),
      is_admin: false,
      is_active: true,
      status: 'offline',
    },
    {
      username: 'carol',
      display_name: 'Carol (Admin)',
      email: 'carol@vibeconnect.local',
      password_hash: hash('carol-dev-only-ChangeMe!'),
      is_admin: false,
      is_active: true,
      status: 'offline',
    },
  ];

  const inserted = await knex('users').insert(users).returning(['id', 'username']);
  const by = Object.fromEntries(inserted.map((u) => [u.username, u.id]));

  await knex('user_groups').insert([
    { user_id: by.kurt, group_id: admin.id },
    { user_id: by.kurt, group_id: tax.id },
    { user_id: by.alice, group_id: payroll.id },
    { user_id: by.bob, group_id: tax.id },
    { user_id: by.carol, group_id: admin.id },
  ]);

  await knex('user_presence')
    .insert(inserted.map((u) => ({ user_id: u.id, socket_count: 0 })))
    .onConflict('user_id')
    .ignore();

  await knex('firm_settings')
    .update({
      sidebar_groups_order: JSON.stringify([payroll.id, tax.id, admin.id, clients.id]),
    })
    .where({ id: 1 });
};
