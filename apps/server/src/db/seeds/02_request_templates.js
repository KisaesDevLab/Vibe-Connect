/**
 * Phase 24.6 — three starter Request templates seeded for new appliances.
 *
 * Names are unique while active (partial unique index in the
 * 20260425000001 migration). We skip the seed when an active template
 * with the same name already exists, so this seed is idempotent and safe
 * to re-run on installs that have customised templates.
 *
 * Templates are firm-internal config — `item_specs` is cleartext JSON.
 * When staff applies one to a conversation, the staff client encrypts each
 * spec's `title`/`description` under the conversation's content key before
 * POSTing the resulting items. See requestsService.createList().
 */
exports.seed = async function seed(knex) {
  // Pick any existing user as `created_by`. The seed users from
  // 01_groups_and_users always have an admin (`kurt`); if that's missing
  // (e.g. a fresh prod install with operators added later), grab the
  // earliest-created user. If there's NO user yet (truly empty db), bail —
  // templates can be created from the admin UI later.
  const owner = await knex('users')
    .orderBy('created_at')
    .first('id');
  if (!owner) return;

  const templates = [
    {
      name: 'Year-end tax documents (1040)',
      description:
        'Standard intake for individual 1040 returns. Adjust before applying to a specific client.',
      item_specs: [
        {
          title: 'W-2 forms',
          description: 'All W-2s from every employer in the tax year.',
          responseType: 'file',
          sortOrder: 0,
        },
        {
          title: '1099-INT / 1099-DIV',
          description: 'Interest and dividend statements from each financial institution.',
          responseType: 'file',
          sortOrder: 1,
        },
        {
          title: '1099-MISC / 1099-NEC',
          description: 'Self-employment or contractor income.',
          responseType: 'file',
          sortOrder: 2,
        },
        {
          title: 'Mortgage interest (1098)',
          description: 'If you own your home.',
          responseType: 'file',
          sortOrder: 3,
        },
        {
          title: 'Property tax statements',
          responseType: 'file',
          sortOrder: 4,
        },
        {
          title: 'Charitable donations',
          description: 'Receipts for any cash or non-cash donations.',
          responseType: 'both',
          sortOrder: 5,
        },
        {
          title: 'Confirm filing status + dependents',
          description:
            'Reply with your filing status (single, MFJ, HoH, etc.) and any changes to dependents.',
          responseType: 'text',
          sortOrder: 6,
        },
      ],
    },
    {
      name: 'Monthly bookkeeping close',
      description:
        'Documents we need each month to close your books. Reuse this list every period.',
      item_specs: [
        {
          title: 'Bank statements',
          description: 'PDF for every business operating + savings account.',
          responseType: 'file',
          sortOrder: 0,
          defaultDueOffsetDays: 5,
        },
        {
          title: 'Credit card statements',
          responseType: 'file',
          sortOrder: 1,
          defaultDueOffsetDays: 5,
        },
        {
          title: 'Loan / line-of-credit statements',
          responseType: 'file',
          sortOrder: 2,
          defaultDueOffsetDays: 7,
        },
        {
          title: 'Payroll register',
          description: 'Latest run from your payroll provider.',
          responseType: 'file',
          sortOrder: 3,
          defaultDueOffsetDays: 5,
        },
        {
          title: 'Anything unusual we should know about?',
          description:
            'New equipment, asset sales, owner draws, large refunds — anything we should code carefully.',
          responseType: 'text',
          sortOrder: 4,
          defaultDueOffsetDays: 7,
        },
      ],
    },
    {
      name: 'New client onboarding',
      description:
        'One-time intake for a new engagement. Combines identity verification with a starter document pack.',
      item_specs: [
        {
          title: 'Engagement letter (signed)',
          description: 'Counter-signed copy returned to us.',
          responseType: 'file',
          sortOrder: 0,
        },
        {
          title: 'Photo ID',
          description: 'Driver license or passport.',
          responseType: 'file',
          sortOrder: 1,
        },
        {
          title: 'Prior-year return',
          description: 'Last filed return (or PDF transcript from the IRS).',
          responseType: 'file',
          sortOrder: 2,
        },
        {
          title: 'Business formation docs',
          description: 'EIN letter, articles of organisation, operating agreement (if applicable).',
          responseType: 'file',
          sortOrder: 3,
        },
        {
          title: 'Banking authorization',
          description:
            'A voided check or screenshot showing routing + account number, for any direct deposit you want set up.',
          responseType: 'file',
          sortOrder: 4,
        },
      ],
    },
  ];

  for (const t of templates) {
    const existing = await knex('request_templates')
      .whereRaw('LOWER(name) = LOWER(?)', [t.name])
      .whereNull('archived_at')
      .first();
    if (existing) continue;
    await knex('request_templates').insert({
      name: t.name,
      description: t.description,
      item_specs: JSON.stringify(t.item_specs),
      created_by: owner.id,
    });
  }
};
