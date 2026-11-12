"use client";
import { openDB, deleteDB, type IDBPDatabase } from "idb";
import { prepareImage } from "./image-file";
import {
  type RecordRow,
  type Kind,
  type Mutation,
  type Data,
  SETTINGS_ID,
  defaults,
} from "./model";
type LocalImage = { id: string; blob: Blob; uploaded: boolean };
type QueueItem = Mutation & { order: number };
let owner: string | null = null,
  connection: Promise<IDBPDatabase> | null = null;
let stopped = false;
const events =
  typeof window !== "undefined"
    ? new BroadcastChannel("aj-notes-events")
    : null;
const urls = new Map<string, string>();
export function notify() {
  window.dispatchEvent(new Event("notes-change"));
  events?.postMessage("changed");
}
events?.addEventListener("message", (e) => {
  if (e.data === "signout") {
    stopped = true;
    void connection?.then((db) => db.close());
    connection = null;
    window.dispatchEvent(new Event("notes-signout"));
  } else window.dispatchEvent(new Event("notes-change"));
});
export async function initialize(id: string) {
  owner = id;
  stopped = false;
  localStorage.setItem("aj-notes-owner", id);
  connection = openDB(`aj-notes-${id}`, 1, {
    upgrade(db) {
      db.createObjectStore("records", { keyPath: "key" });
      db.createObjectStore("outbox", { keyPath: "key" });
      db.createObjectStore("images", { keyPath: "id" });
      db.createObjectStore("meta");
    },
  });
  await connection;
}
async function database() {
  if (!connection || stopped) throw new Error("Sign in to access notes");
  return connection;
}
export async function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  if (!navigator.locks)
    throw new Error(
      "This browser needs Web Locks support for safe offline editing. Use a current browser.",
    );
  return navigator.locks.request(`aj-notes-${owner}`, fn);
}
export async function records(): Promise<RecordRow[]> {
  const db = await database();
  return (await db.getAll("records")).map(({ key: _, ...row }) => row);
}
export async function save(
  kind: Kind,
  id: string,
  data: Data,
  deleted = false,
  expectedRevision?: number,
) {
  return exclusive(async () => {
    const db = await database(),
      key = `${kind}:${id}`;
    const tx = db.transaction(["records", "outbox"], "readwrite");
    const current = (await tx.objectStore("records").get(key)) as
      RecordRow | undefined;
    const old = (await tx.objectStore("outbox").get(key)) as
      QueueItem | undefined;
    await tx.objectStore("records").put({
      key,
      id,
      kind,
      revision: expectedRevision ?? current?.revision ?? 0,
      data,
      deleted,
    });
    await tx.objectStore("outbox").put({
      key,
      id: crypto.randomUUID(),
      kind,
      entityId: id,
      baseRevision:
        old?.baseRevision ?? expectedRevision ?? current?.revision ?? 0,
      deleted,
      data,
      order: old?.order ?? Date.now(),
    });
    await tx.done;
    notify();
  });
}
export async function putImage(file: Blob): Promise<string> {
  file = await prepareImage(file);
  const id = crypto.randomUUID();
  await exclusive(async () => {
    await (await database()).put("images", { id, blob: file, uploaded: false });
    notify();
  });
  return `/api/images/${id}`;
}
export async function importImage(value: string): Promise<string> {
  const url = new URL(value.trim(), location.origin);
  if (
    url.origin === location.origin &&
    /^\/api\/images\/[a-f0-9-]{36}$/.test(url.pathname)
  ) {
    await imageURL(url.pathname);
    return url.pathname;
  }
  const response = await api("image-import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: url.href }),
  });
  return putImage(await response.blob());
}
export async function imageURL(path: string): Promise<string> {
  if (!path) return ""; // Empty image blocks have no attachment to resolve yet.
  const match = path.match(/^\/api\/images\/([a-f0-9-]{36})$/);
  if (!match)
    throw new Error("Image is not stored locally. Paste or upload it again.");
  if (urls.has(match[1])) return urls.get(match[1])!;
  const image = (await (await database()).get("images", match[1])) as
    LocalImage | undefined;
  if (!image)
    throw new Error(
      "Image not downloaded. Connect and sync, or upload it again.",
    );
  const url = URL.createObjectURL(image.blob);
  urls.set(match[1], url);
  return url;
}
export async function api(path: string, init?: RequestInit) {
  const res = await fetch(`/api/${path}`, {
    ...init,
    cache: "no-store",
    signal: AbortSignal.timeout(path === "summarize" ? 55000 : 15000),
  });
  if (res.status === 401)
    throw new Error("Your session expired. Sign in again before syncing.");
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error || `Request failed (${res.status})`);
  }
  return res;
}
export async function pending() {
  const db = await database();
  return (
    (await db.count("outbox")) +
    (await db.getAll("images")).filter((i: LocalImage) => !i.uploaded).length
  );
}
export async function sync(progress: (message: string) => void) {
  // A separate coordinator lock serializes network workers without delaying local edits.
  return navigator.locks.request(`aj-notes-sync-${owner}`, async () => {
    if (!navigator.onLine)
      throw new Error("Offline — changes are saved on this device");
    await api("identity");
    const db = await database();
    const images = await exclusive(
      async () => (await db.getAll("images")) as LocalImage[],
    );
    for (const image of images.filter((i) => !i.uploaded)) {
      progress("Uploading images…");
      await api(`images/${image.id}`, {
        method: "PUT",
        headers: { "Content-Type": image.blob.type },
        body: image.blob,
      });
      await exclusive(async () => {
        await db.put("images", { ...image, uploaded: true });
      });
    }
    const queue = await exclusive(async () =>
      ((await db.getAll("outbox")) as QueueItem[]).sort(
        (a, b) =>
          Number(b.kind === "folders") - Number(a.kind === "folders") ||
          a.order - b.order,
      ),
    );
    for (const m of queue) {
      const references = new Set(
        [
          ...JSON.stringify(m.data.document || []).matchAll(
            /\/api\/images\/([a-f0-9-]{36})/g,
          ),
        ].map((match) => match[1]),
      );
      for (const id of references) {
        const image = (await db.get("images", id)) as LocalImage | undefined;
        if (image && !image.uploaded) {
          progress("Uploading images…");
          await api(`images/${image.id}`, {
            method: "PUT",
            headers: { "Content-Type": image.blob.type },
            body: image.blob,
          });
          await exclusive(async () => {
            await db.put("images", { ...image, uploaded: true });
          });
        }
      }
      progress("Saving changes…");
      const result = await (
        await api("sync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(m),
        })
      ).json();
      await exclusive(async () => {
        const key = `${m.kind}:${m.entityId}`;
        const tx = db.transaction(["records", "outbox"], "readwrite");
        const pending = (await tx.objectStore("outbox").get(key)) as
          QueueItem | undefined;
        const newer = pending && pending.id !== m.id;
        for (const row of result.rows as RecordRow[]) {
          const rowKey = `${row.kind}:${row.id}`;
          const queued = await tx.objectStore("outbox").get(rowKey);
          if (!queued || queued.id === m.id)
            await tx.objectStore("records").put({ ...row, key: rowKey });
        }
        if (newer) {
          const rows = result.rows as RecordRow[];
          const target =
            rows.find(
              (r) =>
                r.kind === m.kind &&
                r.data.conflictOf === m.entityId &&
                !r.deleted,
            ) || rows.find((r) => r.kind === m.kind && r.id === m.entityId);
          if (target && !target.deleted) {
            const nextKey = `${target.kind}:${target.id}`;
            const data = {
              ...pending.data,
              ...(target.id !== m.entityId ? { conflictOf: m.entityId } : {}),
              ...(m.kind === "notes"
                ? { currentSummaryId: target.data.currentSummaryId ?? null }
                : {}),
            };
            await tx.objectStore("outbox").delete(key);
            await tx.objectStore("outbox").put({
              ...pending,
              key: nextKey,
              entityId: target.id,
              baseRevision: target.revision,
              data,
            });
            await tx
              .objectStore("records")
              .put({ ...target, key: nextKey, data, deleted: pending.deleted });
            if (target.id !== m.entityId) {
              const original = rows.find((r) => r.id === m.entityId);
              if (original)
                await tx.objectStore("records").put({ ...original, key });
            }
          }
        } else await tx.objectStore("outbox").delete(key);
        await tx.done;
      });
    }
    let cursor = (await db.get("meta", "cursor")) || 0,
      more = true,
      total = 0;
    while (more) {
      const result = await (await api(`sync?cursor=${cursor}`)).json();
      for (const change of result.changes) {
        const row = change.payload;
        if (row.kind === "images") {
          if (!(await db.get("images", row.id))) {
            progress(`Downloading images and notes… ${++total}`);
            const blob = await (await api(`images/${row.id}`)).blob();
            await exclusive(async () => {
              await db.put("images", { id: row.id, blob, uploaded: true });
            });
          }
        } else
          await exclusive(async () => {
            const key = `${row.kind}:${row.id}`;
            const tx = db.transaction(["records", "outbox"], "readwrite");
            if (!(await tx.objectStore("outbox").get(key)))
              await tx.objectStore("records").put({ ...row, key });
            await tx.done;
          });
        await db.put("meta", change.seq, "cursor");
      }
      cursor = result.cursor;
      more = result.more;
    }
    await db.put("meta", new Date().toISOString(), "complete");
    notify();
  });
}
export async function generate(
  note: RecordRow,
  progress: (message: string) => void,
) {
  await sync(progress);
  const jobKey = `generation:${note.id}`;
  const job = await exclusive(async () => {
    const db = await database();
    if (await db.get("outbox", `notes:${note.id}`))
      throw new Error(
        "The note changed during sync. Sync and summarize again.",
      );
    const current = (await db.get("records", `notes:${note.id}`)) as RecordRow;
    const old = await db.get("meta", jobKey);
    const job = old
      ? old
      : {
          id: crypto.randomUUID(),
          noteId: note.id,
          revision: current.revision,
        };
    await db.put("meta", job, jobKey);
    return job;
  });
  let result: { rows: RecordRow[] };
  try {
    result = await (
      await api("summarize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(job),
      })
    ).json();
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes("Sync the note before summarizing")
    )
      await exclusive(async () => {
        await (await database()).delete("meta", jobKey);
      });
    throw error;
  }
  await exclusive(async () => {
    const db = await database();
    const tx = db.transaction(["records", "outbox", "meta"], "readwrite");
    for (const row of result.rows as RecordRow[]) {
      const key = `${row.kind}:${row.id}`;
      const existing = (await tx.objectStore("records").get(key)) as
        RecordRow | undefined;
      if (
        !(await tx.objectStore("outbox").get(key)) &&
        (!existing || row.revision >= existing.revision)
      )
        await tx.objectStore("records").put({ ...row, key });
    }
    await tx.objectStore("meta").delete(jobKey);
    await tx.done;
    notify();
  });
  if (await pending()) await sync(progress);
}
export async function settings() {
  return (
    (await records()).find((r) => r.kind === "settings" && !r.deleted)?.data ||
    defaults
  );
}
export async function clearLocal() {
  await exclusive(async () => {
    stopped = true;
    const id = owner;
    const db = await connection;
    db?.close();
    connection = null;
    localStorage.removeItem("aj-notes-owner");
    events?.postMessage("signout");
    if (id) await deleteDB(`aj-notes-${id}`);
    for (const url of urls.values()) URL.revokeObjectURL(url);
    urls.clear();
    for (const key of await caches.keys())
      if (key.startsWith("aj-notes")) await caches.delete(key);
  });
}
export { SETTINGS_ID };
