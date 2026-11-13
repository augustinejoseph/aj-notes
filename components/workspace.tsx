"use client";
import { useEffect, useState, useRef, useCallback } from "react";
import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";
import { ActionIcon } from "./action-icon";
import { InputDialog } from "./input-dialog";
import type { ComponentProps, DragEvent } from "react";
import { ConfirmDialog } from "./confirm-dialog";
import { signIn, signOut } from "next-auth/react";
import { AppLauncher } from "@ajoseph/app-launcher";
import * as local from "@/lib/local";
import { TrashIcon } from "./trash-icon";
import { prepareOfflineShell } from "@/lib/offline-shell";
import { defaults, plainText, type RecordRow, type Data } from "@/lib/model";
const Editor = dynamic(() => import("./editor"), {
  ssr: false,
  loading: () => <p>Opening editor…</p>,
});
export default function Workspace() {
  const [ready, setReady] = useState(false),
    [login, setLogin] = useState(false),
    [rows, setRows] = useState<RecordRow[]>([]),
    [folder, setFolder] = useState("all"),
    [search, setSearch] = useState(""),
    [tab, setTab] = useState<"original" | "summary">("original"),
    [history, setHistory] = useState<string | null>(null),
    [status, setStatus] = useState("Opening your notes…"),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [count, setCount] = useState(0);
  const pathname = usePathname();
  const active = pathname.startsWith("/notes/") ? pathname.split("/")[2] : null;
  const showSettings = pathname === "/settings";
  const lastNote = useRef<string | null>(null);
  const [confirmation, setConfirmation] = useState<{
    title: string;
    message: string;
    label: string;
    action: (checked: boolean) => void | Promise<void>;
    checkboxLabel?: string;
  } | null>(null);
  const [inputDialog, setInputDialog] = useState<Omit<
    ComponentProps<typeof InputDialog>,
    "close"
  > | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  function moveNote(row: RecordRow, folderId: string | null) {
    const data = latest.current.get(row.id) || row.data;
    if (data.folderId === folderId) return;
    edit(row, { ...data, folderId });
    if (folderId) setExpanded((old) => new Set([...old, folderId]));
  }
  function dragNote(e: DragEvent, id: string) {
    e.dataTransfer.setData("application/x-aj-note", id);
    e.dataTransfer.effectAllowed = "move";
  }
  function dropProps(id: string) {
    return {
      onDragOver: (e: DragEvent) => {
        if (!e.dataTransfer.types.includes("application/x-aj-note")) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        setDropTarget(id);
      },
      onDragLeave: (e: DragEvent) => {
        if (
          !(e.relatedTarget instanceof Node) ||
          !e.currentTarget.contains(e.relatedTarget)
        )
          setDropTarget(null);
      },
      onDrop: (e: DragEvent) => {
        e.preventDefault();
        setDropTarget(null);
        const row = notes.find(
          (n) => n.id === e.dataTransfer.getData("application/x-aj-note"),
        );
        if (row) moveNote(row, id === "unfiled" ? null : id);
      },
    };
  }
  function askMove(row: RecordRow) {
    setInputDialog({
      title: "Add to folder",
      label: "Folder",
      initialValue: row.data.folderId || "",
      options: [
        { value: "", label: "Unfiled" },
        ...folders.map((f) => ({
          value: f.id,
          label: f.data.title || "Untitled",
        })),
      ],
      action: async (value) => {
        moveNote(row, value || null);
        await writes.current;
      },
    });
  }
  function navigate(path: string) {
    window.history.pushState(null, "", path);
  }
  function setActive(id: string | null) {
    navigate(id ? `/notes/${id}` : "/");
  }
  function closeSettings() {
    navigate(lastNote.current ? `/notes/${lastNote.current}` : "/");
  }
  useEffect(() => {
    if (active) lastNote.current = active;
  }, [active]);
  const shellReady = useRef(false);
  const syncing = useRef(false),
    alive = useRef(true),
    writes = useRef(Promise.resolve()),
    latest = useRef(new Map<string, Data>());
  const reload = useCallback(async () => {
    try {
      await writes.current;
      const stored = await local.records();
      latest.current = new Map(stored.map((row) => [row.id, row.data]));
      setRows(stored);
      setCount(await local.pending());
    } catch (e) {
      setError(String(e));
    }
  }, []);
  const doSync = useCallback(async () => {
    if (syncing.current) return;
    syncing.current = true;
    setStatus("Syncing…");
    try {
      await writes.current;
      if (!shellReady.current) {
        await prepareOfflineShell();
        shellReady.current = true;
      }
      await local.sync(setStatus);
      setStatus(
        (await local.pending()) > 0
          ? "Saved locally · more changes awaiting sync"
          : shellReady.current
            ? "All notes and images available offline"
            : "Notes synced · preparing offline editor…",
      );
      setError("");
    } catch (e) {
      setStatus(
        navigator.onLine
          ? "Sync needs attention"
          : "Offline · editing on this device",
      );
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      syncing.current = false;
      await reload();
    }
  }, [reload]);
  useEffect(() => {
    alive.current = true;
    const change = () => {
      void reload();
    };
    const signedOut = () => {
      setRows([]);
      setReady(false);
      setLogin(true);
      setStatus("Signed out");
    };
    window.addEventListener("notes-change", change);
    window.addEventListener("notes-signout", signedOut);
    void (async () => {
      try {
        let owner: string | null = null;
        try {
          const res = await fetch("/api/identity", {
            cache: "no-store",
            signal: AbortSignal.timeout(10000),
          });
          if (res.ok) owner = (await res.json()).owner;
          else if (res.status === 401) {
            setLogin(true);
            setStatus("Sign in to open your notes");
            return;
          } else throw new Error("Identity service unavailable");
        } catch {
          owner = localStorage.getItem("aj-notes-owner");
          if (!owner) {
            setLogin(true);
            setStatus("Connect and sign in to get started");
            return;
          }
        }
        await local.initialize(owner!);
        if (!alive.current) return;
        await reload();
        if (!alive.current) return;
        setReady(true);
        void doSync();
        void navigator.storage?.persist?.();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      alive.current = false;
      window.removeEventListener("notes-change", change);
      window.removeEventListener("notes-signout", signedOut);
    };
  }, [reload, doSync]);
  useEffect(() => {
    if (!ready) return;
    const refresh = () => {
      void doSync();
    };
    window.addEventListener("online", refresh);
    window.addEventListener("focus", refresh);
    const timer = setInterval(refresh, 20000);
    return () => {
      clearInterval(timer);
      window.removeEventListener("online", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [ready, doSync]);
  const notes = rows.filter((r) => r.kind === "notes" && !r.deleted),
    folders = rows.filter((r) => r.kind === "folders" && !r.deleted);
  const note = notes.find((r) => r.id === active);
  const versions = rows
    .filter(
      (r) => r.kind === "summaries" && !r.deleted && r.data.noteId === active,
    )
    .sort((a, b) =>
      String(b.data.createdAt).localeCompare(String(a.data.createdAt)),
    );
  const summary = versions.find(
    (r) => r.id === (history || note?.data.currentSummaryId),
  );
  const settings =
    rows.find((r) => r.kind === "settings" && !r.deleted)?.data || defaults;
  const filtered = notes.filter(
    (n) =>
      (folder === "all" ||
        (folder === "unfiled"
          ? !n.data.folderId || !folders.some((f) => f.id === n.data.folderId)
          : n.data.folderId === folder)) &&
      `${n.data.title}\n${plainText(n.data.document)}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  function edit(row: RecordRow, data: Data, deleted = false) {
    latest.current.set(row.id, data);
    setRows((old) =>
      old.map((r) => (r.id === row.id ? { ...r, data, deleted } : r)),
    );
    setStatus("Saving on this device…");
    writes.current = writes.current
      .catch(() => {})
      .then(() => local.save(row.kind, row.id, data, deleted, row.revision))
      .then(() => {
        setStatus(
          navigator.onLine
            ? "Saved on this device · awaiting sync"
            : "Saved on this device · offline",
        );
      })
      .catch((e) => {
        setError(
          `Could not save on this device: ${String(e)}. Keep this tab open and copy your latest changes.`,
        );
        throw e;
      });
    void writes.current.catch(() => {});
  }
  async function run(fn: () => Promise<void>) {
    try {
      setError("");
      await writes.current;
      await fn();
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  function createNote() {
    const folderId = folder === "all" || folder === "unfiled" ? null : folder;
    setInputDialog({
      title: "New note",
      label: "Note name",
      maxLength: 500,
      action: async (title) => {
        await writes.current;
        const id = crypto.randomUUID();
        await local.save("notes", id, {
          title,
          folderId,
          document: [],
          schemaVersion: 1,
          currentSummaryId: null,
        });
        await reload();
        setStatus("Saved on this device · awaiting sync");
        setActive(id);
        setTab("original");
        setHistory(null);
        if (folderId) setExpanded((old) => new Set([...old, folderId]));
      },
    });
  }
  async function summarize() {
    if (!note) return;
    setBusy(true);
    await run(async () => {
      await local.generate(note, setStatus);
      setTab("summary");
      setHistory(null);
      setStatus("Summary saved");
    });
    setBusy(false);
  }
  function deleteNote(row: RecordRow) {
    setConfirmation({
      title: "Delete note?",
      message: `“${row.data.title || "Untitled"}” and all its summaries will be deleted.`,
      label: "Delete",
      action: () => {
        edit(row, latest.current.get(row.id) || row.data, true);
        if (active === row.id) {
          lastNote.current = null;
          setActive(null);
        }
      },
    });
  }
  function logout() {
    setConfirmation({
      title: "Sign out?",
      message: count
        ? "Unsynced changes will be removed from this device."
        : "This device’s local copy will be removed.",
      label: "Sign out",
      action: () =>
        run(async () => {
          await local.clearLocal();
          await signOut({ callbackUrl: "/" });
        }),
    });
  }
  if (!ready)
    return (
      <main className="login">
        <div className="wordmark">AJ Notes</div>
        <section>
          {login && (
            <button className="primary" onClick={() => void signIn("google")}>
              Continue with Google →
            </button>
          )}
          <p role="status">{status}</p>
          {error && <p role="alert">{error}</p>}
        </section>
      </main>
    );
  return (
    <div className="shell">
      <header className="workspace-header">
        <a
          className="header-brand"
          href="/"
          onClick={(e) => {
            e.preventDefault();
            setActive(null);
          }}
        >
          Notes
        </a>
        <div
          className="workspace-tools"
          role="group"
          aria-label="Workspace actions"
        >
          <button
            aria-label="Sync"
            title={count ? `Sync (${count} pending)` : "Sync"}
            onClick={() => void doSync()}
            disabled={busy}
          >
            <ActionIcon name="sync" />
          </button>
          <button
            aria-label="Settings"
            title="Settings"
            onClick={() => navigate("/settings")}
          >
            <ActionIcon name="settings" />
          </button>
          <button
            aria-label="Sign out"
            title="Sign out"
            onClick={() => void logout()}
          >
            <ActionIcon name="logout" />
          </button>
          <AppLauncher
            currentApp="notes"
            iconOnly
            registryUrl={process.env.NEXT_PUBLIC_AJ_REGISTRY_URL || undefined}
            allowLocalhost={
              process.env.NODE_ENV === "development" &&
              process.env.NEXT_PUBLIC_AJ_LOCAL_DEVELOPMENT === "true"
            }
          />
        </div>
      </header>
      <aside className="sidebar">
        <button className="primary" onClick={() => void createNote()}>
          ＋ New note
        </button>
        <label className="search">
          <input
            aria-label="Search notes"
            placeholder="Search notes"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <nav aria-label="Folders">
          <button
            className={folder === "all" ? "selected" : ""}
            onClick={() => setFolder("all")}
          >
            All notes <span>{notes.length}</span>
          </button>
          <button
            className={`${folder === "unfiled" ? "selected" : ""} ${dropTarget === "unfiled" ? "drop-target" : ""}`}
            {...dropProps("unfiled")}
            onClick={() => setFolder("unfiled")}
          >
            Unfiled
          </button>
          <div className="section-label">
            FOLDERS{" "}
            <button
              aria-label="New folder"
              onClick={() =>
                setInputDialog({
                  title: "New folder",
                  label: "Folder name",
                  maxLength: 200,
                  action: async (title) => {
                    await writes.current;
                    const id = crypto.randomUUID();
                    await local.save("folders", id, { title });
                    await reload();
                    setStatus("Saved on this device · awaiting sync");
                    setExpanded((old) => new Set([...old, id]));
                  },
                })
              }
            >
              ＋
            </button>
          </div>
          {folders.map((f) => (
            <div
              className={`folder-group ${dropTarget === f.id ? "drop-target" : ""}`}
              key={f.id}
              {...dropProps(f.id)}
            >
              <div className="folder">
                <button
                  className="folder-toggle"
                  aria-label={`${expanded.has(f.id) ? "Collapse" : "Expand"} ${f.data.title}`}
                  aria-expanded={expanded.has(f.id)}
                  aria-controls={`folder-${f.id}`}
                  onClick={() =>
                    setExpanded((old) => {
                      const next = new Set(old);
                      if (next.has(f.id)) next.delete(f.id);
                      else next.add(f.id);
                      return next;
                    })
                  }
                >
                  {expanded.has(f.id) ? "▾" : "▸"}
                </button>
                <button
                  className={`folder-name ${folder === f.id ? "selected" : ""}`}
                  onClick={() => setFolder(f.id)}
                >
                  ▱ {f.data.title}
                </button>
                <button
                  aria-label={`Rename ${f.data.title}`}
                  onClick={() =>
                    setInputDialog({
                      title: "Rename folder",
                      label: "Folder name",
                      initialValue: f.data.title,
                      maxLength: 200,
                      action: async (title) => {
                        edit(f, { title });
                        await writes.current;
                      },
                    })
                  }
                >
                  ✎
                </button>
                <button
                  aria-label={`Delete ${f.data.title}`}
                  title={`Delete ${f.data.title}`}
                  className="danger"
                  onClick={() =>
                    setConfirmation({
                      title: "Delete folder?",
                      message: `Delete “${f.data.title}”? Notes will move to Unfiled unless you choose to delete them too.`,
                      label: "Delete",
                      checkboxLabel:
                        "Also delete notes in this folder and their summaries",
                      action: async (deleteNotes) => {
                        await writes.current;
                        await local.removeFolder(f.id, deleteNotes);
                        await reload();
                        setStatus("Saved on this device · awaiting sync");
                        if (folder === f.id) setFolder("all");
                        if (
                          deleteNotes &&
                          notes.some(
                            (n) => n.id === active && n.data.folderId === f.id,
                          )
                        ) {
                          lastNote.current = null;
                          setActive(null);
                        }
                      },
                    })
                  }
                >
                  <TrashIcon />
                </button>
              </div>
              <div
                id={`folder-${f.id}`}
                className="folder-notes"
                hidden={!expanded.has(f.id)}
              >
                {notes
                  .filter((n) => n.data.folderId === f.id)
                  .map((n) => (
                    <button
                      key={n.id}
                      className={active === n.id ? "selected" : ""}
                      draggable
                      onDragStart={(e) => dragNote(e, n.id)}
                      onDragEnd={() => setDropTarget(null)}
                      onClick={() => {
                        setActive(n.id);
                        setTab("original");
                        setHistory(null);
                      }}
                    >
                      {n.data.title || "Untitled"}
                    </button>
                  ))}
                {!notes.some((n) => n.data.folderId === f.id) && (
                  <small>No notes. Drop a note here.</small>
                )}
              </div>
            </div>
          ))}
        </nav>
      </aside>
      <section className="note-list">
        <div className="list-heading">
          <h2>
            {folder === "all"
              ? "All notes"
              : folder === "unfiled"
                ? "Unfiled"
                : folders.find((f) => f.id === folder)?.data.title}
          </h2>
        </div>
        {filtered.length ? (
          filtered.map((n) => (
            <div
              key={n.id}
              className={`note-row ${n.id === active ? "selected" : ""}`}
              draggable
              onDragStart={(e) => dragNote(e, n.id)}
              onDragEnd={() => setDropTarget(null)}
            >
              <button
                className="note-item"
                onClick={() => {
                  setActive(n.id);
                  setTab("original");
                  setHistory(null);
                }}
              >
                <strong>{n.data.title || "Untitled"}</strong>
                <p>{plainText(n.data.document).slice(0, 100)}</p>
                {n.data.conflictOf && (
                  <small>Conflict copy · compare with original</small>
                )}
              </button>
              <button
                className="note-move"
                aria-label={`Add ${n.data.title || "Untitled"} to folder`}
                title="Add to folder"
                onClick={() => askMove(n)}
              >
                ▱
              </button>
              <button
                className="danger note-delete"
                aria-label={`Delete ${n.data.title || "Untitled"}`}
                title="Delete note"
                onClick={() => deleteNote(n)}
              >
                <TrashIcon />
              </button>
            </div>
          ))
        ) : (
          <p className="empty-list">No notes here yet.</p>
        )}
      </section>
      <main className="main">
        <div className="sync-status" role="status">
          {status}
        </div>
        {error && (
          <div className="notice" role="alert">
            {error}{" "}
            <button onClick={() => void signIn("google")}>Sign in</button>
            <button aria-label="Dismiss error" onClick={() => setError("")}>
              ×
            </button>
          </div>
        )}
        {showSettings ? (
          <Settings
            data={settings}
            close={closeSettings}
            save={(data) => {
              const row = rows.find((r) => r.kind === "settings") || {
                id: local.SETTINGS_ID,
                kind: "settings" as const,
                revision: 0,
                deleted: false,
                data: {},
              };
              if (!rows.includes(row)) setRows((old) => [...old, row]);
              edit(row, data);
              closeSettings();
            }}
          />
        ) : note ? (
          <article className="document">
            <div className="document-top">
              <select
                aria-label="Move note to folder"
                value={note.data.folderId || ""}
                onChange={(e) => moveNote(note, e.target.value || null)}
              >
                <option value="">Unfiled</option>
                {folders.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.data.title}
                  </option>
                ))}
              </select>
              <button
                className="primary"
                disabled={busy}
                onClick={() => void summarize()}
              >
                {busy ? "Summarizing…" : "✧ Summarize"}
              </button>
              <button
                className="danger"
                aria-label="Delete note"
                title="Delete note"
                onClick={() => deleteNote(note)}
              >
                <TrashIcon />
              </button>
            </div>
            <input
              className="title"
              maxLength={500}
              aria-label="Note title"
              value={note.data.title || ""}
              placeholder="Untitled"
              onChange={(e) =>
                edit(note, {
                  ...(latest.current.get(note.id) || note.data),
                  title: e.target.value,
                })
              }
            />
            {!!note.data.conflictVersions?.length && (
              <details className="notice">
                <summary>
                  Saved versions from other devices (
                  {note.data.conflictVersions.length})
                </summary>
                <p>
                  The last synced edit is shown. Previous conflicting edits are
                  saved here.
                </p>
                {note.data.conflictVersions.map((version) => (
                  <details key={version.revision}>
                    <summary>
                      {version.title || "Untitled"} · revision{" "}
                      {version.revision}
                    </summary>
                    <pre style={{ whiteSpace: "pre-wrap" }}>
                      {plainText(version.document)}
                    </pre>
                    <button
                      onClick={() => {
                        const current =
                          latest.current.get(note.id) || note.data;
                        edit(note, {
                          ...current,
                          title: version.title,
                          folderId: version.folderId,
                          document: version.document,
                          restoreConflictRevision: version.revision,
                        });
                      }}
                    >
                      Restore this version
                    </button>
                  </details>
                ))}
              </details>
            )}
            {note.data.conflictOf && (
              <div className="notice">
                This copy preserves conflicting edits.{" "}
                <button
                  onClick={() => {
                    setActive(note.data.conflictOf!);
                    setTab("original");
                    setHistory(null);
                  }}
                >
                  View original
                </button>
                <button
                  onClick={() =>
                    edit(note, { ...note.data, conflictOf: undefined })
                  }
                >
                  Keep this copy
                </button>
              </div>
            )}
            <div className="tabs" role="tablist" aria-label="Note versions">
              <button
                role="tab"
                aria-selected={tab === "original"}
                onClick={() => setTab("original")}
              >
                Original
              </button>
              <button
                role="tab"
                aria-selected={tab === "summary"}
                onClick={() => {
                  setTab("summary");
                  setHistory(null);
                }}
              >
                Summary
              </button>
            </div>
            {tab === "original" ? (
              <Editor
                key={`original:${note.id}:${note.revision}`}
                document={note.data.document || []}
                onChange={(document) =>
                  edit(note, {
                    ...(latest.current.get(note.id) || note.data),
                    document,
                  })
                }
                onError={setError}
              />
            ) : (
              <>
                <div className="summary-controls">
                  <label>
                    Version{" "}
                    <select
                      value={history || "current"}
                      onChange={(e) =>
                        setHistory(
                          e.target.value === "current" ? null : e.target.value,
                        )
                      }
                    >
                      <option value="current">Current summary</option>
                      {versions
                        .filter((s) => s.id !== note.data.currentSummaryId)
                        .map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.data.conflictOf ? "Conflict copy · " : ""}
                            {new Date(
                              String(s.data.createdAt),
                            ).toLocaleString()}
                          </option>
                        ))}
                    </select>
                  </label>
                  {summary && (
                    <button
                      className="danger"
                      aria-label="Delete summary version"
                      title="Delete summary version"
                      onClick={() => {
                        setConfirmation({
                          title: "Delete summary?",
                          message:
                            "This summary version will be deleted. Other versions will be kept.",
                          label: "Delete",
                          action: () => {
                            edit(summary, summary.data, true);
                            setHistory(null);
                          },
                        });
                      }}
                    >
                      <TrashIcon />
                    </button>
                  )}
                </div>
                {summary ? (
                  <>
                    {JSON.stringify(summary.data.sourceSnapshot) !==
                      JSON.stringify(note.data.document) && (
                      <p className="notice">
                        The original has changed since this summary was
                        generated.
                      </p>
                    )}
                    {history && (
                      <p className="muted">Previous version · read only</p>
                    )}
                    <Editor
                      key={`summary:${summary.id}:${summary.revision}`}
                      document={summary.data.document || []}
                      readOnly={Boolean(history)}
                      onChange={(document) => {
                        if (!history)
                          edit(summary, {
                            ...(latest.current.get(summary.id) || summary.data),
                            document,
                          });
                      }}
                      onError={setError}
                    />
                    <details>
                      <summary>Generation details and source</summary>
                      <p>Model: {summary.data.model}</p>
                      <p>{summary.data.instructions}</p>
                      <pre>{plainText(summary.data.sourceSnapshot)}</pre>
                    </details>
                  </>
                ) : (
                  <div className="empty">
                    <p>No summary</p>
                  </div>
                )}
              </>
            )}
          </article>
        ) : (
          <div className="empty welcome">
            <h1>{active ? "Note not found" : "Notes"}</h1>
            <button className="primary" onClick={() => void createNote()}>
              ＋ Write a note
            </button>
          </div>
        )}
      </main>
      {inputDialog && (
        <InputDialog {...inputDialog} close={() => setInputDialog(null)} />
      )}
      {confirmation && (
        <ConfirmDialog {...confirmation} close={() => setConfirmation(null)} />
      )}
    </div>
  );
}
function Settings({
  data,
  close,
  save,
}: {
  data: Data;
  close: () => void;
  save: (data: Data) => void;
}) {
  const [model, setModel] = useState(String(data.model)),
    [instructions, setInstructions] = useState(String(data.instructions));
  return (
    <section className="settings-page" aria-labelledby="settings-title">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save({ model: model.trim(), instructions: instructions.trim() });
        }}
      >
        <div className="dialog-top">
          <h2 id="settings-title">Settings</h2>
          <button type="button" aria-label="Close settings" onClick={close}>
            ×
          </button>
        </div>
        {data.conflictingSettings &&
        typeof data.conflictingSettings === "object" ? (
          <div className="notice">
            Conflicting preferences were kept as a draft.{" "}
            <button
              type="button"
              onClick={() => {
                const draft = data.conflictingSettings as Data;
                setModel(String(draft.model));
                setInstructions(String(draft.instructions));
              }}
            >
              Use saved draft
            </button>
          </div>
        ) : null}
        <label htmlFor="model">OpenRouter model</label>
        <input
          id="model"
          required
          maxLength={200}
          value={model}
          onChange={(e) => setModel(e.target.value)}
        />
        <label htmlFor="instructions">Summary instructions</label>
        <textarea
          id="instructions"
          required
          rows={9}
          maxLength={10000}
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
        />
        <button className="primary">Save settings</button>
      </form>
    </section>
  );
}
