/**
 * Audit log + LISTEN/NOTIFY triggers for server-to-server fanout.
 */
exports.up = async function up(knex) {
  await knex.schema.createTable('audit_log', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('actor_user_id').nullable().references('id').inTable('users').onDelete('SET NULL');
    t.uuid('actor_external_identity_id')
      .nullable()
      .references('id')
      .inTable('external_identities')
      .onDelete('SET NULL');
    t.string('action', 128).notNullable();
    t.string('target_type', 64).notNullable();
    t.string('target_id', 128).nullable();
    t.jsonb('details').notNullable().defaultTo('{}');
    t.string('ip_address', 64).nullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  await knex.raw(`CREATE INDEX idx_audit_action_created ON audit_log (action, created_at DESC)`);
  await knex.raw(`CREATE INDEX idx_audit_actor_user ON audit_log (actor_user_id, created_at DESC)`);
  await knex.raw(
    `CREATE INDEX idx_audit_actor_external ON audit_log (actor_external_identity_id, created_at DESC)`,
  );

  // `connect_events` NOTIFY channel for multi-instance fanout (Phase 5).
  // We emit payloads from application code via pg_notify(), so no triggers needed for now.
  // Documented here so operators know to listen on this channel.
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('audit_log');
};
