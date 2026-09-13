import { describe, expect, it, vi } from "vitest";
import { createAttachmentDownloadClient, resolveAttachmentDownloadEndpoint } from "../src/attachments/downloader.js";
import { createHandrailAiClient, APPLICATION_GATEWAY_PROTOCOL_VERSION } from "../src/client/index.js";

const input = { conversationId: "conversation", attachmentId: "att_saved", mediaType: "application/pdf", byteSize: 3,
  signal: new AbortController().signal };
const endpoint = "https://app.test/ai/attachments/content";
const capability = { maximumBytes: 8 };

describe("protected attachment download", () => {
  it("negotiates a protected read with uploads disabled and keeps old gateways compatible", async () => {
    const capabilities = { protocolVersion: APPLICATION_GATEWAY_PROTOCOL_VERSION, authoritativeCancellation: false,
      attachments: false as const, presence: false, synchronization: false };
    const fetcher = vi.fn<typeof fetch>(async () => new Response(new Uint8Array([1, 2, 3]), {
      headers: { "content-type": "application/pdf", "content-length": "3" },
    }));
    const protectedRequest = vi.fn((init: RequestInit) => ({ ...init, headers: { ...init.headers, "x-account": "alice" } }));
    const old = await createHandrailAiClient({ baseUrl: "https://app.test/ai", capabilities });
    const client = await createHandrailAiClient({ baseUrl: "https://app.test/ai", capabilities: {
      ...capabilities, attachmentDownloads: capability }, fetch: fetcher, protectedRequest });
    try {
      expect(old.attachmentDownload).toBeNull();
      expect(client.attachmentUpload).toBeNull();
      expect(await client.attachmentDownload!(input)).toEqual(new Uint8Array([1, 2, 3]));
      expect(fetcher).toHaveBeenCalledWith(endpoint + "?conversationId=conversation&attachmentId=att_saved", expect.objectContaining({
        method: "GET", redirect: "error", cache: "no-store", headers: expect.objectContaining({ "x-account": "alice" }),
      }));
    } finally { await old.dispose(); await client.dispose(); }
  });

  it("rejects cross-origin or credentialed capability URLs", () => {
    expect(resolveAttachmentDownloadEndpoint("/api/ai", capability)).toBe("/api/ai/attachments/content");
    for (const url of ["https://attacker.test/file", "https://secret@app.test/file", "//attacker.test/file", "file#fragment"]) {
      expect(() => resolveAttachmentDownloadEndpoint("https://app.test/ai", { ...capability, url })).toThrow(/origin/);
    }
  });

  it.each([
    { headers: { "content-type": "text/html" }, bytes: [1, 2, 3] },
    { headers: { "content-type": "application/pdf", "content-length": "9" }, bytes: [1, 2, 3] },
    { headers: { "content-type": "application/pdf" }, bytes: [1, 2] },
    { headers: { "content-type": "application/pdf" }, bytes: [1, 2, 3, 4] },
    { headers: { "content-type": "application/pdf" }, bytes: [] },
  ])("rejects wrong MIME and body bounds without disclosing payloads", async ({ headers, bytes }) => {
    const load = createAttachmentDownloadClient({ endpoint, capability,
      fetch: async () => new Response(new Uint8Array(bytes), { headers }) });
    await expect(load(input)).rejects.toMatchObject({ code: "unavailable" });
  });

  it("cancels a streaming response immediately when it exceeds the bound", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(9)); }, cancel });
    const load = createAttachmentDownloadClient({ endpoint, capability,
      fetch: async () => new Response(body, { headers: { "content-type": "application/pdf" } }) });
    await expect(load({ ...input, byteSize: 8 })).rejects.toMatchObject({ code: "unavailable" });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each(["cancel", "timeout"])("stops an unfinished body on %s", async (mode) => {
    const controller = new AbortController(), cancel = vi.fn();
    const fetcher = vi.fn<typeof fetch>(async () => new Response(new ReadableStream({ cancel }), {
      headers: { "content-type": "application/pdf" },
    }));
    const load = createAttachmentDownloadClient({ endpoint, capability, fetch: fetcher, timeoutMilliseconds: mode === "timeout" ? 30 : 10_000 });
    const pending = load({ ...input, signal: controller.signal });
    const check = expect(pending).rejects.toMatchObject({ code: mode === "timeout" ? "deadline_exceeded" : "cancelled" });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    if (mode === "cancel") controller.abort();
    await check;
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("keeps expired and server failures safe and skips an already cancelled request", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response("PRIVATE STORAGE DETAILS", { status: 410 }));
    const load = createAttachmentDownloadClient({ endpoint, capability, fetch: fetcher });
    await expect(load(input)).rejects.toMatchObject({ code: "expired", message: "This attachment is no longer available." });
    const controller = new AbortController(); controller.abort();
    await expect(load({ ...input, signal: controller.signal })).rejects.toMatchObject({ code: "cancelled" });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each(["authentication", "fetch"])("bounds an uncooperative %s callback and ignores its late completion", async (phase) => {
    let finish!: () => void;
    const wait = new Promise<void>((resolve) => { finish = resolve; });
    const cancel = vi.fn();
    const fetcher = vi.fn<typeof fetch>(async () => {
      if (phase === "fetch") await wait;
      return new Response(new ReadableStream({ cancel }), { headers: { "content-type": "application/pdf" } });
    });
    const load = createAttachmentDownloadClient({ endpoint, capability, fetch: fetcher, timeoutMilliseconds: 30,
      protectedRequest: async (init) => { if (phase === "authentication") await wait; return init; } });
    await expect(load(input)).rejects.toMatchObject({ code: "deadline_exceeded" });
    finish();
    if (phase === "authentication") { await new Promise((resolve) => setTimeout(resolve, 0)); expect(fetcher).not.toHaveBeenCalled(); }
    else await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
  });
});
