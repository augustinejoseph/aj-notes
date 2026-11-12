import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareImage, validImageHeader } from "@/lib/image-file";
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
afterEach(() => vi.unstubAllGlobals());
describe("image preparation", () => {
  it("preserves small originals and rejects invalid image bytes", async () => {
    const image = new Blob([png], { type: "image/png" });
    expect(await prepareImage(image)).toBe(image);
    await expect(
      prepareImage(new Blob(["not a PNG"], { type: "image/png" })),
    ).rejects.toThrow("file type");
    expect(
      validImageHeader(new TextEncoder().encode("<svg/>"), "image/svg+xml"),
    ).toBe(false);
  });
  it("rejects unsupported and excessive source files", async () => {
    await expect(
      prepareImage(new Blob(["<svg/>"], { type: "image/svg+xml" })),
    ).rejects.toThrow("PNG");
    await expect(
      prepareImage(
        new Blob([png, new Uint8Array(25_000_000)], { type: "image/png" }),
      ),
    ).rejects.toThrow("25 MB");
  });
  it("resizes and compresses large uploads before storing them", async () => {
    const bitmap = { width: 6000, height: 4000, close: vi.fn() };
    const compressed = new Blob(["compressed"], { type: "image/webp" });
    const drawImage = vi.fn();
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ({ drawImage }),
      toBlob: (callback: (blob: Blob) => void) => callback(compressed),
    };
    vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue(bitmap));
    vi.stubGlobal("document", { createElement: () => canvas });
    expect(
      await prepareImage(
        new Blob([png, new Uint8Array(5_000_000)], { type: "image/png" }),
      ),
    ).toBe(compressed);
    expect(canvas.width).toBe(2560);
    expect(canvas.height).toBe(1707);
    expect(bitmap.close).toHaveBeenCalled();
  });
  it("reports decode failures and keeps GIF animation intact", async () => {
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn().mockRejectedValue(new Error("decode")),
    );
    await expect(
      prepareImage(
        new Blob([png, new Uint8Array(1_000_000)], { type: "image/png" }),
      ),
    ).rejects.toThrow("could not be opened");
    const gif = new Blob(["GIF89a", new Uint8Array(1_000_000)], {
      type: "image/gif",
    });
    expect(await prepareImage(gif)).toBe(gif);
    await expect(
      prepareImage(
        new Blob(["GIF89a", new Uint8Array(4_000_000)], { type: "image/gif" }),
      ),
    ).rejects.toThrow("Animated GIFs");
  });
});
