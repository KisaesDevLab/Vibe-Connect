/**
 * Phase 24 follow-up: relax `created_by` FKs from RESTRICT to SET NULL on
 * `request_lists` and `request_templates`. Operators couldn't remove a
 * staff user (via the existing `users` admin tooling) if that user had
 * ever created a request list or a template — the FK would block the
 * DELETE. The audit log already independently records the actor on the
 * matching `request.list_created` / `request.template_created` rows, so
 * losing the column-level provenance is recoverable.
 *
 * Existing rows keep their `created_by` UUID; only the cascade rule
 * changes. The column was NOT NULL — drop that constraint too so the
 * SET NULL action has somewhere to go.
 */
exports.up = async function up(knex) {
  // Postgres only allows altering FK behaviour by drop + re-add; same
  // trick the conversation_members migration uses.
  await knex.raw(`
    ALTER TABLE request_lists
      DROP CONSTRAINT request_lists_created_by_foreign,
      ALTER COLUMN created_by DROP NOT NULL,
      ADD CONSTRAINT request_lists_created_by_foreign
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
  `);
  await knex.raw(`
    ALTER TABLE request_templates
      DROP CONSTRAINT request_templates_created_by_foreign,
      ALTER COLUMN created_by DROP NOT NULL,
      ADD CONSTRAINT request_templates_created_by_foreign
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
  `);
};

exports.down = async function down(knex) {
  // Reverting requires every row to have a non-null created_by; if any
  // user has been deleted between up + down, those NULLs would block the
  // NOT NULL re-imposition. Backfill them to the first existing user
  // (best-effort) so the rollback succeeds even on a partially-cleaned
  // dataset; this is purely a developer rollback aid.
  const owner = await knex('users').orderBy('created_at').first('id');
  if (owner) {
    await knex('request_lists').whereNull('created_by').update({ created_by: owner.id });
    await knex('request_templates').whereNull('created_by').update({ created_by: owner.id });
  }
  await knex.raw(`
    ALTER TABLE request_lists
      DROP CONSTRAINT request_lists_created_by_foreign,
      ALTER COLUMN created_by SET NOT NULL,
      ADD CONSTRAINT request_lists_created_by_foreign
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT
  `);
  await knex.raw(`
    ALTER TABLE request_templates
      DROP CONSTRAINT request_templates_created_by_foreign,
      ALTER COLUMN created_by SET NOT NULL,
      ADD CONSTRAINT request_templates_created_by_foreign
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT
  `);
};
