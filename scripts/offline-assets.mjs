import { readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
const files = await readdir(".next/static", { recursive: true });
const assets = files
  .filter(
    (file) =>
      /\.(js|css|woff2?)$/.test(file) && !file.startsWith("chunks/app/api/"),
  )
  .map((file) => `/_next/static/${file}`)
  .sort();
await writeFile(
  "public/offline-assets.json",
  JSON.stringify({
    version: createHash("sha256").update(JSON.stringify(assets)).digest("hex"),
    assets,
  }),
);
console.log(`Offline asset manifest: ${assets.length} files`);
