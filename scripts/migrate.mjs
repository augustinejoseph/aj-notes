import postgres from "postgres";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
const sql = postgres(process.env.DATABASE_URL, { max: 1 });
try {
  const source = await readFile(
    new URL("../drizzle/0000_initial.sql", import.meta.url),
    "utf8",
  );
  const hash = createHash("sha256").update(source).digest("hex");
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(8374201)`;
    await tx`CREATE TABLE IF NOT EXISTS notes_migrations (name text PRIMARY KEY, hash text NOT NULL)`;
    const [previous] =
      await tx`SELECT hash FROM notes_migrations WHERE name='0000_initial'`;
    if (previous) {
      if (previous.hash !== hash) throw new Error("Applied migration changed");
      return;
    }
    await tx.unsafe(source);
    await tx`INSERT INTO notes_migrations VALUES ('0000_initial',${hash})`;
  });
  console.log("Notes migrations applied");
} finally {
  await sql.end();
}
