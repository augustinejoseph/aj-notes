export const MAX_IMAGE_BYTES = 4_000_000;
export const MAX_SOURCE_BYTES = 25_000_000;
export const IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/avif",
];

export function validImageHeader(bytes: Uint8Array, mime: string) {
  const text = (start: number, end: number) =>
    String.fromCharCode(...bytes.subarray(start, end));
  if (mime === "image/png")
    return [137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => bytes[i] === b);
  if (mime === "image/jpeg") return bytes[0] === 255 && bytes[1] === 216;
  if (mime === "image/webp")
    return text(0, 4) === "RIFF" && text(8, 12) === "WEBP";
  if (mime === "image/gif") return ["GIF87a", "GIF89a"].includes(text(0, 6));
  return (
    mime === "image/avif" &&
    text(4, 8) === "ftyp" &&
    /avif|avis/.test(text(8, 32))
  );
}

export async function prepareImage(file: Blob): Promise<Blob> {
  if (!IMAGE_TYPES.includes(file.type))
    throw new Error("Use a PNG, JPEG, WebP, GIF, or AVIF image");
  if (file.size > MAX_SOURCE_BYTES)
    throw new Error("Choose an image smaller than 25 MB");
  if (
    !validImageHeader(
      new Uint8Array(await file.slice(0, 32).arrayBuffer()),
      file.type,
    )
  )
    throw new Error("Image bytes do not match the file type");
  // Keep small images untouched, including transparency and animation.
  if (file.size <= 1_000_000) return file;
  if (file.type === "image/gif") {
    if (file.size <= MAX_IMAGE_BYTES) return file;
    throw new Error(
      "Animated GIFs must be under 4 MB. Use WebP, JPEG, or PNG for larger images.",
    );
  }
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error(
      "This image could not be opened. Try a PNG, JPEG, or WebP image.",
    );
  }
  try {
    let scale = Math.min(1, 2560 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    for (let attempt = 0; attempt < 5; attempt++) {
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext("2d");
      if (!context)
        throw new Error("Image compression is unavailable in this browser");
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const compressed = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (blob) =>
            blob
              ? resolve(blob)
              : reject(new Error("Image compression failed")),
          "image/webp",
          attempt ? 0.72 : 0.85,
        ),
      );
      if (compressed.size <= 1_000_000)
        return compressed.size < file.size ? compressed : file;
      scale *= 0.75;
    }
    if (file.size <= MAX_IMAGE_BYTES) return file;
    throw new Error(
      "This image could not be compressed enough. Try a smaller image.",
    );
  } finally {
    bitmap.close();
  }
}
