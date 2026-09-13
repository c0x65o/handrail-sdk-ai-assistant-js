import { awaitWithSignal } from "../await-signal.js";

/** Downloads are negotiated independently of permission to upload new files. */
export interface AttachmentDownloadCapability {
  readonly maximumBytes: number;
  readonly url?: string;
}

export interface AttachmentDownloadInput {
  readonly conversationId: string;
  readonly attachmentId: string;
  readonly mediaType: string;
  readonly byteSize?: number;
  readonly signal: AbortSignal;
}

export class AttachmentDownloadError extends Error {
  constructor(readonly code: "invalid_input" | "unavailable" | "cancelled" | "expired" | "deadline_exceeded") {
    super(code === "expired" ? "This attachment is no longer available."
      : code === "cancelled" ? "Attachment download cancelled." : "The attachment could not be loaded. Try again.");
    this.name = "AttachmentDownloadError";
  }
}

/** Never send application credentials to another origin supplied by a capability. */
export function resolveAttachmentDownloadEndpoint(baseUrl: string, capability: AttachmentDownloadCapability): string {
  const relative = baseUrl.startsWith("/") && !baseUrl.startsWith("//");
  const base = new URL(baseUrl.replace(/\/+$/u, "") + "/", relative ? "https://handrail-relative.invalid" : undefined);
  const endpoint = new URL(capability.url ?? "attachments/content", base);
  if (!["https:", "http:"].includes(base.protocol) || endpoint.origin !== base.origin || endpoint.username || endpoint.password || endpoint.hash) {
    throw new TypeError("The attachment endpoint must share the application origin.");
  }
  return relative ? endpoint.pathname + endpoint.search : endpoint.href;
}

export interface AttachmentDownloadClientOptions {
  readonly endpoint: string;
  readonly capability: AttachmentDownloadCapability;
  readonly fetch?: typeof globalThis.fetch;
  readonly protectedRequest?: (input: RequestInit & { readonly url: string }) => RequestInit | Promise<RequestInit>;
  readonly timeoutMilliseconds?: number;
}

/** Authenticated, bounded binary reads. Provider/server error bodies are never surfaced. */
export function createAttachmentDownloadClient(options: AttachmentDownloadClientOptions) {
  const maximumBytes = options.capability.maximumBytes, timeout = options.timeoutMilliseconds ?? 30_000;
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || !Number.isSafeInteger(timeout) || timeout < 1) {
    throw new TypeError("Attachment download limits are invalid.");
  }
  const fetcher = options.fetch ?? globalThis.fetch;
  return async (input: AttachmentDownloadInput): Promise<Uint8Array> => {
    if (![input.conversationId, input.attachmentId].every((id) => /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u.test(id)) ||
      !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(input.mediaType) ||
      (input.byteSize !== undefined && (!Number.isSafeInteger(input.byteSize) || input.byteSize < 1 || input.byteSize > maximumBytes))) {
      throw new AttachmentDownloadError("invalid_input");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    let signal = AbortSignal.any([input.signal, controller.signal]);
    const query = new URLSearchParams({ conversationId: input.conversationId, attachmentId: input.attachmentId });
    const url = options.endpoint + (options.endpoint.includes("?") ? "&" : "?") + query.toString();
    try {
      signal.throwIfAborted();
      const initial: RequestInit = { method: "GET", credentials: "same-origin", headers: { accept: input.mediaType }, signal };
      const protectedInit = await awaitWithSignal(signal, () => options.protectedRequest?.({ url, ...initial }) ?? initial);
      signal = protectedInit.signal ? AbortSignal.any([signal, protectedInit.signal]) : signal;
      signal.throwIfAborted();
      const response = await awaitWithSignal(signal, async () => {
        const value = await fetcher(url, { ...protectedInit, method: "GET", redirect: "error", cache: "no-store", signal });
        if (signal.aborted) { void value.body?.cancel().catch(() => undefined); signal.throwIfAborted(); }
        return value;
      });
      signal.throwIfAborted();
      const contentLength = response.headers.get("content-length");
      const length = contentLength === null ? null : Number(contentLength);
      if (!response.ok || response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== input.mediaType ||
        (length !== null && (!/^\d+$/u.test(contentLength!) || !Number.isSafeInteger(length) || length < 1 || length > maximumBytes ||
          (input.byteSize !== undefined && length !== input.byteSize)))) {
        void response.body?.cancel().catch(() => undefined);
        throw new AttachmentDownloadError(response.status === 404 || response.status === 410 ? "expired" : "unavailable");
      }
      const reader = response.body?.getReader();
      if (!reader) throw new AttachmentDownloadError("unavailable");
      const abort = () => { void reader.cancel().catch(() => undefined); };
      signal.addEventListener("abort", abort, { once: true });
      const chunks: Uint8Array[] = [];
      let count = 0;
      try {
        while (true) {
          signal.throwIfAborted();
          const chunk = await awaitWithSignal(signal, () => reader.read());
          signal.throwIfAborted();
          if (chunk.done) break;
          count += chunk.value.byteLength;
          if (count > maximumBytes || (input.byteSize !== undefined && count > input.byteSize)) throw new AttachmentDownloadError("unavailable");
          chunks.push(chunk.value);
        }
        if (count === 0 || (length !== null && count !== length) || (input.byteSize !== undefined && count !== input.byteSize)) {
          throw new AttachmentDownloadError("unavailable");
        }
        const bytes = new Uint8Array(count);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        return bytes;
      } finally {
        signal.removeEventListener("abort", abort);
        void reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
    } catch (error) {
      if (signal.aborted) throw new AttachmentDownloadError(input.signal.aborted ? "cancelled"
        : controller.signal.aborted ? "deadline_exceeded" : "cancelled");
      if (error instanceof AttachmentDownloadError) throw error;
      throw new AttachmentDownloadError("unavailable");
    } finally { clearTimeout(timer); }
  };
}
