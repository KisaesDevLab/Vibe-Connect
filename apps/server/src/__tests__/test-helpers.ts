import Knex from 'knex';
// @ts-expect-error — CJS knexfile
import config from '../../knexfile.cjs';

/** Build a fresh test-db Knex instance and reset schema+seed. */
export async function resetTestDb(): Promise<void> {
  process.env.NODE_ENV = 'test';
  const db = Knex(config.test);
  try {
    await db.migrate.rollback(undefined, true);
    await db.migrate.latest();
    await db.seed.run();
  } finally {
    await db.destroy();
  }
}

export async function closeTestDb(): Promise<void> {
  // Import db lazily to avoid pooling issues across test files
  const { db } = await import('../db/knex.js');
  await db.destroy();
}
