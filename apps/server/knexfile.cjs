/* Knex config — used by CLI and by src/db/knex.ts */
require('dotenv/config');

const SHARED = {
  client: 'pg',
  migrations: {
    directory: './src/db/migrations',
    extension: 'js',
    loadExtensions: ['.js'],
  },
  seeds: {
    directory: './src/db/seeds',
    extension: 'js',
    loadExtensions: ['.js'],
  },
  pool: { min: 0, max: 10 },
};

module.exports = {
  development: {
    ...SHARED,
    connection:
      process.env.DATABASE_URL ?? 'postgres://vibe:vibe@localhost:5435/vibe_connect',
  },
  test: {
    ...SHARED,
    connection:
      process.env.TEST_DATABASE_URL ?? 'postgres://vibe:vibe@localhost:5435/vibe_connect_test',
    pool: { min: 0, max: 3 },
  },
  production: {
    ...SHARED,
    connection: process.env.DATABASE_URL,
    pool: { min: 2, max: 20 },
  },
};
