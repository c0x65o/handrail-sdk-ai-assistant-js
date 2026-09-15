import type { ImageMimeType } from "../protocol.js";

/** Clipboard PNGs can be much larger than the compressed file that was copied. */
export const CLIPBOARD_IMAGE_PREPARATION_LIMITS = Object.freeze({
  maximumInputBytes: 64 * 1024 * 1024,
  maximumPixels: 40_000_000,
});

/**
 * Re-encode an oversized pasted PNG at its original dimensions. Picker and
 * drop uploads retain their original bytes. Never lower quality below 0.8 or
 * resize text/diagrams to force acceptance; ordinary intake reports the limit
 * when preparation cannot fit. Transparent pixels are composited on white.
 */
export async function prepareClipboardImage(source: Blob, options: {
  readonly maximumBytes: number;
  readonly acceptedMediaTypes: readonly ImageMimeType[];
  readonly signal: AbortSignal;
}): Promise<Blob> {
  if (source.size <= options.maximumBytes ||
    source.size > CLIPBOARD_IMAGE_PREPARATION_LIMITS.maximumInputBytes ||
    source.type !== "image/png" ||
    !options.acceptedMediaTypes.some(type => type === source.type) ||
    !options.acceptedMediaTypes.includes("image/jpeg") ||
    typeof createImageBitmap !== "function" || typeof document === "undefined") return source;
  let bitmap: ImageBitmap | undefined;
  let canvas: HTMLCanvasElement | undefined;
  try {
    options.signal.throwIfAborted();
    // Check PNG dimensions before allocating its decoded bitmap.
    if (source.type === "image/png") {
      const header = new DataView(await source.slice(0, 24).arrayBuffer());
      if (header.byteLength < 24 || header.getUint32(0) !== 0x89504e47 ||
        header.getUint32(4) !== 0x0d0a1a0a || header.getUint32(12) !== 0x49484452 ||
        header.getUint32(16) * header.getUint32(20) > CLIPBOARD_IMAGE_PREPARATION_LIMITS.maximumPixels) return source;
    }
    options.signal.throwIfAborted();
    bitmap = await createImageBitmap(source);
    options.signal.throwIfAborted();
    if (!bitmap.width || !bitmap.height ||
      bitmap.width * bitmap.height > CLIPBOARD_IMAGE_PREPARATION_LIMITS.maximumPixels) return source;
    canvas = document.createElement("canvas");
    canvas.width = bitmap.width; canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (!context) return source;
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0);
    for (const quality of [0.92, 0.86, 0.8]) {
      options.signal.throwIfAborted();
      const compressed = await new Promise<Blob | null>(resolve => canvas!.toBlob(resolve, "image/jpeg", quality));
      options.signal.throwIfAborted();
      if (!compressed || compressed.type !== "image/jpeg" || compressed.size === 0) return source;
      if (compressed.size <= options.maximumBytes) {
        const name = source instanceof File ? source.name : "pasted-image.png";
        return new File([compressed], `${name.replace(/\.[^.]+$/, "") || "pasted-image"}.jpg`, {
          type: "image/jpeg", lastModified: source instanceof File ? source.lastModified : 0,
        });
      }
    }
    return source;
  } catch (error) {
    if (options.signal.aborted) throw error;
    return source;
  } finally {
    bitmap?.close();
    if (canvas) { canvas.width = 0; canvas.height = 0; }
  }
}
