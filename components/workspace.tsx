"use client";
import { useEffect, useState, useRef, useCallback } from "react";
import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";
import { ActionIcon } from "./action-icon";
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
    action: () => void | Promise<void>;
  } | null>(null);
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
  async function createNote() {
    await run(async () => {
      const id = crypto.randomUUID();
      await local.save("notes", id, {
        title: "Untitled",
        folderId: folder === "all" || folder === "unfiled" ? null : folder,
        document: [],
        schemaVersion: 1,
        currentSummaryId: null,
      });
      setActive(id);
      setTab("original");
      setHistory(null);
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
            className={folder === "unfiled" ? "selected" : ""}
            onClick={() => setFolder("unfiled")}
          >
            Unfiled
          </button>
          <div className="section-label">
            FOLDERS{" "}
            <button
              aria-label="New folder"
              onClick={() => {
                const name = prompt("Folder name");
                if (name?.trim())
                  void run(() =>
                    local.save("folders", crypto.randomUUID(), {
                      title: name.trim(),
                    }),
                  );
              }}
            >
              ＋
            </button>
          </div>
          {folders.map((f) => (
            <div className="folder" key={f.id}>
              <button
                className={folder === f.id ? "selected" : ""}
                onClick={() => setFolder(f.id)}
              >
                ▱ {f.data.title}
              </button>
              <button
                aria-label={`Rename ${f.data.title}`}
                onClick={() => {
                  const name = prompt("Rename folder", f.data.title);
                  if (name?.trim()) edit(f, { title: name.trim() });
                }}
              >
                ✎
              </button>
              <button
                aria-label={`Delete ${f.data.title}`}
                title={`Delete ${f.data.title}`}
                className="danger"
                onClick={() => {
                  setConfirmation({
                    title: "Delete folder?",
                    message: `“${f.data.title}” will be deleted. Its notes will move to Unfiled.`,
                    label: "Delete",
                    action: () => {
                      edit(f, f.data, true);
                      setFolder("all");
                    },
                  });
                }}
              >
                <TrashIcon />
              </button>
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
                onChange={(e) =>
                  edit(note, { ...note.data, folderId: e.target.value || null })
                }
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
