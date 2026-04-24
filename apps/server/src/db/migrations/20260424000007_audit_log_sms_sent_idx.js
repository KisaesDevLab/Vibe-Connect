/**
 * Supporting index for the SMS monthly-cap count query.
 *
 * maybeSendOutboundSms runs
 *   SELECT count(*) FROM audit_log WHERE action = 'sms.sent' AND created_at >= ?
 * per outbound SMS attempt. With tens of thousands of audit rows per month,
 * the planner resorts to a seq scan without this index. A partial B-tree on
 * (created_at) filtered by action='sms.sent' is small (only sms.sent rows)
 * and exactly covers the query.
 *
 * Also indirectly helps the SMS inbound routing hint (see smsBridge.ts) which
 * filters the same action='sms.sent' + actor_external_identity_id prefix —
 * Postgres can still use the partial index's ctid list and join with an
 * actor filter.
 */
exports.up = async function up(knex) {
  await knex.raw(
    `CREATE INDEX IF NOT EXISTS idx_audit_sms_sent_created
     ON audit_log (created_at DESC)
     WHERE action = 'sms.sent'`,
  );
};

exports.down = async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS idx_audit_sms_sent_created`);
};
