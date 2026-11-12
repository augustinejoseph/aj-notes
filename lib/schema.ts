import {
  pgTable,
  text,
  uuid,
  integer,
  boolean,
  jsonb,
  bigserial,
  customType,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
const bytea = customType<{ data: Buffer }>({ dataType: () => "bytea" });
const fields = () => ({
  id: uuid().primaryKey(),
  owner: text()
    .notNull()
    .references(() => users.id),
  revision: integer().notNull(),
  deleted: boolean().notNull().default(false),
  data: jsonb().notNull(),
});
export const users = pgTable("users", {
  id: text().primaryKey(),
  email: text().notNull(),
});
export const folders = pgTable("folders", fields());
export const notes = pgTable("notes", fields());
export const summaries = pgTable("summaries", fields());
export const settings = pgTable("settings", fields());
export const images = pgTable("images", {
  id: uuid().primaryKey(),
  owner: text()
    .notNull()
    .references(() => users.id),
  mime: text().notNull(),
  bytes: bytea().notNull(),
});
export const changes = pgTable(
  "changes",
  {
    seq: bigserial({ mode: "number" }).primaryKey(),
    owner: text()
      .notNull()
      .references(() => users.id),
    payload: jsonb().notNull(),
  },
  (table) => [index("changes_owner_seq").on(table.owner, table.seq)],
);
export const receipts = pgTable("receipts", {
  id: uuid().primaryKey(),
  owner: text()
    .notNull()
    .references(() => users.id),
  result: jsonb().notNull(),
});
export const generations = pgTable(
  "generations",
  {
    id: uuid().primaryKey(),
    owner: text()
      .notNull()
      .references(() => users.id),
    noteId: uuid("note_id").notNull(),
    status: text().notNull(),
    result: jsonb(),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("one_generation_per_note")
      .on(table.owner, table.noteId)
      .where(sql`${table.status}='running'`),
  ],
);
