/**
 * Session table for connect-pg-simple (staff sessions).
 */
exports.up = async function up(knex) {
  await knex.schema.createTable('session', (t) => {
    t.string('sid').primary();
    t.jsonb('sess').notNullable();
    t.timestamp('expire', { useTz: false, precision: 6 }).notNullable();
  });
  await knex.raw(`CREATE INDEX idx_session_expire ON session (expire)`);
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('session');
};
