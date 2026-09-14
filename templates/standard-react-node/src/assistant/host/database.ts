import pg from "pg";
import { postgres } from "@handrail/ai-assistant/persistence/postgres";

/** The host owns the pool and closes it after assistant workers have stopped. */
export function createDatabase(connectionString: string) {
  const pool = new pg.Pool({ connectionString, max: 4 });
  return { pool, persistence: postgres(pool) };
}
