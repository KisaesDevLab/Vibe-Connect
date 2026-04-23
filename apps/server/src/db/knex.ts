import Knex from 'knex';
// @ts-expect-error — CJS require-interop for the knexfile
import config from '../../knexfile.cjs';

const env = (process.env.NODE_ENV ?? 'development') as 'development' | 'test' | 'production';
const selected = config[env] ?? config.development;

export const db = Knex(selected);
export type DB = typeof db;
