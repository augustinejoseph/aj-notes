import { beforeEach, describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
const network = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: network.lookup }));
vi.mock("node:https", () => ({ request: network.request }));
import { fetchRemoteImage, publicImageURL } from "@/lib/remote-image";

function respond(
  status: number,
  headers: Record<string, string>,
  body = Buffer.from("image"),
) {
  network.request.mockImplementationOnce((_url, _options, callback) => {
    const req = new EventEmitter() as EventEmitter & { end: () => void };
    req.end = () => {
      const response = Object.assign(Readable.from([body]), {
        statusCode: status,
        headers,
      });
      callback(response);
    };
    return req;
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  network.lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
});
describe("remote image import", () => {
  it("allows only public HTTPS URLs without credentials or alternate ports", () => {
    for (const value of [
      "http://example.com/a.png",
      "file:///a.png",
      "https://owner:secret@example.com/a.png",
      "https://example.com:3000/a.png",
    ])
      expect(() => publicImageURL(value)).toThrow();
    expect(publicImageURL("https://example.com/a.png").hostname).toBe(
      "example.com",
    );
  });
  it.each([
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.0.1",
    "100.64.0.1",
    "0.0.0.0",
  ])("rejects private or reserved DNS destination %s", async (address) => {
    network.lookup.mockResolvedValue([{ address, family: 4 }]);
    await expect(fetchRemoteImage("https://example.com/a.png")).rejects.toThrow(
      "public HTTPS",
    );
    expect(network.request).not.toHaveBeenCalled();
  });
  it("pins the validated address and returns image bytes without caching", async () => {
    respond(200, { "content-type": "image/png" });
    const response = await fetchRemoteImage("https://example.com/a.png");
    const options = network.request.mock.calls[0][1];
    const callback = vi.fn();
    options.lookup("example.com", {}, callback);
    expect(callback).toHaveBeenCalledWith(null, "93.184.216.34", 4);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.text()).toBe("image");
  });
  it("revalidates redirect destinations before connecting", async () => {
    respond(302, { location: "https://internal.example/a.png" });
    network.lookup
      .mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }])
      .mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }]);
    await expect(fetchRemoteImage("https://example.com/a.png")).rejects.toThrow(
      "public HTTPS",
    );
    expect(network.request).toHaveBeenCalledTimes(1);
  });
  it("rejects non-images and oversized content", async () => {
    respond(200, { "content-type": "text/html" });
    await expect(fetchRemoteImage("https://example.com/a.png")).rejects.toThrow(
      "directly",
    );
    respond(200, { "content-type": "image/png", "content-length": "25000001" });
    await expect(fetchRemoteImage("https://example.com/a.png")).rejects.toThrow(
      "25 MB",
    );
  });
  it("bounds chunked responses even without content length", async () => {
    respond(200, { "content-type": "image/png" }, Buffer.alloc(25_000_001));
    const response = await fetchRemoteImage("https://example.com/a.png");
    await expect(response.arrayBuffer()).rejects.toThrow("25 MB");
  });
});
