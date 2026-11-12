import { auth, ownerId } from "@/auth";
import { sql } from "@/lib/db";
import { mutate, summarize, lock, pullChanges } from "@/lib/server";
import { mutationSchema } from "@/lib/model";
import { z } from "zod";
export const runtime = "nodejs";
export const maxDuration = 60;
const uuid = z.uuid();
async function handle(
  req: Request,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const session = await auth();
  const email = session?.user?.email;
  if (
    !email ||
    email.trim().toLowerCase() !==
      process.env.ALLOWED_EMAIL?.trim().toLowerCase()
  )
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  const owner = ownerId(email);
  if (
    req.method !== "GET" &&
    req.headers.get("origin") !== new URL(req.url).origin
  )
    return Response.json({ error: "Invalid origin" }, { status: 403 });
  try {
    const { path } = await params;
    if (path[0] === "identity" && req.method === "GET")
      return Response.json({ owner, email });
    if (path[0] === "sync" && req.method === "GET") {
      const cursor = z.coerce
        .number()
        .int()
        .nonnegative()
        .parse(new URL(req.url).searchParams.get("cursor") || 0);
      return Response.json(await pullChanges(owner, cursor));
    }
    if (path[0] === "sync" && req.method === "POST") {
      const raw = await limitedJson(req, 3_000_000);
      const m = mutationSchema.parse(raw);
      return Response.json(await mutate(owner, m));
    }
    if (path[0] === "summarize" && req.method === "POST") {
      const data = z
        .object({
          id: uuid,
          noteId: uuid,
          revision: z.number().int().positive(),
        })
        .parse(await limitedJson(req, 1024));
      return Response.json(
        await summarize(owner, data.id, data.noteId, data.revision),
      );
    }
    if (path[0] === "images") {
      const id = uuid.parse(path[1]);
      if (req.method === "GET") {
        const [image] =
          await sql()`SELECT mime,bytes FROM images WHERE id=${id} AND owner=${owner}`;
        return image
          ? new Response(new Uint8Array(image.bytes), {
              headers: {
                "Content-Type": image.mime,
                "Cache-Control": "private, no-store",
                "X-Content-Type-Options": "nosniff",
              },
            })
          : new Response(null, { status: 404 });
      }
      if (req.method === "PUT") {
        const mime = req.headers.get("content-type") || "";
        if (
          ![
            "image/png",
            "image/jpeg",
            "image/webp",
            "image/gif",
            "image/avif",
          ].includes(mime)
        )
          throw new Error("Supported images: PNG, JPEG, WebP, GIF, AVIF");
        const bytes = await limitedBytes(req, 4_000_000);
        const file = Buffer.from(bytes);
        const valid =
          mime === "image/png"
            ? file
                .subarray(0, 8)
                .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
            : mime === "image/jpeg"
              ? file[0] === 255 && file[1] === 216
              : mime === "image/gif"
                ? file.subarray(0, 3).toString() === "GIF"
                : mime === "image/webp"
                  ? file.subarray(0, 4).toString() === "RIFF" &&
                    file.subarray(8, 12).toString() === "WEBP"
                  : file.subarray(4, 8).toString() === "ftyp" &&
                    file.subarray(8, 32).includes(Buffer.from("avif"));
        if (!valid) throw new Error("Image bytes do not match the file type");
        await sql().begin(async (tx) => {
          await lock(tx, owner);
          const [old] = await tx`SELECT owner,bytes FROM images WHERE id=${id}`;
          if (old) {
            if (old.owner !== owner || !Buffer.from(old.bytes).equals(file))
              throw new Error("Image ID already exists");
            return;
          }
          await tx`INSERT INTO images(id,owner,mime,bytes) VALUES (${id},${owner},${mime},${file})`;
          await tx`INSERT INTO changes(owner,payload) VALUES (${owner},${tx.json({ kind: "images", id, mime } as never)})`;
        });
        return Response.json({ id });
      }
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  } catch (e) {
    return Response.json(
      {
        error:
          e instanceof z.ZodError
            ? e.issues.find((issue) => issue.code === "custom")?.message ||
              "Invalid request"
            : e instanceof Error
              ? e.message
              : "Request failed",
      },
      { status: 400 },
    );
  }
}
async function limitedBytes(req: Request, max: number) {
  const reader = req.body?.getReader();
  if (!reader) throw new Error("Missing body");
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel();
      throw new Error("File or document is too large");
    }
    chunks.push(value);
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    result.set(c, offset);
    offset += c.length;
  }
  return result;
}
async function limitedJson(req: Request, max: number) {
  return JSON.parse(new TextDecoder().decode(await limitedBytes(req, max)));
}
export const GET = handle;
export const POST = handle;
export const PUT = handle;
