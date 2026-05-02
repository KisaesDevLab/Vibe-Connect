// Phase 24: Client Requests & Document Collection — repositories.
//
// Three thin wrappers around the request_lists / request_items / request_
// templates tables. Business logic lives in services/requestsService.ts;
// this module is purely query plumbing so the service stays test-friendly.
//
// Item ciphertext fields (`title_ciphertext`, `description_ciphertext`,
// `revision_note_ciphertext`) are stored as bytea. Inserts accept Buffer;
// reads return Buffer. The service layer is responsible for base64-encoding
// at the API boundary.
import type { Knex } from 'knex';
import type {
  RequestItemStatus,
  RequestListStatus,
  RequestResponseType,
} from '@vibe-connect/shared-types';
import { db } from '../db/knex.js';

export interface RequestListRow {
  id: string;
  conversation_id: string;
  title: string;
  description: string | null;
  // Postgres `date` columns deserialise as `Date` objects in some node-postgres
  // versions and as ISO strings in others — accept either at the row layer and
  // normalize in the presenter (services/requestsService.ts isoDateOrNull).
  due_date: string | Date | null;
  status: RequestListStatus;
  // Nullable since 20260425000003: ON DELETE SET NULL when the creating
  // user is removed. Audit log retains the original actor.
  created_by: string | null;
  template_id: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface RequestItemRow {
  id: string;
  list_id: string;
  title_ciphertext: Buffer;
  description_ciphertext: Buffer | null;
  revision_note_ciphertext: Buffer | null;
  content_key_version: number;
  response_type: RequestResponseType;
  status: RequestItemStatus;
  sort_order: number;
  due_date: string | Date | null;
  submitted_at: string | null;
  completed_at: string | null;
  completed_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface RequestTemplateRow {
  id: string;
  name: string;
  description: string | null;
  item_specs: unknown; // jsonb — service casts to RequestTemplateItemSpec[]
  // Nullable since 20260425000003 (ON DELETE SET NULL).
  created_by: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export const requestListsRepo = {
  byId(id: string, trx?: Knex.Transaction) {
    return (trx ?? db)<RequestListRow>('request_lists').where({ id }).first();
  },
  listByConversation(conversationId: string, trx?: Knex.Transaction) {
    return (trx ?? db)<RequestListRow>('request_lists')
      .where({ conversation_id: conversationId })
      .orderBy('created_at', 'desc');
  },
  async insert(
    row: Omit<RequestListRow, 'id' | 'created_at' | 'updated_at' | 'completed_at'> & {
      completed_at?: string | null;
    },
    trx?: Knex.Transaction,
  ): Promise<RequestListRow> {
    const [created] = await (trx ?? db)<RequestListRow>('request_lists')
      .insert({
        conversation_id: row.conversation_id,
        title: row.title,
        description: row.description,
        due_date: row.due_date,
        status: row.status,
        created_by: row.created_by,
        template_id: row.template_id,
        completed_at: row.completed_at ?? null,
      })
      .returning('*');
    return created!;
  },
  async updatePartial(
    id: string,
    patch: Partial<
      Pick<RequestListRow, 'title' | 'description' | 'due_date' | 'status' | 'completed_at'>
    >,
    trx?: Knex.Transaction,
  ): Promise<RequestListRow | undefined> {
    const [row] = await (trx ?? db)<RequestListRow>('request_lists')
      .where({ id })
      .update({ ...patch, updated_at: db.fn.now() })
      .returning('*');
    return row;
  },
  /**
   * Returns the count of items per status for a single list. Cheap because
   * idx_request_items_list_status covers the WHERE+GROUP BY.
   */
  async statusCounts(
    listId: string,
    trx?: Knex.Transaction,
  ): Promise<Record<RequestItemStatus, number>> {
    const rows = await (trx ?? db)('request_items')
      .where({ list_id: listId })
      .select('status')
      .count<{ status: RequestItemStatus; count: string }[]>('* as count')
      .groupBy('status');
    const out: Record<RequestItemStatus, number> = {
      pending: 0,
      submitted: 0,
      done: 0,
      revision: 0,
    };
    for (const r of rows) out[r.status as RequestItemStatus] = Number(r.count);
    return out;
  },
};

export const requestItemsRepo = {
  byId(id: string, trx?: Knex.Transaction) {
    return (trx ?? db)<RequestItemRow>('request_items').where({ id }).first();
  },
  listByListId(listId: string, trx?: Knex.Transaction) {
    return (trx ?? db)<RequestItemRow>('request_items')
      .where({ list_id: listId })
      .orderBy([{ column: 'sort_order' }, { column: 'created_at' }]);
  },
  async insert(
    row: Omit<
      RequestItemRow,
      | 'id'
      | 'created_at'
      | 'updated_at'
      | 'submitted_at'
      | 'completed_at'
      | 'completed_by'
      | 'revision_note_ciphertext'
    > & { revision_note_ciphertext?: Buffer | null },
    trx?: Knex.Transaction,
  ): Promise<RequestItemRow> {
    const [created] = await (trx ?? db)<RequestItemRow>('request_items')
      .insert({
        list_id: row.list_id,
        title_ciphertext: row.title_ciphertext,
        description_ciphertext: row.description_ciphertext ?? null,
        revision_note_ciphertext: row.revision_note_ciphertext ?? null,
        content_key_version: row.content_key_version,
        response_type: row.response_type,
        status: row.status,
        sort_order: row.sort_order,
        due_date: row.due_date,
      })
      .returning('*');
    return created!;
  },
  async updatePartial(
    id: string,
    patch: Partial<
      Pick<
        RequestItemRow,
        | 'title_ciphertext'
        | 'description_ciphertext'
        | 'revision_note_ciphertext'
        | 'content_key_version'
        | 'response_type'
        | 'sort_order'
        | 'due_date'
      >
    >,
    trx?: Knex.Transaction,
  ): Promise<RequestItemRow | undefined> {
    const [row] = await (trx ?? db)<RequestItemRow>('request_items')
      .where({ id })
      .update({ ...patch, updated_at: db.fn.now() })
      .returning('*');
    return row;
  },
  async deleteIfPending(id: string, trx?: Knex.Transaction): Promise<number> {
    return (trx ?? db)<RequestItemRow>('request_items').where({ id, status: 'pending' }).del();
  },
  /**
   * Concurrency-safe state transition. Returns the updated row when the
   * UPDATE actually matched a row in one of the allowed source states; returns
   * undefined when the item didn't exist or was in some other state. The
   * guarded WHERE clause makes double-clicks idempotent and prevents skipping
   * states (e.g., pending → done).
   */
  async transitionStatus(
    id: string,
    fromStates: RequestItemStatus[],
    to: RequestItemStatus,
    extra: Partial<
      Pick<
        RequestItemRow,
        | 'submitted_at'
        | 'completed_at'
        | 'completed_by'
        | 'revision_note_ciphertext'
        | 'content_key_version'
      >
    > = {},
    trx?: Knex.Transaction,
  ): Promise<RequestItemRow | undefined> {
    const [row] = await (trx ?? db)<RequestItemRow>('request_items')
      .where({ id })
      .whereIn('status', fromStates)
      .update({ status: to, ...extra, updated_at: db.fn.now() })
      .returning('*');
    return row;
  },
};

export const requestTemplatesRepo = {
  byId(id: string, trx?: Knex.Transaction) {
    return (trx ?? db)<RequestTemplateRow>('request_templates').where({ id }).first();
  },
  listActive(trx?: Knex.Transaction) {
    return (trx ?? db)<RequestTemplateRow>('request_templates')
      .whereNull('archived_at')
      .orderBy('name');
  },
  async insert(
    row: Pick<RequestTemplateRow, 'name' | 'description' | 'item_specs' | 'created_by'>,
    trx?: Knex.Transaction,
  ): Promise<RequestTemplateRow> {
    // Codebase convention for jsonb columns: pre-stringify on the way in. See
    // firm_settings.sidebar_groups_order in routes/admin.ts and the seeds.
    // Skipping JSON.stringify makes pg's jsonb parser choke on the doubly-
    // serialized form knex would otherwise emit.
    const [created] = await (trx ?? db)<RequestTemplateRow>('request_templates')
      .insert({
        name: row.name,
        description: row.description,
        item_specs: JSON.stringify(row.item_specs ?? []) as unknown as never,
        created_by: row.created_by,
      })
      .returning('*');
    return created!;
  },
  async updatePartial(
    id: string,
    patch: Partial<Pick<RequestTemplateRow, 'name' | 'description' | 'item_specs'>>,
    trx?: Knex.Transaction,
  ): Promise<RequestTemplateRow | undefined> {
    const update: Record<string, unknown> = { updated_at: db.fn.now() };
    if (patch.name !== undefined) update.name = patch.name;
    if (patch.description !== undefined) update.description = patch.description;
    if (patch.item_specs !== undefined) update.item_specs = JSON.stringify(patch.item_specs);
    const [row] = await (trx ?? db)<RequestTemplateRow>('request_templates')
      .where({ id })
      .update(update)
      .returning('*');
    return row;
  },
  async archive(id: string, trx?: Knex.Transaction): Promise<RequestTemplateRow | undefined> {
    const [row] = await (trx ?? db)<RequestTemplateRow>('request_templates')
      .where({ id })
      .whereNull('archived_at')
      .update({ archived_at: db.fn.now(), updated_at: db.fn.now() })
      .returning('*');
    return row;
  },
};
