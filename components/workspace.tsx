"use client";
import { useEffect, useState, useRef, useCallback } from "react";
import dynamic from "next/dynamic";
import { signIn, signOut } from "next-auth/react";
import { AppLauncher } from "@ajoseph/app-launcher";
import * as local from "@/lib/local";
import { TrashIcon } from "./trash-icon";
import { prepareOfflineShell } from "@/lib/offline-shell";
import {
  defaults,
  plainText,
  type RecordRow,
  type Data,
  type Block,
} from "@/lib/model";
const Editor = dynamic(() => import("./editor"), {
  ssr: false,
  loading: () => <p>Opening editor…</p>,
});
export default function Workspace() {
  const [ready, setReady] = useState(false),
    [login, setLogin] = useState(false),
    [rows, setRows] = useState<RecordRow[]>([]),
    [active, setActive] = useState<string | null>(null),
    [folder, setFolder] = useState("all"),
    [search, setSearch] = useState(""),
    [tab, setTab] = useState<"original" | "summary">("original"),
    [history, setHistory] = useState<string | null>(null),
    [showSettings, setShowSettings] = useState(false),
    [status, setStatus] = useState("Opening your notes…"),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [count, setCount] = useState(0);
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
        setReady(true);
        await reload();
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
  async function logout() {
    if (
      count &&
      !confirm(
        "There are unsynced changes. Signing out removes this device’s local copy. Sign out anyway?",
      )
    )
      return;
    await run(async () => {
      await local.clearLocal();
      await signOut({ callbackUrl: "/" });
    });
  }
  if (!ready)
    return (
      <main className="login">
        <div className="wordmark">
          AJ Notes<span>A PRIVATE HOME FOR YOUR IDEAS</span>
        </div>
        <section>
          <p className="eyebrow">THINK. WRITE. KEEP.</p>
          <h1>
            A little room
            <br />
            for everything.
          </h1>
          <p>Your notes, diagrams, and ideas. Always close at hand.</p>
          {login && (
            <button className="primary" onClick={() => void signIn("google")}>
              Continue with Google →
            </button>
          )}
          <p role="status">{status}</p>
          {error && <p role="alert">{error}</p>}
        </section>
        <small>Private by design · AJ Series</small>
      </main>
    );
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="wordmark">
            Notes<span>AJ SERIES / YOUR WORKSPACE</span>
          </div>
          <AppLauncher
            currentApp="notes"
            registryUrl={process.env.NEXT_PUBLIC_AJ_REGISTRY_URL || undefined}
            allowLocalhost={
              process.env.NODE_ENV === "development" &&
              process.env.NEXT_PUBLIC_AJ_LOCAL_DEVELOPMENT === "true"
            }
          />
        </div>
        <button className="primary" onClick={() => void createNote()}>
          ＋ New note
        </button>
        <label className="search">
          Search notes
          <input
            placeholder="Find an idea…"
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
                  if (
                    confirm(
                      "Delete this folder? Its notes will move to Unfiled.",
                    )
                  ) {
                    edit(f, f.data, true);
                    setFolder("all");
                  }
                }}
              >
                <TrashIcon />
              </button>
            </div>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <button onClick={() => setShowSettings(true)}>⚙ Settings</button>
          <button onClick={() => void logout()}>Sign out</button>
        </div>
      </aside>
      <section className="note-list">
        <div className="list-heading">
          <p className="eyebrow">YOUR COLLECTION</p>
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
            <button
              key={n.id}
              className={`note-item ${n.id === active ? "selected" : ""}`}
              onClick={() => {
                setActive(n.id);
                setTab("original");
                setHistory(null);
              }}
            >
              <strong>{n.data.title || "Untitled"}</strong>
              <p>
                {plainText(n.data.document).slice(0, 100) ||
                  "A fresh page, ready for an idea."}
              </p>
              {n.data.conflictOf && (
                <small>Conflict copy · compare with original</small>
              )}
            </button>
          ))
        ) : (
          <p className="empty-list">No notes here yet.</p>
        )}
      </section>
      <main className="main">
        <header>
          <span className="eyebrow">YOUR PRIVATE WORKSPACE</span>
          <button onClick={() => void doSync()} disabled={busy}>
            ↻ Sync {count ? `(${count} pending)` : ""}
          </button>
        </header>
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
        {note ? (
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
                onClick={() => {
                  if (
                    confirm("Delete this note and all its summary versions?")
                  ) {
                    edit(note, note.data, true);
                    setActive(null);
                  }
                }}
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
                        if (
                          confirm(
                            "Delete this summary version? Other versions will be kept.",
                          )
                        ) {
                          edit(summary, summary.data, true);
                          setHistory(null);
                        }
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
                    <h2>A shorter way back to your ideas.</h2>
                    <p>
                      Use Summarize to create an editable summary. Your original
                      stays here.
                    </p>
                  </div>
                )}
              </>
            )}
          </article>
        ) : (
          <div className="empty welcome">
            <p className="eyebrow">MAKE SPACE FOR A THOUGHT</p>
            <h1>
              Every idea
              <br />
              starts somewhere.
            </h1>
            <p>Choose a note or begin with a fresh page.</p>
            <button className="primary" onClick={() => void createNote()}>
              ＋ Write a note
            </button>
          </div>
        )}
      </main>
      {showSettings && (
        <Settings
          data={settings}
          close={() => setShowSettings(false)}
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
            setShowSettings(false);
          }}
        />
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
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog ref={ref} onCancel={close} aria-labelledby="settings-title">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save({ model: model.trim(), instructions: instructions.trim() });
        }}
      >
        <div className="dialog-top">
          <h2 id="settings-title">Your preferences</h2>
          <button type="button" aria-label="Close settings" onClick={close}>
            ×
          </button>
        </div>
        <p className="muted">
          AI runs only when you choose Summarize. Your API key stays on the
          server.
        </p>
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
    </dialog>
  );
}
