# AJ Notes

Private, offline-capable notes for AJ Series. Next.js / React / BlockNote / Auth.js / Drizzle / PostgreSQL. A separate application and database; Journal and Health data are not shared.

## Development

Use Node 24. Run `npm ci`, copy `.env.sample` to `.env`, and fill the string values in `APP_CONFIG`. Generate a unique `AUTH_SECRET` with `openssl rand -base64 32`. Set `ALLOWED_EMAIL` to your Google account. Register `http://localhost:3003/api/auth/callback/google` on your Google OAuth client. No demo login bypass is provided.

Create an empty PostgreSQL database named `aj_notes_local`, set its local connection URL, run `npm run db:migrate`, then `npm run dev`. The app opens on http://localhost:3003. Migrations have an advisory lock and checksum ledger; they never replace another app's database. Runtime access uses postgres-js; `lib/schema.ts` defines the corresponding Drizzle tables.

`APP_CONFIG` is a server-only JSON object of strings, matching Journal. Hosting-provided `APP_CONFIG` takes precedence over the local file. Do not put secrets in `NEXT_PUBLIC_` variables. Settings persist the OpenRouter model and summary instructions, never the API key.

## Existing AJ Docker environment

1. Configure `aj-notes/.env` with its Google and OpenRouter settings.
2. From `aj-app-launcher`, run `node scripts/prepare-local-docker.mjs <owner-email>`. This prepares ignored `.local/notes.env` with the independent local database and port 3003. It does not create databases or alter source environment files.
3. Create `aj_notes_local` on the existing PostgreSQL container using your database administrator. Leave Health and Journal databases and volumes intact.
4. Run `docker compose -f compose.local.yaml --profile notes build notes`.
5. Run `docker compose -f compose.local.yaml --profile notes run --rm notes npm run db:migrate`.
6. Run `docker compose -f compose.local.yaml --profile notes up -d notes`. Recreate the launcher after registry environment changes.

The optional `notes` profile keeps existing Docker startup working before Notes credentials are configured. Docker is local-only. Never remove database volumes to repair app dependencies.

## Editing and offline behavior

Use slash commands or the toolbar for headings, lists, checklists, tables, quotes, code, images, and Mermaid. Image uploads up to 25 MB are accepted. Static images over 1 MB are compressed in the browser, with a maximum 2560-pixel edge, before local storage and upload; stored attachments stay within 4 MB. Smaller images are kept unchanged. GIFs retain animation and must fit within 4 MB. Rich document JSON is limited to 800 KB per original or summary; image bytes do not count toward that limit. Incremental sync responses are paginated by byte size as well as record count. SVG uploads are excluded; Mermaid renders into isolated image documents. The image Embed tab imports public HTTPS image URLs into local attachments, so embedded images sync and reopen offline. The authenticated importer avoids browser CORS restrictions, restricts requests to public addresses, and revalidates redirects. Mixed HTML paste uses the same import/compression path; unavailable images become an upload instruction. Sources requiring sign-in or blocking downloads must be uploaded instead.

Edits and images are persisted to owner-scoped IndexedDB before network writes. A public shell and assets are cached by the service worker. Notes, summary history, and images download automatically; offline availability is reported only after sync finishes. Browser storage can be refused or evicted. Complete the first online sign-in and sync before relying on offline access. Use current browsers supporting Web Locks and IndexedDB.

Sync runs on opening, focus, reconnect, and every 20 seconds while open. It uploads images first, then an ordered, coalesced mutation outbox, and pulls incremental changes. Mutation receipts protect retries. Server transactions serialize by owner, avoiding cursor gaps from out-of-order commits. Conflicting edits to live notes keep the same ID: the last synced edit is shown, and displaced content is available under “Saved versions from other devices” for review and restoration. Existing conflict copies remain available. Folder and summary conflicts create a labeled copy; an edit-versus-delete conflict preserves the newer server content in a copy before deletion. Compare copies and keep or delete them explicitly. There is no automatic merge or real-time collaboration.

Explicit sign-out clears local private data, local images, and app caches. Unsynced changes trigger a warning. Session expiry stops sync until sign-in; previously downloaded data remains accessible offline on that device.

## AI and summary history

Summarize waits for source sync and sends only written content and Mermaid source to OpenRouter. Images are excluded. Each generation saves its source snapshot, revision, model, and instructions. The default is an overview plus key bullets in the source language. The latest summary is editable; previous versions are read-only and individually deletable after confirmation. Regeneration retains outgoing edits. Changes to the source show an outdated indicator. Errors retain all existing content. Generation is explicit and requires connectivity. Notes above 120,000 extracted characters must be shortened before summarizing.

## Deployment and operations

Deploy this folder as a separate Vercel project. Provision a dedicated Neon database, configure server `APP_CONFIG`, set `AUTH_URL` to the actual HTTPS origin, register its Google callback, and run migrations against that database before starting the app. Set `NEXT_PUBLIC_AJ_REGISTRY_URL` at build time to the AJ launcher's `/apps.json` endpoint. Allow a 60-second server function duration; AI fetches time out at 45 seconds.

The production registry template includes Notes with `url: null` and `status: unverified`. Update the actual launcher registry only after testing the real deployment. No remote repository, production service, domain, OAuth client, or paid AI resource is provisioned by this source.

Back up the entire Notes PostgreSQL database, including image bytes, with `pg_dump`; verify restoration into a separate database before trusting a backup. No scheduled cleanup is included. Tombstones, receipts, source snapshots, and unreferenced images are retained to protect stale clients; account for their database size. Never log note bodies, prompts, credentials, or AI response bodies. Provider failures surface status codes without exposing raw provider errors.

## Checks

Production builds also emit `public/offline-assets.json` so all browser chunks, including lazy Mermaid diagram modules, are downloaded before offline readiness is reported. Run the full `npm run build` command when preparing a production preview.

The lockfile overrides transitive UUID and KaTeX packages to patched versions while retaining the tested editor APIs.

`npm test`, `npm run typecheck`, `npm run build`. See `VALIDATION.md` for device, integration, and offline acceptance checks. No Markdown import/export is included.

Folder management uses custom dialogs for naming folders and notes. Expand a folder to see its notes. Drag notes from the list or an expanded folder onto another folder or Unfiled; use a note’s Add to folder button or the editor’s folder selector when preferred. Deleting a folder keeps its notes in Unfiled by default. Select “Also delete notes in this folder and their summaries” in the confirmation dialog to remove its contents too. These choices work offline and sync when reconnected.
