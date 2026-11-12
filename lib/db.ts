import "../scripts/load-config.mjs";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
let connection: ReturnType<typeof postgres> | undefined;
export function sql() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is missing");
  return (connection ??= postgres(process.env.DATABASE_URL, {
    max: 5,
    prepare: false,
  }));
}
export function db() {
  return drizzle(sql());
}
