# Acceptance checks

Automated checks cover document validation, summary text extraction, mutation conflicts, authenticated API boundaries, sync retry behavior, and PostgreSQL transactions where a test database is supplied.

Live integration requires owner credentials and an isolated test database. Do not use production notes as fixtures.

- Sign in as the verified owner; reject other accounts and unverified email. Check signed-out API/image access and cross-origin write rejection.
- Create folders and notes, rename/move/search them, and delete a populated folder. Verify notes move to Unfiled.
- Exercise slash commands, drag handles, formatting, code, tables, checklists, image upload/drop, and Mermaid preview/error handling. Paste a representative article with interleaved images; inspect ordering and unavailable-image placeholders.
- Finish automatic download, close the app, disable networking, and reopen. View every note and image, create/edit/delete notes, add images, and edit summaries. Reconnect and verify another device gets the same result.
- Edit one note independently on two offline devices. Verify both versions survive reconnect. Repeat with summary edits and edit-versus-delete. Resolve conflict copies through comparison and explicit deletion.
- Interrupt an upload or lose a sync response. Retry and verify no duplicated images, mutations, or summary generations. Exercise two tabs and verify outbox serialization.
- Generate an AI summary, edit it, regenerate, inspect history and saved source, and delete individual versions with confirmation. Verify outdated status after source edits. Fail AI with an invalid model or exhausted credits and verify content remains intact.
- Expire the auth session during offline work, reconnect, sign in again, and verify queued edits survive. Explicitly sign out and verify another tab and offline reopening no longer expose cached notes.
- Simulate IndexedDB quota/write failure. Verify pending errors are visible and offline readiness is not claimed. Test mobile layouts, tab/keyboard navigation, dialogs, screen-reader labels, and a physical device.

Record live Google, Neon, OpenRouter, and physical-device results separately from build/unit-test results.

## Automated integration and browser commands

The PostgreSQL integration suite runs only with `NOTES_TEST_DATABASE_URL=postgres://postgres:<test-password>@127.0.0.1:5544/aj_notes_test npm test`; it refuses other hosts, ports, and database names. Use a temporary PostgreSQL container, apply migrations to that empty database, and stop the container after testing.

For browser tests, install Playwright in your test tooling, start the production app on port 3003 after `npm run build`, then run `node scripts/browser-check.cjs`. `PLAYWRIGHT_MODULE` can point to an existing Playwright module and `NOTES_PREVIEW_URL` can override the local origin. Chrome must be installed. The script uses browser-only API fixtures and tests real editor, IndexedDB, service-worker, offline image/diagram, retry, in-flight-edit, Settings, and responsive behaviors; it does not validate Google or OpenRouter credentials.

## Verified on 2026-11-12

- Production build and TypeScript checks passed, including the offline asset manifest.
- All 23 Notes tests passed against an isolated PostgreSQL container; all 9 launcher registry tests passed. The temporary test database was stopped and removed after validation.
- Chrome browser checks passed against the production build with the real document validator and browser-only API fixtures: rich editing, mixed text/image paste, Mermaid rendered after offline reopening, manual summary edits, Settings, lost-response idempotency for both note saves and AI generations, durable typing during an in-flight sync, and mobile overflow checks.
- Dependency installation audit reported zero vulnerabilities after patched transitive UUID and KaTeX overrides.
- Docker Compose configuration was validated with a temporary empty Notes environment override; real Notes credentials have not been supplied.
- Live Google OAuth, Neon, OpenRouter, Vercel deployment, and physical-device tests remain unverified.

## Workspace refresh verified on 2026-11-13

- TypeScript, formatting, and production build passed, including the offline asset manifest.
- 12 unit/API tests passed; 11 PostgreSQL integration tests were skipped without an isolated test database.
- Chrome acceptance checks passed against the production build with browser-only API fixtures: editing, images, diagrams, summaries, offline reopening, retry and in-flight edits, Settings, and mobile overflow.
- Added browser checks passed for named folder creation, canceled creation, canceled logout, canceled note deletion, and confirmed deletion from the note list. Desktop and mobile screenshots were inspected.
- Live authentication, hosted services, and physical devices were not exercised.
