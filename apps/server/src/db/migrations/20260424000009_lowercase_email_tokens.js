/**
 * Data fix: lowercase any mixed-case conversation_email_tokens.token values.
 *
 * ensureConversationToken used to emit base64url tokens (A-Z + a-z + 0-9 + -_).
 * processInbound lowercases the whole To: address before extracting the
 * token from the local part, so any uppercase letter in a stored token
 * would silently fail to match on inbound mail routed through an MTA that
 * normalised the local part. ensureConversationToken now emits lowercase hex
 * by default; this backfill aligns historical rows so they keep working.
 *
 * Collisions are astronomically unlikely for 16-char tokens, but on the off
 * chance the lowered form conflicts with another row we just update the
 * rows that don't collide and leave the collisions for manual review (no
 * worse than the pre-fix silent drop).
 */
exports.up = async function up(knex) {
  // Primary key on this table is conversation_id (not a synthetic id), so
  // self-join uses that column.
  //
  // Two-pass migration:
  //   1. Identify rows whose lowered form would collide with another row's
  //      existing token. Those stay uppercased — the operator can resolve
  //      the collision manually. Log the list so it surfaces in the migration
  //      output instead of silently skipping.
  //   2. Lowercase every row that has no collision.
  const collisionRows = await knex.raw(`
    SELECT t1.conversation_id, t1.token AS mixed_token
    FROM conversation_email_tokens t1
    WHERE t1.token != LOWER(t1.token)
      AND EXISTS (
        SELECT 1 FROM conversation_email_tokens t2
        WHERE t2.token = LOWER(t1.token)
          AND t2.conversation_id != t1.conversation_id
      )
  `);
  const collisions = collisionRows.rows ?? [];
  if (collisions.length > 0) {
    // Use console.warn rather than a logger import — migrations run under the
    // knex CLI as well as via programmatic migrate.latest(), and we can't
    // assume a configured pino. Writes to stderr and appears in ops output.
    //
    // One JSON line per collision so log aggregators / jq queries can parse
    // them, and cap the visible output to the first 20 rows to keep the
    // migration log readable even if the unlikely worst-case hits.
    // eslint-disable-next-line no-console
    console.warn(
      `[migration 20260424000009] ${collisions.length} mixed-case token(s) would collide ` +
        `with an existing lowercase row; leaving them as-is. ` +
        `Resolve by regenerating the affected conversation tokens manually.`,
    );
    const shown = collisions.slice(0, 20);
    for (const c of shown) {
      // eslint-disable-next-line no-console
      console.warn(
        JSON.stringify({
          migration: '20260424000009_lowercase_email_tokens',
          conversation_id: c.conversation_id,
          mixed_token: c.mixed_token,
        }),
      );
    }
    if (collisions.length > shown.length) {
      // eslint-disable-next-line no-console
      console.warn(
        `[migration 20260424000009] ... and ${collisions.length - shown.length} more ` +
          `collision(s) suppressed from output. Query conversation_email_tokens ` +
          `directly for the full list.`,
      );
    }
  }
  await knex.raw(`
    UPDATE conversation_email_tokens
    SET token = LOWER(token)
    WHERE token != LOWER(token)
      AND NOT EXISTS (
        SELECT 1 FROM conversation_email_tokens t2
        WHERE t2.token = LOWER(conversation_email_tokens.token)
          AND t2.conversation_id != conversation_email_tokens.conversation_id
      )
  `);
};

exports.down = async function down() {
  // No-op: we can't reconstruct the original mixed case.
};
