import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { BlockList } from "node:net";
import { Readable } from "node:stream";
import { IMAGE_TYPES, MAX_SOURCE_BYTES } from "./image-file";

const blocked = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  blocked.addSubnet(network, prefix, "ipv4");

export function publicImageURL(value: string) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443")
  )
    throw new Error("Enter a public HTTPS image URL");
  return url;
}

export async function fetchRemoteImage(
  value: string,
  redirects = 0,
  signal = AbortSignal.timeout(15000),
): Promise<Response> {
  const url = publicImageURL(value);
  const addresses = await lookup(url.hostname, { family: 4, all: true });
  if (
    !addresses.length ||
    addresses.some(({ address }) => blocked.check(address, "ipv4"))
  )
    throw new Error("Enter a public HTTPS image URL");
  // Pin the validated address for this connection to prevent DNS rebinding.
  const response = await new Promise<import("node:http").IncomingMessage>(
    (resolve, reject) => {
      const req = request(
        url,
        {
          method: "GET",
          family: 4,
          signal,
          lookup: (_host, _options, callback) =>
            callback(null, addresses[0].address, 4),
          headers: {
            Accept: IMAGE_TYPES.join(", "),
            "User-Agent": "AJ-Notes-Image-Import",
          },
        },
        resolve,
      );
      req.on("error", reject);
      req.end();
    },
  );
  if ([301, 302, 303, 307, 308].includes(response.statusCode || 0)) {
    response.destroy();
    if (redirects >= 3 || !response.headers.location)
      throw new Error("Image redirected too many times");
    return fetchRemoteImage(
      new URL(response.headers.location, url).href,
      redirects + 1,
      signal,
    );
  }
  const mime =
    response.headers["content-type"]?.split(";")[0].trim().toLowerCase() || "";
  if (response.statusCode !== 200 || !IMAGE_TYPES.includes(mime)) {
    response.destroy();
    throw new Error(
      "The URL must point directly to a PNG, JPEG, WebP, GIF, or AVIF image",
    );
  }
  if (Number(response.headers["content-length"]) > MAX_SOURCE_BYTES) {
    response.destroy();
    throw new Error("Choose an image smaller than 25 MB");
  }
  const reader = (
    Readable.toWeb(response) as ReadableStream<Uint8Array>
  ).getReader();
  let total = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            controller.close();
            return;
          }
          total += value.byteLength;
          if (total > MAX_SOURCE_BYTES) {
            await reader.cancel();
            controller.error(new Error("Image exceeds 25 MB"));
            return;
          }
          controller.enqueue(value);
        } catch (error) {
          controller.error(error);
        }
      },
      cancel: () => reader.cancel(),
    }),
    {
      headers: {
        "Content-Type": mime,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}
