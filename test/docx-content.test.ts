import { readFileSync } from "node:fs";
import { unzipSync, zipSync, strToU8 } from "fflate";
import { expect, it } from "vitest";
import { createAttachmentContentValidator } from "../src/server/attachment-content.js";
import { DOCX_MEDIA_TYPE, hasDocxSignature } from "../src/server/docx-content.js";

const original = readFileSync(new URL("./fixtures/documents/invoice.docx", import.meta.url));
const entries = unzipSync(original);
const zip = (files: Record<string, Uint8Array>) => zipSync(files, { mtime: new Date("2026-01-01T00:00:00Z") });

it("validates a real compressed DOCX and preserves the original bytes", () => {
  for (const declaredMediaType of [DOCX_MEDIA_TYPE, "application/octet-stream", ""]) {
    const result = createAttachmentContentValidator()([{ data: original, fileName: "invoice.docx", declaredMediaType }])[0]!;
    expect(result.mediaType).toBe(DOCX_MEDIA_TYPE);
    expect(result.fileName).toBe("invoice.docx");
    expect(result.data).toBe(original);
  }
});

it.each([
  ["renamed ZIP", { "readme.txt": strToU8("This is not a Word document") }],
  ["missing relationship", { ...entries, "_rels/.rels": new Uint8Array() }],
  ["missing document", { ...entries, "word/document.xml": new Uint8Array() }],
  ["spreadsheet", { ...entries, "[Content_Types].xml": strToU8("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml") }],
  ["macro", { ...entries, "word/vbaProject.bin": strToU8("macro") }],
  ["XML entity declaration", { ...entries, "word/document.xml": strToU8('<!DOCTYPE x [<!ENTITY entity "value">]>') }],
  ["traversal entry", { ...entries, "../other": strToU8("private") }],
] as const)("rejects %s instead of labeling it DOCX", (_name, files) => {
  expect(hasDocxSignature(zip(files))).toBe(false);
});

it("rejects truncated, fake, and expansion-heavy archives before provider processing", () => {
  expect(hasDocxSignature(original.subarray(0, original.length - 10))).toBe(false);
  expect(hasDocxSignature(Buffer.from("PK\u0003\u0004[Content_Types].xml word/document.xml"))).toBe(false);
  const bomb = zip({ ...entries, "[Content_Types].xml": new Uint8Array(1024 * 1024 + 1).fill(65) });
  expect(hasDocxSignature(bomb)).toBe(false);
  expect(() => createAttachmentContentValidator()([{ data: original, fileName: "old.doc", declaredMediaType: "application/msword" }]))
    .toThrow();
});
