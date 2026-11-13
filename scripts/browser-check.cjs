/* Browser-only API fixtures; production authentication is never bypassed in app code. */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { mutationSchema, applyMutation } = require("../lib/model.ts");
const origin = process.env.NOTES_PREVIEW_URL || "http://localhost:3003";
(async () => {
  console.log("Launching browser");
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    });
    const data = new Map(),
      changes = [],
      receipts = new Map(),
      jobs = new Map(),
      images = new Map();
    let failGeneration = true,
      failNext = false,
      holdNext = false,
      releaseResponse = null,
      requestStarted = null;
    await context.route("**/api/**", async (route) => {
      const req = route.request(),
        url = new URL(req.url());
      if (url.pathname === "/api/identity")
        return route.fulfill({
          json: { owner: "browser-test-owner", email: "owner@example.test" },
        });
      if (url.pathname === "/api/image-import") {
        if (req.postDataJSON().url !== "https://images.example.test/photo.png")
          return route.fulfill({
            status: 400,
            json: { error: "The URL must point directly to an image" },
          });
        return route.fulfill({
          contentType: "image/png",
          body: Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
            "base64",
          ),
        });
      }
      if (url.pathname.startsWith("/api/images/")) {
        const id = url.pathname.split("/").pop();
        if (req.method() === "PUT") {
          images.set(id, {
            bytes: req.postDataBuffer(),
            mime: req.headers()["content-type"],
          });
          changes.push({
            seq: changes.length + 1,
            payload: { kind: "images", id },
          });
          return route.fulfill({ json: { id } });
        }
        const image = images.get(id);
        return image
          ? route.fulfill({ body: image.bytes, contentType: image.mime })
          : route.fulfill({ status: 404 });
      }
      if (url.pathname === "/api/sync" && req.method() === "GET") {
        const cursor = Number(url.searchParams.get("cursor") || 0),
          selected = changes.filter((c) => c.seq > cursor);
        return route.fulfill({
          json: {
            changes: selected,
            cursor: selected.at(-1)?.seq || cursor,
            more: false,
          },
        });
      }
      if (url.pathname === "/api/sync" && req.method() === "POST") {
        const m = req.postDataJSON();
        const validated = mutationSchema.safeParse(m);
        if (!validated.success)
          return route.fulfill({
            status: 400,
            json: {
              error: validated.error.issues.map((i) => i.message).join("; "),
            },
          });
        let result = receipts.get(m.id);
        if (!result) {
          const { row } = applyMutation(data.get(m.entityId), m, randomUUID);
          data.set(row.id, row);
          changes.push({ seq: changes.length + 1, payload: row });
          result = { rows: [row] };
          receipts.set(m.id, result);
        }
        if (failNext) {
          failNext = false;
          return route.abort("connectionreset");
        }
        if (holdNext) {
          holdNext = false;
          requestStarted?.();
          await new Promise((resolve) => {
            releaseResponse = resolve;
          });
        }
        return route.fulfill({ json: result });
      }
      if (url.pathname === "/api/summarize") {
        const previous = jobs.get(req.postDataJSON().id);
        if (previous) return route.fulfill({ json: previous });
        const job = req.postDataJSON(),
          note = data.get(job.noteId),
          id = randomUUID();
        const summary = {
          id,
          kind: "summaries",
          revision: 1,
          deleted: false,
          data: {
            noteId: note.id,
            sourceSnapshot: note.data.document,
            sourceRevision: note.revision,
            createdAt: new Date().toISOString(),
            document: [
              {
                type: "paragraph",
                content: [
                  { type: "text", text: "Summary from fixture", styles: {} },
                ],
              },
            ],
          },
        };
        const next = {
          ...note,
          revision: note.revision + 1,
          data: { ...note.data, currentSummaryId: id },
        };
        for (const row of [summary, next]) {
          data.set(row.id, row);
          changes.push({ seq: changes.length + 1, payload: row });
        }
        const response = { rows: [summary, next] };
        jobs.set(job.id, response);
        if (failGeneration) {
          failGeneration = false;
          return route.abort("connectionreset");
        }
        return route.fulfill({ json: response });
      }
      return route.fulfill({
        status: 404,
        json: { error: "Test fixture unavailable" },
      });
    });
    await context.route("**/apps.json", (route) =>
      route.fulfill({
        json: {
          schemaVersion: 1,
          apps: ["health", "journal", "notes"].map((id) => ({
            id,
            name: id[0].toUpperCase() + id.slice(1),
            description: "Browser fixture",
            repository: `aj-${id}`,
            status: "available",
            enabled: true,
            icon: id === "health" ? "heart-pulse" : "book-open",
            url: `https://${id}.example.test/`,
          })),
        },
      }),
    );
    const page = await context.newPage(),
      errors = [];
    page.on("pageerror", (e) => {
      errors.push(e.message);
      console.log("Page error:", e.message);
    });
    page.on("console", (message) => {
      if (message.type() === "error")
        console.log("Browser error:", message.text().slice(0, 200));
    });
    page.on("response", (response) => {
      if (response.status() >= 400)
        console.log("HTTP", response.status(), response.url());
    });
    page.on("dialog", (dialog) => dialog.accept());
    page.setDefaultTimeout(15000);
    console.log(
      "Offline endpoints",
      (await context.request.get(origin + "/sw.js")).status(),
      (await context.request.get(origin + "/offline-assets.json")).status(),
    );
    console.log("Opening Notes");
    await page.goto(origin);
    console.log("Creating note");
    await page
      .getByRole("button", { name: "＋ New note", exact: true })
      .click();
    await page.waitForURL(/\/notes\/[a-f0-9-]+$/);
    const notePath = new URL(page.url()).pathname;
    await page
      .getByRole("textbox", { name: "Note title", exact: true })
      .fill("Browser acceptance note");
    console.log("Waiting for editor");
    const editable = page.locator(".bn-editor[contenteditable=true]");
    await editable.click();
    await page.keyboard.type("An idea worth keeping.");
    await page.evaluate(() => {
      const clipboard = new DataTransfer();
      clipboard.setData(
        "text/html",
        '<p>Before the image</p><img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII="/><p>After the image</p>',
      );
      document.querySelector(".bn-editor").dispatchEvent(
        new ClipboardEvent("paste", {
          clipboardData: clipboard,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await page.locator("article img").first().waitFor();
    await editable.click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.press("Enter");
    await page.keyboard.type("/mermaid");
    await page.getByText("Mermaid diagram", { exact: true }).click();
    await page
      .getByRole("textbox", { name: "Mermaid source", exact: true })
      .waitFor();
    await page.getByAltText("Mermaid diagram", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Sync", exact: true }).click();
    await page
      .getByRole("status")
      .filter({ hasText: "All notes and images available offline" })
      .waitFor({ timeout: 30000 })
      .catch(async (error) => {
        console.log("Visible page:", await page.locator("body").innerText());
        console.log(
          "Workers:",
          await page.evaluate(async () => {
            return (await navigator.serviceWorker.getRegistrations()).map(
              (r) => ({
                scope: r.scope,
                active: r.active?.state,
                installing: r.installing?.state,
                waiting: r.waiting?.state,
              }),
            );
          }),
        );
        throw error;
      });
    assert.equal(data.size, 1);
    assert.equal(images.size, 1);
    assert.match(JSON.stringify([...data.values()]), /An idea worth keeping/);
    console.log("Generating summary");
    await page
      .getByRole("button", { name: "✧ Summarize", exact: true })
      .click();
    await page.getByRole("alert").first().waitFor();
    await page
      .getByRole("button", { name: "✧ Summarize", exact: true })
      .click();
    await page.getByRole("tab", { name: "Summary", exact: true }).waitFor();
    await page.getByText("Summary from fixture", { exact: true }).waitFor();
    assert.equal(
      jobs.size,
      1,
      "A lost AI response must reuse the original generation request",
    );
    await editable.click();
    await page.keyboard.press("End");
    await page.keyboard.type(" My manual tweak.");
    await page.getByRole("button", { name: "Sync", exact: true }).click();
    await page
      .getByRole("status")
      .filter({ hasText: "All notes and images available offline" })
      .waitFor({ timeout: 30000 })
      .catch(async (error) => {
        console.log("Visible page:", await page.locator("body").innerText());
        console.log(
          "Workers:",
          await page.evaluate(async () => {
            return (await navigator.serviceWorker.getRegistrations()).map(
              (r) => ({
                scope: r.scope,
                active: r.active?.state,
                installing: r.installing?.state,
                waiting: r.waiting?.state,
              }),
            );
          }),
        );
        throw error;
      });
    assert.match(
      JSON.stringify([...data.values()].filter((r) => r.kind === "summaries")),
      /manual tweak/,
    );
    await page.getByRole("tab", { name: "Original", exact: true }).click();
    await context.setOffline(true);
    await page
      .getByRole("textbox", { name: "Note title", exact: true })
      .fill("Edited while offline");
    await page
      .getByRole("status")
      .filter({ hasText: "Saved on this device" })
      .waitFor();
    console.log("Reopening offline");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page
      .getByRole("button", { name: "Edited while offline", exact: false })
      .first()
      .click();
    await page
      .getByRole("textbox", { name: "Note title", exact: true })
      .waitFor();
    assert.equal(
      await page
        .getByRole("textbox", { name: "Note title", exact: true })
        .inputValue(),
      "Edited while offline",
    );
    await page.locator("article img").first().waitFor();
    await page
      .getByRole("textbox", { name: "Mermaid source", exact: true })
      .fill("sequenceDiagram\n  Alice->>Bob: Works offline");
    await page.getByAltText("Mermaid diagram", { exact: true }).waitFor();
    await page
      .getByRole("status")
      .filter({ hasText: "Saved on this device" })
      .waitFor();
    await context.setOffline(false);
    failNext = true;
    await page.getByRole("button", { name: "Sync", exact: true }).click();
    await page.getByRole("alert").first().waitFor();
    const receiptCount = receipts.size;
    await page.getByRole("button", { name: "Sync", exact: true }).click();
    await page
      .getByRole("status")
      .filter({ hasText: "All notes and images available offline" })
      .waitFor({ timeout: 30000 })
      .catch(async (error) => {
        console.log("Visible page:", await page.locator("body").innerText());
        console.log(
          "Workers:",
          await page.evaluate(async () => {
            return (await navigator.serviceWorker.getRegistrations()).map(
              (r) => ({
                scope: r.scope,
                active: r.active?.state,
                installing: r.installing?.state,
                waiting: r.waiting?.state,
              }),
            );
          }),
        );
        throw error;
      });
    assert.equal(
      receipts.size,
      receiptCount,
      "Retry should reuse the mutation receipt",
    );
    assert.equal(
      [...data.values()].find((r) => r.kind === "notes").data.title,
      "Edited while offline",
    );
    const waitForLocalTitle = (title) =>
      page.waitForFunction(async (wanted) => {
        const db = await new Promise((resolve, reject) => {
          const req = indexedDB.open("aj-notes-browser-test-owner");
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
        const rows = await new Promise((resolve, reject) => {
          const req = db.transaction("records").objectStore("records").getAll();
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
        db.close();
        return rows.some((r) => r.kind === "notes" && r.data.title === wanted);
      }, title);
    console.log("Editing during in-flight sync");
    holdNext = true;
    const started = new Promise((resolve, reject) => {
      const deadline = setTimeout(
        () => reject(new Error("Sync upload did not start within 15 seconds")),
        15000,
      );
      requestStarted = () => {
        clearTimeout(deadline);
        resolve();
      };
    });
    await page
      .getByRole("textbox", { name: "Note title", exact: true })
      .fill("First in-flight edit");
    await waitForLocalTitle("First in-flight edit");
    await page.getByRole("button", { name: "Sync", exact: true }).click();
    await started;
    await page
      .getByRole("textbox", { name: "Note title", exact: true })
      .fill("Newest edit during sync");
    await waitForLocalTitle("Newest edit during sync");
    releaseResponse();
    await page
      .getByRole("status")
      .filter({ hasText: "more changes awaiting sync" })
      .waitFor();
    await page.getByRole("button", { name: "Sync", exact: true }).click();
    await page
      .getByRole("status")
      .filter({ hasText: "All notes and images available offline" })
      .waitFor();
    assert.equal(
      [...data.values()].find((r) => r.kind === "notes").data.title,
      "Newest edit during sync",
    );
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    assert.equal(new URL(page.url()).pathname, "/settings");
    await page
      .getByRole("heading", { name: "Settings", exact: true })
      .waitFor();
    await page.reload();
    await page
      .getByRole("heading", { name: "Settings", exact: true })
      .waitFor();
    await page
      .getByLabel("Summary instructions", { exact: true })
      .fill("My summary preferences");
    await page
      .getByRole("button", { name: "Save settings", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Newest edit during sync", exact: false })
      .first()
      .click();
    assert.equal(new URL(page.url()).pathname, notePath);
    await page.getByRole("button", { name: "Sync", exact: true }).click();
    await page
      .getByRole("status")
      .filter({ hasText: "All notes and images available offline" })
      .waitFor({ timeout: 30000 })
      .catch(async (error) => {
        console.log("Visible page:", await page.locator("body").innerText());
        console.log(
          "Workers:",
          await page.evaluate(async () => {
            return (await navigator.serviceWorker.getRegistrations()).map(
              (r) => ({
                scope: r.scope,
                active: r.active?.state,
                installing: r.installing?.state,
                waiting: r.waiting?.state,
              }),
            );
          }),
        );
        throw error;
      });
    assert.equal(
      [...data.values()].find((r) => r.kind === "settings").data.instructions,
      "My summary preferences",
    );
    await page.waitForFunction(async () => {
      const image = document.querySelector('img[alt="Mermaid diagram"]');
      return (
        image &&
        (await (await fetch(image.src)).text()).includes("Works offline")
      );
    });
    const diagramSize = await page
      .getByAltText("Mermaid diagram", { exact: true })
      .evaluate((image) => ({
        width: image.getBoundingClientRect().width,
        height: image.getBoundingClientRect().height,
        naturalWidth: image.naturalWidth,
      }));
    assert.ok(
      diagramSize.width > 100 &&
        diagramSize.height > 80 &&
        diagramSize.naturalWidth > 0,
      "Diagram must visibly render",
    );

    console.log("Embedding a URL and compressing a large image upload");
    async function addImageBlock() {
      await editable.click();
      await page.keyboard.press("ControlOrMeta+End");
      await page.keyboard.press("Enter");
      await page.keyboard.type("/image");
      await page.getByText("Image", { exact: true }).click();
      await page.getByRole("tab", { name: "Upload", exact: true }).waitFor();
    }
    await addImageBlock();
    await page.getByRole("tab", { name: "Embed", exact: true }).click();
    await page
      .getByRole("textbox", { name: "Image URL", exact: true })
      .fill("https://images.example.test/not-an-image");
    await page
      .getByRole("button", { name: "Embed image", exact: true })
      .click();
    await page
      .getByRole("alert")
      .filter({ hasText: "directly to an image" })
      .waitFor();
    await page
      .getByRole("textbox", { name: "Image URL", exact: true })
      .fill("https://images.example.test/photo.png");
    await page
      .getByRole("button", { name: "Embed image", exact: true })
      .click();
    await page.waitForFunction(
      () => document.querySelectorAll('article img[src^="blob:"]').length >= 3,
    );
    await addImageBlock();
    const largePNG = Buffer.from(
      await page.evaluate(() => {
        const canvas = document.createElement("canvas");
        canvas.width = 1800;
        canvas.height = 1200;
        const ctx = canvas.getContext("2d");
        const pixels = ctx.createImageData(canvas.width, canvas.height);
        let seed = 123456;
        for (let i = 0; i < pixels.data.length; i += 4) {
          for (let c = 0; c < 3; c++) {
            seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
            pixels.data[i + c] = seed >>> 24;
          }
          pixels.data[i + 3] = 255;
        }
        ctx.putImageData(pixels, 0, 0);
        return canvas.toDataURL("image/png").split(",")[1];
      }),
      "base64",
    );
    assert.ok(
      largePNG.length > 4_000_000,
      "Upload fixture must exceed the old image limit",
    );
    await page.locator('input[type="file"]').setInputFiles({
      name: "large-photo.png",
      mimeType: "image/png",
      buffer: largePNG,
    });
    await page.waitForFunction(
      () => document.querySelectorAll('article img[src^="blob:"]').length >= 4,
    );
    await page.getByRole("button", { name: "Sync", exact: true }).click();
    await page
      .getByRole("status")
      .filter({ hasText: "All notes and images available offline" })
      .waitFor();
    assert.equal(
      images.size,
      3,
      "Paste, embed and upload must each create one attachment",
    );
    const compressedImage = [...images.values()].find(
      (image) => image.mime === "image/webp",
    );
    assert.ok(compressedImage, "Large PNG must be compressed to WebP");
    assert.ok(
      compressedImage.bytes.length < 1_000_000,
      "Compressed upload must stay below 1 MB",
    );
    for (const row of [...data.values()].filter(
      (row) => row.kind === "notes",
    )) {
      assert.equal(
        /https:\/\/images.example/.test(JSON.stringify(row)),
        false,
        "Only internal attachment URLs may be persisted",
      );
    }
    console.log("Checking routes, browser history, and Apps popup bounds");
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.goBack();
    await page
      .getByRole("textbox", { name: "Note title", exact: true })
      .waitFor();
    await page.goForward();
    await page
      .getByRole("heading", { name: "Settings", exact: true })
      .waitFor();
    await context.setOffline(true);
    await page.reload();
    await page
      .getByRole("heading", { name: "Settings", exact: true })
      .waitFor();
    assert.equal(
      await page
        .getByLabel("Summary instructions", { exact: true })
        .inputValue(),
      "My summary preferences",
    );
    await page
      .getByRole("button", { name: "Close settings", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Newest edit during sync", exact: false })
      .first()
      .click();
    await page.reload();
    await page
      .getByRole("textbox", { name: "Note title", exact: true })
      .waitFor();
    assert.equal(new URL(page.url()).pathname, notePath);
    await page.waitForFunction(() => {
      const images = [...document.querySelectorAll("article img")];
      return (
        images.length >= 4 &&
        images.every((image) => image.complete && image.naturalWidth > 0)
      );
    });
    await context.setOffline(false);
    for (const [width, height] of [
      [1440, 844],
      [800, 844],
      [390, 844],
      [320, 844],
      [390, 300],
    ]) {
      await page.setViewportSize({ width, height });
      await page
        .getByRole("button", {
          name: "Open application directory",
          exact: true,
        })
        .click();
      const panel = page.getByRole("region", {
        name: "Applications",
        exact: true,
      });
      await panel.getByRole("link", { name: "Health", exact: true }).waitFor();
      const bounds = await panel.boundingBox();
      assert.ok(
        bounds.x >= 0 && bounds.x + bounds.width <= width,
        `Apps popup must fit ${width}px viewport`,
      );
      assert.ok(
        bounds.y >= 0 && bounds.y + bounds.height <= height,
        "Apps popup must fit viewport height",
      );
      const tools = await page.locator(".workspace-tools").boundingBox();
      assert.ok(
        tools.x + tools.width >= width - 25,
        "Tools must be right-aligned",
      );
      await page.screenshot({
        path: `/tmp/aj-notes-apps-${width}-${height}.png`,
      });
      await page.keyboard.press("Escape");
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({
      path: "/tmp/aj-notes-desktop.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: "/tmp/aj-notes-mobile.png", fullPage: true });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
      "Mobile layout should not overflow",
    );
    assert.deepEqual(errors, []);
    console.log(
      "Browser checks passed: editor, mixed image paste, Mermaid offline, summary editing, offline reopen, lost-response retry, in-flight edits, settings, and mobile layout.",
    );
    console.log("Checking cross-device conflicts and version restoration");
    const conflictNote = data.get(new URL(page.url()).pathname.split("/")[2]);
    assert.equal(conflictNote.kind, "notes");
    const beforeConflictCount = [...data.values()].filter(
      (r) => r.kind === "notes" && !r.deleted,
    ).length;
    const remoteEdit = applyMutation(
      conflictNote,
      {
        id: randomUUID(),
        kind: "notes",
        entityId: conflictNote.id,
        baseRevision: conflictNote.revision,
        deleted: false,
        data: { ...conflictNote.data, title: "Edit from another device" },
      },
      randomUUID,
    ).row;
    data.set(remoteEdit.id, remoteEdit);
    changes.push({ seq: changes.length + 1, payload: remoteEdit });
    await page
      .getByRole("textbox", { name: "Note title", exact: true })
      .fill("Local conflicting edit");
    await waitForLocalTitle("Local conflicting edit");
    await page.getByRole("button", { name: "Sync", exact: true }).click();
    await page
      .getByRole("status")
      .filter({ hasText: "All notes and images available offline" })
      .waitFor();
    assert.equal(
      [...data.values()].filter((r) => r.kind === "notes" && !r.deleted).length,
      beforeConflictCount,
    );
    assert.equal(data.get(remoteEdit.id).data.title, "Local conflicting edit");
    await page.getByText(/Saved versions from other devices/).click();
    await page
      .getByText(`Edit from another device · revision ${remoteEdit.revision}`, {
        exact: true,
      })
      .click();
    await page
      .getByRole("button", { name: "Restore this version", exact: true })
      .click();
    await waitForLocalTitle("Edit from another device");
    await page.getByRole("button", { name: "Sync", exact: true }).click();
    await page
      .getByRole("status")
      .filter({ hasText: "All notes and images available offline" })
      .waitFor();
    assert.equal(
      data.get(remoteEdit.id).data.title,
      "Edit from another device",
    );
    assert(
      data
        .get(remoteEdit.id)
        .data.conflictVersions.some(
          (v) => v.title === "Local conflicting edit",
        ),
    );
    await page.reload();
    await page
      .getByRole("textbox", { name: "Note title", exact: true })
      .waitFor();
    assert.equal(
      await page
        .getByRole("textbox", { name: "Note title", exact: true })
        .inputValue(),
      "Edit from another device",
    );
    console.log("Cross-device conflict identity and restoration passed");
    console.log("Checking folder names and destructive action confirmations");
    await page.setViewportSize({ width: 1440, height: 1000 });
    page.removeAllListeners("dialog");
    page.once("dialog", async (dialog) => {
      assert.equal(dialog.type(), "prompt");
      await dialog.accept("Named folder");
    });
    await page.getByRole("button", { name: "New folder", exact: true }).click();
    await page
      .getByRole("button", { name: "▱ Named folder", exact: true })
      .waitFor();
    page.once("dialog", (dialog) => dialog.dismiss());
    await page.getByRole("button", { name: "New folder", exact: true }).click();
    assert.equal(await page.locator(".folder").count(), 1);
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    const confirmation = page.getByRole("dialog");
    await confirmation
      .getByRole("heading", { name: "Sign out?", exact: true })
      .waitFor();
    assert.equal(
      await confirmation
        .getByRole("button", { name: "Cancel", exact: true })
        .evaluate((el) => el === document.activeElement),
      true,
    );
    await page.screenshot({ path: "/tmp/aj-notes-confirm.png" });
    await confirmation
      .getByRole("button", { name: "Cancel", exact: true })
      .click();
    await page
      .getByRole("textbox", { name: "Note title", exact: true })
      .waitFor();
    await page
      .getByRole("button", {
        name: "Delete Edit from another device",
        exact: true,
      })
      .click();
    await confirmation
      .getByRole("heading", { name: "Delete note?", exact: true })
      .waitFor();
    await page.keyboard.press("Escape");
    await page
      .getByRole("textbox", { name: "Note title", exact: true })
      .waitFor();
    await page
      .getByRole("button", {
        name: "Delete Edit from another device",
        exact: true,
      })
      .click();
    await confirmation
      .getByRole("button", { name: "Delete", exact: true })
      .click();
    await page
      .getByRole("button", {
        name: "Delete Edit from another device",
        exact: true,
      })
      .waitFor({ state: "detached" });
    assert.equal(
      await page
        .getByRole("textbox", { name: "Note title", exact: true })
        .count(),
      0,
    );
    console.log(
      "Folder naming, cancel, logout confirmation, and note deletion passed.",
    );
    await context.close();
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
