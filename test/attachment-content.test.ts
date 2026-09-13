import { expect, it } from "vitest";
import { AttachmentContentError, createAttachmentContentValidator } from "../src/server/attachment-content.js";

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const input = (data: Uint8Array, declaredMediaType = "", fileName = "upload") => ({ data, declaredMediaType, fileName });
const validate = createAttachmentContentValidator();

it("recognizes standard binary inputs and normalizes names without changing bytes", () => {
  const signatures = [
    [png, "image/png", "png"], [Buffer.from([0xff, 0xd8, 0xff]), "image/jpeg", "jpg"],
    [Buffer.from("GIF89a"), "image/gif", "gif"], [Buffer.from("RIFF0000WEBP"), "image/webp", "webp"],
    [Buffer.from("%PDF-1.4"), "application/pdf", "pdf"],
  ] as const;
  for (const [bytes, type, extension] of signatures) {
    const [file] = validate([input(bytes, type, "../../folder\\report\u0000.csv")]);
    expect(file).toEqual({ data: bytes, mediaType: type, fileName: `report.${extension}`, byteSize: bytes.length });
    expect(file!.data).toBe(bytes);
  }
  // A typed-array view must not inspect bytes outside the submitted region.
  const padded = Buffer.concat([Buffer.from("prefix"), png, Buffer.from("suffix")]);
  expect(validate([input(new Uint8Array(padded.buffer, padded.byteOffset + 6, 8))])[0]?.mediaType).toBe("image/png");
  expect(validate([input(png, "", "\u0000")])[0]?.fileName).toBe("attachment.png");
});

it("requires spreadsheet intent, a matching container, or valid delimited UTF-8 text", () => {
  const cases = [
    [Buffer.from("PK\u0003\u0004[Content_Types].xml xl/workbook.xml"), "sheet.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    [Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), "sheet.xls", "application/vnd.ms-excel"],
    [Buffer.from("a,b\n1,2"), "sheet.csv", "text/csv"],
    [Buffer.from("a\tb\n1\t2"), "sheet.tsv", "text/tab-separated-values"],
  ] as const;
  for (const [bytes, name, type] of cases) {
    expect(validate([input(bytes, "application/octet-stream", name)])[0]?.mediaType).toBe(type);
    expect(validate([input(bytes, type, "sheet")])[0]?.mediaType).toBe(type);
    expect(() => validate([input(bytes)])).toThrow(AttachmentContentError);
  }
  for (const bytes of [Buffer.from("plain"), Buffer.from("a,b\u0000"), Buffer.from([0xff, 0x2c]), Buffer.from("PK\u0003\u0004not-a-workbook")]) {
    expect(() => validate([input(bytes, "text/csv", "sheet.csv")])).toThrow(AttachmentContentError);
  }
});

it("preserves actionable validation reasons and configurable allowlists and limits", () => {
  const restricted = createAttachmentContentValidator({ maximumFiles: 2, maximumBytesPerFile: 8,
    maximumTotalBytes: 12, acceptedMediaTypes: ["image/png"] });
  const check = (files: Parameters<typeof restricted>[0], reason: string) => {
    try { restricted(files); expect.fail("Expected content validation failure"); }
    catch (error) { expect(error).toMatchObject({ code: "invalid_input", reason }); }
  };
  check([input(png), input(png), input(png)], "file_count");
  check([input(png), input(png)], "total_size");
  check([input(new Uint8Array())], "file_size");
  check([input(new Uint8Array(9))], "file_size");
  check([input(png, "image/jpeg")], "type_mismatch");
  check([input(Buffer.from("%PDF-1.4"))], "unsupported_type");
  expect(() => createAttachmentContentValidator({ maximumFiles: 0 })).toThrow(TypeError);
  expect(() => createAttachmentContentValidator({ maximumBytesPerFile: NaN })).toThrow(TypeError);
  expect(() => createAttachmentContentValidator({ acceptedMediaTypes: [] })).toThrow(TypeError);
});
