/**
 * Replace the user_agent-string hack that stored session_public_key and stepup_attempts
 * with dedicated columns. The previous implementation shoved "|pk=<base64>|stepup_attempts=N"
 * into a varchar(255) user_agent column, which broke both the UA field and the step-up
 * attempt counter (the counter was never read back, allowing unlimited SSN/EIN brute-force).
 */
exports.up = async function up(knex) {
  await knex.schema.alterTable('client_sessions', (t) => {
    t.text('session_public_key').nullable();
    t.integer('stepup_attempts').notNullable().defaultTo(0);
  });
  // Best-effort salvage: extract the pk from any existing rows' user_agent.
  await knex.raw(`
    UPDATE client_sessions
    SET session_public_key = substring(user_agent from '\\|pk=([A-Za-z0-9+/=_-]+)'),
        user_agent = regexp_replace(COALESCE(user_agent, ''), '\\|(pk|stepup_attempts)=[^|]*', '', 'g')
    WHERE user_agent LIKE '%|pk=%' OR user_agent LIKE '%|stepup_attempts=%'
  `);
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('client_sessions', (t) => {
    t.dropColumn('session_public_key');
    t.dropColumn('stepup_attempts');
  });
};
