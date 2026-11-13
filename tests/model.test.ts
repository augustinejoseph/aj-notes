import { describe, it, expect } from "vitest";
import {
  applyMutation,
  mutationSchema,
  plainText,
  validateDocument,
  type RecordRow,
  type Mutation,
} from "../lib/model";
const id = "10000000-0000-4000-8000-000000000001",
  copyId = "10000000-0000-4000-8000-000000000002";
const row: RecordRow = {
  id,
  kind: "notes",
  revision: 3,
  deleted: false,
  data: {
    title: "Server edit",
    folderId: null,
    document: [
      {
        type: "paragraph",
        content: [{ type: "text", text: "Keep this", styles: {} }],
      },
    ],
  },
};
const mutation: Mutation = {
  id: crypto.randomUUID(),
  entityId: id,
  kind: "notes",
  baseRevision: 3,
  deleted: false,
  data: { title: "Local edit", folderId: null, document: [] },
};
describe("revision and conflict preservation", () => {
  it("updates against the expected revision", () => {
    const r = applyMutation(row, mutation, () => copyId);
    expect(r.conflict).toBe(false);
    expect(r.row.revision).toBe(4);
    expect(r.row.id).toBe(id);
  });
  it("keeps both edits under the same note ID", () => {
    const r = applyMutation(
      row,
      { ...mutation, baseRevision: 1 },
      () => copyId,
    );
    expect(r.conflict).toBe(true);
    expect(r.row.id).toBe(id);
    expect(r.row.data.title).toBe("Local edit");
    expect(r.row.data.conflictVersions).toEqual([{ ...row.data, revision: 3 }]);
    expect(row.data.title).toBe("Server edit");
  });
  it("does not archive identical stale uploads", () => {
    const r = applyMutation(
      row,
      { ...mutation, baseRevision: 1, data: row.data },
      () => copyId,
    );
    expect(r.row.id).toBe(id);
    expect(r.row.data.conflictVersions).toEqual([]);
  });
  it("retains history and preserves the displaced content on restore", () => {
    const first = applyMutation(
      row,
      { ...mutation, baseRevision: 1 },
      () => copyId,
    ).row;
    const restored = applyMutation(
      first,
      {
        ...mutation,
        baseRevision: first.revision,
        data: { ...row.data, restoreConflictRevision: 3 },
      },
      () => copyId,
    ).row;
    expect(restored.id).toBe(id);
    expect(restored.data.title).toBe(row.data.title);
    expect(restored.data.conflictVersions?.map((v) => v.title)).toEqual([
      "Server edit",
      "Local edit",
    ]);
    const edited = applyMutation(
      restored,
      { ...mutation, baseRevision: restored.revision },
      () => copyId,
    ).row;
    expect(edited.data.conflictVersions).toEqual(
      restored.data.conflictVersions,
    );
  });
  it("does not resurrect a deleted note after a stale offline edit", () => {
    const r = applyMutation(
      { ...row, deleted: true },
      { ...mutation, baseRevision: 2 },
      () => copyId,
    );
    expect(r.row.id).toBe(copyId);
    expect(r.row.deleted).toBe(false);
  });
  it("preserves the current row for the deletion conflict transaction", () => {
    const r = applyMutation(
      row,
      { ...mutation, baseRevision: 1, deleted: true },
      () => copyId,
    );
    expect(r.row).toEqual(row);
    expect(r.conflict).toBe(true);
  });
});
describe("document trust boundary", () => {
  it("rejects script links, remote image URLs, unsupported blocks, and excessive nesting", () => {
    expect(
      validateDocument([
        {
          type: "paragraph",
          content: [{ type: "link", href: "javascript:alert(1)" }],
        },
      ]),
    ).toBe(false);
    expect(
      validateDocument([
        { type: "image", props: { url: "https://external/image.png" } },
      ]),
    ).toBe(false);
    expect(validateDocument([{ type: "iframe" }])).toBe(false);
    let deep: unknown = "x";
    for (let i = 0; i < 30; i++) deep = [deep];
    expect(validateDocument([{ type: "paragraph", content: deep }])).toBe(
      false,
    );
  });
  it("accepts internal images and bounded Mermaid source", () => {
    expect(
      validateDocument([
        { type: "image", props: { url: `/api/images/${id}` } },
        { type: "mermaid", props: { code: "graph TD; A-->B" } },
      ]),
    ).toBe(true);
  });
  it("validates folder IDs and note shape before persistence", () => {
    expect(mutationSchema.safeParse(mutation).success).toBe(true);
    expect(
      mutationSchema.safeParse({
        ...mutation,
        data: { ...mutation.data, folderId: "not-a-uuid" },
      }).success,
    ).toBe(false);
  });
});
describe("AI source extraction", () => {
  it("includes tables and Mermaid while excluding image bytes, URLs, and captions", () => {
    const text = plainText([
      { type: "paragraph", content: [{ type: "text", text: "Idea" }] },
      { type: "image", props: { url: "/private", caption: "Do not send" } },
      { type: "mermaid", props: { code: "graph TD; A-->B" } },
      {
        type: "table",
        content: { rows: [{ cells: [[{ type: "text", text: "Cell" }]] }] },
      },
    ]);
    expect(text).toContain("Idea");
    expect(text).toContain("Cell");
    expect(text).toContain("A-->B");
    expect(text).not.toContain("/private");
    expect(text).not.toContain("Do not send");
  });
});
