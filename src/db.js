import pg from "pg";
import "dotenv/config";

// Store money as integer cents; make pg return BIGINT/NUMERIC as JS numbers
// (safe here — amounts are far below Number.MAX_SAFE_INTEGER).
pg.types.setTypeParser(20, (v) => (v === null ? null : parseInt(v, 10))); // int8
pg.types.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v))); // numeric
// Return DATE (played_on, starts_on, ends_on) as the raw 'YYYY-MM-DD' string, NOT
// a Date — otherwise pg shifts it through the server timezone (e.g. Sydney) and the
// calendar day comes out a day early, throwing off week calculations.
pg.types.setTypeParser(1082, (v) => v); // date

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : undefined,
});

export function query(text, params) {
  return pool.query(text, params);
}

// Run fn inside a transaction, auto rollback on throw.
export async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
