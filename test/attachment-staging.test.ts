import { describe, expect, it, vi } from "vitest";
import { AttachmentStagingError, createAttachmentStagingService,
  type StagedAttachmentRecord } from "../src/attachments/staging.js";
import { parseChatRequest, type AttachmentReference } from "../src/protocol.js";

function validateReference(reference: AttachmentReference) {
  parseChatRequest({ protocol_version: "handrail.ai-runtime.v1", continuation_of: null,
    messages: [{ role: "user", content: [{ type: reference.media_type.startsWith("image/") ? "image" : "document", attachment: reference }] }],
    tools: [], tool_results: [], generation: { max_output_tokens: 1000, temperature: 0.2 }, correlation_hints: {}, metadata: {} });
  return reference;
}

function fixture() {
  const records = new Map<string, StagedAttachmentRecord>(), blobs = new Map<string, Uint8Array>();
  const deleted = vi.fn(async (key: string) => { blobs.delete(key); });
  let sequence = 0, clock = Date.parse("2026-01-01T00:00:00.000Z");
  const service = createAttachmentStagingService({ now: () => clock, createId: () => `${++sequence}`,
    limits: { maximumBytes: 8, acceptedMediaTypes: ["image/*", "application/pdf"], ttlMilliseconds: 1_000 },
    blobs: { async put(input) { blobs.set(input.key, input.bytes); }, async get(key) { return blobs.get(key) ?? null; }, delete: deleted },
    metadata: {
      async getByIdempotency(owner, conversation, key) { return [...records.values()].find((record) =>
        record.ownerScopeId === owner && record.conversationId === conversation && record.idempotencyKey === key) ?? null; },
      async getByContentRef(ref) { return records.get(ref) ?? null; },
      async create(record) { if (records.has(record.contentRef)) return "conflict"; records.set(record.contentRef, record); return "created"; },
      async markConsumed(ref, consumedAt) { const record = records.get(ref)!; records.set(ref, { ...record, consumedAt }); },
      async listExpired(before) { return [...records.values()].filter((record) => record.expiresAt <= before); },
      async delete(ref) { records.delete(ref); },
    } });
  return { service, records, blobs, deleted, advance: (milliseconds: number) => { clock += milliseconds; } };
}

describe("attachment staging", () => {
  it("captures upload bytes and identity before asynchronous storage", async () => {
    const value = fixture();
    const input = { ownerScopeId: "owner-1", conversationId: "conversation-1",
      idempotencyKey: "frozen-upload", fingerprint: "original", mediaType: "application/pdf",
      filename: "original.pdf", bytes: new Uint8Array([1, 2, 3]) };
    const pending = value.service.stage(input);
    input.bytes.fill(9); input.fingerprint = "changed"; input.filename = "changed.pdf";
    const reference = await pending;
    const resolved = await value.service.resolve({ ownerScopeId: "owner-1", conversationId: "conversation-1",
      contentRef: reference.content_ref });
    expect(resolved.bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(resolved.record).toMatchObject({ fingerprint: "original", filename: "original.pdf" });
  });

  it("retains only opaque metadata, enforces ownership, and deletes bytes after consumption", async () => {
    const value = fixture();
    const reference = await value.service.stage({ ownerScopeId: "owner-1", conversationId: "conversation-1",
      idempotencyKey: "upload-1", fingerprint: "sha256-1", mediaType: "application/pdf",
      filename: "report.pdf", bytes: new Uint8Array([1, 2, 3]) });
    expect(JSON.stringify([...value.records.values()])).not.toContain("1,2,3");
    expect(validateReference(reference)).toEqual(reference);
    await expect(value.service.resolve({ ownerScopeId: "owner-2", conversationId: "conversation-1",
      contentRef: reference.content_ref })).rejects.toMatchObject({ code: "forbidden" });
    expect((await value.service.resolve({ ownerScopeId: "owner-1", conversationId: "conversation-1",
      contentRef: reference.content_ref })).bytes).toEqual(new Uint8Array([1, 2, 3]));
    await value.service.consume({ ownerScopeId: "owner-1", conversationId: "conversation-1", contentRef: reference.content_ref });
    expect(value.blobs.size).toBe(0);
  });

  it("is idempotent and expires staged bytes", async () => {
    const value = fixture(), input = { ownerScopeId: "owner-1", conversationId: "conversation-1",
      idempotencyKey: "upload-1", fingerprint: "sha256-1", mediaType: "image/png", bytes: new Uint8Array([1]) };
    const first = await value.service.stage(input); expect(await value.service.stage(input)).toEqual(first);
    await expect(value.service.stage({ ...input, fingerprint: "sha256-2" })).rejects.toBeInstanceOf(AttachmentStagingError);
    value.advance(1_001);
    await expect(value.service.resolve({ ownerScopeId: "owner-1", conversationId: "conversation-1",
      contentRef: first.content_ref })).rejects.toMatchObject({ code: "expired" });
    expect(await value.service.cleanupExpired()).toBe(1); expect(value.records.size).toBe(0);
  });

  it("refuses retired staging identities without aliasing, restaging or purging their stored bytes", async () => {
    const value = fixture(), input = { ownerScopeId: "owner-1", conversationId: "conversation-1",
      idempotencyKey: "upload-1", fingerprint: "sha256-1", mediaType: "image/png", bytes: new Uint8Array([1]) };
    const staged = await value.service.stage(input);
    const original = value.records.get(staged.content_ref)!;
    const legacy = { ...original, contentRef: original.contentRef.replace(/^ref_/u, "blob_") };
    value.records.delete(original.contentRef); value.records.set(legacy.contentRef, legacy);
    await expect(value.service.stage(input)).rejects.toMatchObject({ code: "not_found" });
    const read = { ownerScopeId: input.ownerScopeId, conversationId: input.conversationId, contentRef: staged.content_ref };
    await expect(value.service.resolve(read)).rejects.toMatchObject({ code: "not_found" });
    await expect(value.service.resolve({ ...read, contentRef: legacy.contentRef })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(value.service.consume(read)).rejects.toMatchObject({ code: "not_found" });
    expect([...value.records.values()]).toEqual([legacy]);
    expect([...value.blobs.values()]).toEqual([input.bytes]);
    expect(value.deleted).not.toHaveBeenCalled();
  });
});
