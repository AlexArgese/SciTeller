// auth-api/src/db/index.js
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from './schema.js';

const client = postgres(process.env.DATABASE_URL, { max: 1 });

export const db = drizzle(client, {
  schema
});

// re-export schema
export * as Schema from './schema.js';
