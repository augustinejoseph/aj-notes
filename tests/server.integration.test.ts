import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "../lib/db";
import { mutate, summarize, pullChanges } from "../lib/server";
import type { Mutation, RecordRow } from "../lib/model";
const url = process.env.NOTES_TEST_DATABASE_URL;
if (url) {
  const parsed = new URL(url);
  if (
    !["localhost", "127.0.0.1"].includes(parsed.hostname) ||
    parsed.port !== "5544" ||
    parsed.pathname !== "/aj_notes_test"
  )
    throw new Error(
      "Integration tests require the isolated local test DB on port 5544",
    );
  process.env.DATABASE_URL = url;
}
describe.skipIf(!url)("PostgreSQL sync and summary integration", () => {
  let owner: string, noteId: string;
  const note = (extra: Partial<Mutation> = {}): Mutation => ({
    id: randomUUID(),
    kind: "notes",
    entityId: noteId,
    baseRevision: 0,
    deleted: false,
    data: {
      title: "A note",
      folderId: null,
      document: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Important source", styles: {} }],
        },
      ],
    },
    ...extra,
  });
  beforeEach(async () => {
    owner = randomUUID();
    noteId = randomUUID();
    await sql()`INSERT INTO users(id,email) VALUES (${owner},${owner + "@example.test"})`;
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    await sql().end();
  });
  it("persists once when an acknowledged response is lost and retried", async () => {
    const m = note();
    const first = await mutate(owner, m);
    const second = await mutate(owner, m);
    expect(second).toEqual(first);
    const [{ count }] =
      await sql()`SELECT count(*)::int AS count FROM changes WHERE owner=${owner}`;
    expect(count).toBe(1);
  });
  it("syncs a note created and deleted entirely offline as a tombstone", async () => {
    const result = await mutate(owner, note({ deleted: true, data: {} }));
    expect(result.rows[0].deleted).toBe(true);
    expect(result.rows[0].revision).toBe(1);
    const stale = await mutate(owner, note());
    expect(stale.conflict).toBe(true);
    expect(stale.rows.some((r) => r.id !== noteId && !r.deleted)).toBe(true);
  });
  it("paginates large documents without exceeding hosting response limits", async () => {
    const data = {
      title: "Large note",
      folderId: null,
      document: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "x".repeat(1800000), styles: {} }],
        },
      ],
    };
    await mutate(owner, note({ data }));
    await mutate(owner, note({ entityId: randomUUID(), data }));
    const first = await pullChanges(owner, 0);
    expect(first.changes).toHaveLength(1);
    expect(first.more).toBe(true);
    expect(JSON.stringify(first).length).toBeLessThan(3200000);
    const second = await pullChanges(owner, first.cursor);
    expect(second.changes).toHaveLength(1);
    expect(second.more).toBe(false);
  });
  it("keeps concurrent offline edits on one note", async () => {
    await mutate(owner, note());
    const [a, b] = await Promise.all([
      mutate(
        owner,
        note({
          baseRevision: 1,
          data: { title: "Device A", folderId: null, document: [] },
        }),
      ),
      mutate(
        owner,
        note({
          baseRevision: 1,
          data: { title: "Device B", folderId: null, document: [] },
        }),
      ),
    ]);
    expect([a.conflict, b.conflict].filter(Boolean)).toHaveLength(1);
    const rows =
      await sql()`SELECT * FROM notes WHERE owner=${owner} AND deleted=false`;
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(noteId);
    const titles = [
      rows[0].data.title,
      ...rows[0].data.conflictVersions.map((v: { title: string }) => v.title),
    ];
    expect(titles).toContain("Device A");
    expect(titles).toContain("Device B");
  });
  it("retains server-owned versions, restores, and retries without duplicating history", async () => {
    await mutate(owner, note());
    await mutate(
      owner,
      note({
        baseRevision: 1,
        data: { title: "Device A", folderId: null, document: [] },
      }),
    );
    const upload = note({
      baseRevision: 1,
      data: { title: "Device B", folderId: null, document: [] },
    });
    const conflict = await mutate(owner, upload);
    expect(await mutate(owner, upload)).toEqual(conflict);
    const current = conflict.rows.find((r) => r.id === noteId)!;
    expect(current.data.conflictVersions).toHaveLength(1);
    const version = current.data.conflictVersions![0];
    const restored = await mutate(
      owner,
      note({
        baseRevision: current.revision,
        data: {
          title: version.title,
          folderId: version.folderId,
          document: version.document,
          restoreConflictRevision: version.revision,
          conflictVersions: [],
        },
      }),
    );
    expect(restored.rows[0].id).toBe(noteId);
    expect(restored.rows[0].data.title).toBe("Device A");
    expect(restored.rows[0].data.conflictVersions?.map((v) => v.title)).toEqual(
      ["Device A", "Device B"],
    );
    const edited = await mutate(
      owner,
      note({ baseRevision: restored.rows[0].revision }),
    );
    expect(edited.rows[0].data.conflictVersions).toEqual(
      restored.rows[0].data.conflictVersions,
    );
  });
  it("preserves newer server content before accepting a stale deletion", async () => {
    await mutate(owner, note());
    await mutate(
      owner,
      note({
        baseRevision: 1,
        data: { title: "Newer edit", folderId: null, document: [] },
      }),
    );
    await mutate(owner, note({ baseRevision: 1, deleted: true }));
    const rows = await sql()`SELECT * FROM notes WHERE owner=${owner}`;
    expect(rows.find((r) => r.id === noteId)?.deleted).toBe(true);
    expect(rows.find((r) => r.id !== noteId)?.data.title).toContain(
      "Newer edit",
    );
  });
  it("moves folder children to Unfiled and emits incremental changes", async () => {
    const folderId = randomUUID();
    await mutate(owner, {
      id: randomUUID(),
      kind: "folders",
      entityId: folderId,
      baseRevision: 0,
      deleted: false,
      data: { title: "Folder" },
    });
    await mutate(
      owner,
      note({ data: { title: "Filed", folderId, document: [] } }),
    );
    const result = await mutate(owner, {
      id: randomUUID(),
      kind: "folders",
      entityId: folderId,
      baseRevision: 1,
      deleted: true,
      data: {},
    });
    const changes = await pullChanges(owner, 0);
    expect(
      (changes.changes.at(-1)?.payload as RecordRow).data.folderId,
    ).toBeNull();
    expect(result.rows).toHaveLength(1);
  });
  it("prevents one owner from overwriting another owner’s UUID", async () => {
    await mutate(owner, note());
    const stranger = randomUUID();
    await sql()`INSERT INTO users(id,email) VALUES (${stranger},${stranger + "@example.test"})`;
    await expect(mutate(stranger, note())).rejects.toThrow("ID unavailable");
  });
  it("retains edited summaries across regeneration and deletes just the selected version", async () => {
    process.env.OPENROUTER_API_KEY = "test-only";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  overview: "Overview",
                  bullets: ["Key point"],
                }),
              },
            },
          ],
        }),
      ),
    );
    await mutate(owner, note());
    const job = randomUUID();
    const first = (await summarize(owner, job, noteId, 1)) as {
      rows: RecordRow[];
    };
    expect(await summarize(owner, job, noteId, 1)).toEqual(first);
    const summary = first.rows.find((r) => r.kind === "summaries")!;
    await mutate(owner, {
      id: randomUUID(),
      kind: "summaries",
      entityId: summary.id,
      baseRevision: 1,
      deleted: false,
      data: {
        document: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "Manual tweak", styles: {} }],
          },
        ],
      },
    });
    const second = (await summarize(owner, randomUUID(), noteId, 2)) as {
      rows: RecordRow[];
    };
    expect(second.rows.find((r) => r.kind === "summaries")?.id).not.toBe(
      summary.id,
    );
    const [saved] =
      await sql()`SELECT data FROM summaries WHERE id=${summary.id}`;
    expect(JSON.stringify(saved.data)).toContain("Manual tweak");
    await mutate(owner, {
      id: randomUUID(),
      kind: "summaries",
      entityId: summary.id,
      baseRevision: 2,
      deleted: true,
      data: {},
    });
    const [{ count }] =
      await sql()`SELECT count(*)::int AS count FROM summaries WHERE owner=${owner} AND deleted=false`;
    expect(count).toBe(1);
  });
  it("provider failure preserves the source and existing summaries", async () => {
    process.env.OPENROUTER_API_KEY = "test-only";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("private provider body", { status: 429 })),
    );
    await mutate(owner, note());
    await expect(summarize(owner, randomUUID(), noteId, 1)).rejects.toThrow(
      "429",
    );
    const [saved] = await sql()`SELECT * FROM notes WHERE id=${noteId}`;
    expect(saved.revision).toBe(1);
    expect(JSON.stringify(saved.data)).toContain("Important source");
    const [{ count }] =
      await sql()`SELECT count(*)::int AS count FROM summaries WHERE owner=${owner}`;
    expect(count).toBe(0);
  });
  it("keeps offline summary edits when another device has regenerated", async () => {
    process.env.OPENROUTER_API_KEY = "test-only";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          choices: [
            {
              message: {
                content: JSON.stringify({ overview: "Overview", bullets: [] }),
              },
            },
          ],
        }),
      ),
    );
    await mutate(owner, note());
    const first = (await summarize(owner, randomUUID(), noteId, 1)) as {
      rows: RecordRow[];
    };
    const old = first.rows.find((r) => r.kind === "summaries")!;
    await summarize(owner, randomUUID(), noteId, 2);
    const result = await mutate(owner, {
      id: randomUUID(),
      kind: "summaries",
      entityId: old.id,
      baseRevision: 1,
      deleted: false,
      data: {
        ...old.data,
        document: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "Offline summary edit", styles: {} },
            ],
          },
        ],
      },
    });
    expect(result.conflict).toBe(true);
    expect(
      result.rows.some((r) => r.id !== old.id && r.data.conflictOf === old.id),
    ).toBe(true);
    const [history] =
      await sql()`SELECT data FROM summaries WHERE id=${old.id}`;
    expect(JSON.stringify(history.data)).not.toContain("Offline summary edit");
  });
  it("recovers offline summary edits when the parent note was deleted", async () => {
    process.env.OPENROUTER_API_KEY = "test-only";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          choices: [
            {
              message: {
                content: JSON.stringify({ overview: "Overview", bullets: [] }),
              },
            },
          ],
        }),
      ),
    );
    await mutate(owner, note());
    const first = (await summarize(owner, randomUUID(), noteId, 1)) as {
      rows: RecordRow[];
    };
    const old = first.rows.find((r) => r.kind === "summaries")!;
    await mutate(owner, note({ baseRevision: 2, deleted: true }));
    const result = await mutate(owner, {
      id: randomUUID(),
      kind: "summaries",
      entityId: old.id,
      baseRevision: 1,
      deleted: false,
      data: {
        ...old.data,
        document: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "Keep my edit", styles: {} }],
          },
        ],
      },
    });
    const recovered = result.rows.find(
      (r) => r.kind === "notes" && !r.deleted,
    )!;
    expect(recovered.id).not.toBe(noteId);
    expect(recovered.data.currentSummaryId).toBeTruthy();
    expect(
      result.rows.some(
        (r) =>
          r.kind === "summaries" &&
          !r.deleted &&
          r.data.noteId === recovered.id,
      ),
    ).toBe(true);
  });
});
