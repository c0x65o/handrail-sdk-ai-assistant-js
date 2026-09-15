import { afterEach, expect, it, vi } from "vitest";
import { prepareClipboardImage, CLIPBOARD_IMAGE_PREPARATION_LIMITS } from "../src/browser/clipboard-image.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const limit = 8 * 1024 * 1024;
function options() { return { maximumBytes: limit, acceptedMediaTypes: ["image/png", "image/jpeg"] as const, signal: new AbortController().signal }; }
function png(size = limit + 1, width = 3000, height = 2000) {
  const header = new Uint8Array(24), view = new DataView(header.buffer);
  view.setUint32(0, 0x89504e47); view.setUint32(4, 0x0d0a1a0a); view.setUint32(12, 0x49484452);
  view.setUint32(16, width); view.setUint32(20, height);
  return new File([header, new Uint8Array(Math.max(0, size - 24))], "clipboard.png", { type: "image/png", lastModified: 123 });
}
function browser(sizes = [2_700_000]) {
  const bitmap = { width: 3000, height: 2000, close: vi.fn() };
  const context = { fillStyle: "", fillRect: vi.fn(), drawImage: vi.fn() };
  const canvas = { width: 0, height: 0, getContext: vi.fn(() => context),
    toBlob: vi.fn((callback: BlobCallback) => callback(new Blob([new Uint8Array(sizes.shift() ?? limit + 1)], { type: "image/jpeg" }))) };
  const decode = vi.fn(async () => bitmap);
  vi.stubGlobal("createImageBitmap", decode);
  vi.stubGlobal("document", { createElement: vi.fn(() => canvas) });
  return { bitmap, context, canvas, decode };
}
it("keeps a 2.7 MB original unchanged and does not decode it", async () => {
  const b = browser(), source = png(2_700_000);
  expect(await prepareClipboardImage(source, options())).toBe(source);
  expect(b.decode).not.toHaveBeenCalled();
});
it("compresses inflated clipboard bytes, preserves dimensions and uses matching filename/type/size", async () => {
  const b = browser(), source = png();
  const result = await prepareClipboardImage(source, options());
  expect(result).toBeInstanceOf(File);
  expect(result).toMatchObject({ name: "clipboard.jpg", type: "image/jpeg", size: 2_700_000, lastModified: 123 });
  expect(b.context.fillStyle).toBe("#fff");
  expect(b.context.fillRect).toHaveBeenCalledWith(0, 0, 3000, 2000);
  expect(b.context.drawImage).toHaveBeenCalledWith(b.bitmap, 0, 0);
  expect(b.bitmap.close).toHaveBeenCalledOnce();
  expect(b.canvas.width).toBe(0); expect(b.canvas.height).toBe(0);
});
it("uses bounded quality retries and returns the original when compression cannot meet the limit", async () => {
  const b = browser([limit + 3, limit + 2, limit + 1]), source = png();
  expect(await prepareClipboardImage(source, options())).toBe(source);
  expect(b.canvas.toBlob.mock.calls.map(call => (call as unknown[])[2])).toEqual([0.92, 0.86, 0.8]);
  expect(b.bitmap.close).toHaveBeenCalledOnce();
});
it("rejects oversized PNG dimensions before decoding and respects accepted formats", async () => {
  const b = browser(), huge = png(limit + 1, CLIPBOARD_IMAGE_PREPARATION_LIMITS.maximumPixels + 1, 1);
  expect(await prepareClipboardImage(huge, options())).toBe(huge);
  const source = png();
  expect(await prepareClipboardImage(source, { ...options(), acceptedMediaTypes: ["image/png"] })).toBe(source);
  expect(b.decode).not.toHaveBeenCalled();
});
it("disposes decoded resources and never returns prepared bytes after cancellation", async () => {
  const b = browser(), controller = new AbortController();
  b.decode.mockImplementation(async () => { controller.abort(); return b.bitmap; });
  await expect(prepareClipboardImage(png(), { ...options(), signal: controller.signal })).rejects.toThrow();
  expect(b.bitmap.close).toHaveBeenCalledOnce();
  expect(b.canvas.toBlob).not.toHaveBeenCalled();
});
