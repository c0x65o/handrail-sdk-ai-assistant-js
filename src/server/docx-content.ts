import { unzipSync } from "fflate";

export const DOCX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document" as const;

/** Bounded OOXML signature validation, not document rendering. Never extracts to
 * disk, follows relationships, or evaluates XML. Original bytes go to the provider
 * and record destination. Macro/encrypted/other ZIP formats are not DOCX inputs. */
export function hasDocxSignature(bytes: Uint8Array): boolean {
  const required = new Set(["[Content_Types].xml", "_rels/.rels", "word/document.xml"]);
  const seen = new Set<string>();
  let expanded = 0;
  try {
    const entries = unzipSync(bytes, { filter(entry) {
      if (seen.has(entry.name) || seen.size >= 2048 || entry.name.includes("\\") ||
        entry.name.startsWith("/") || entry.name.split("/").includes("..") ||
        !Number.isSafeInteger(entry.originalSize) || entry.originalSize < 0 ||
        !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > bytes.byteLength ||
        ![0, 8].includes(entry.compression)) throw new Error("Invalid document archive");
      seen.add(entry.name);
      expanded += entry.originalSize;
      if (expanded > 100 * 1024 * 1024 || /(?:^|\/)vbaProject\.bin$/iu.test(entry.name)) {
        throw new Error("Unsupported document archive");
      }
      if (!required.has(entry.name)) return false;
      if (entry.originalSize === 0 || entry.originalSize > (entry.name === "word/document.xml" ? 20 : 1) * 1024 * 1024) {
        throw new Error("Document XML exceeds limits");
      }
      return true;
    } });
    if ([...required].some(name => !entries[name]?.length)) return false;
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const types = decoder.decode(entries["[Content_Types].xml"]);
    const relationships = decoder.decode(entries["_rels/.rels"]);
    const document = decoder.decode(entries["word/document.xml"]);
    // Reject DTD/entity declarations; processing is delegated to the provider,
    // not an XML evaluator inside the SDK.
    if ([types, relationships, document].some(xml => /<!DOCTYPE|<!ENTITY/iu.test(xml))) return false;
    return types.includes("application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml") &&
      !/macroEnabled/iu.test(types) && /PartName\s*=\s*["']\/word\/document\.xml["']/u.test(types) &&
      /Target\s*=\s*["']\/?word\/document\.xml["']/u.test(relationships) &&
      /<([A-Za-z_][\w.-]*:)?document(?:\s|>)/u.test(document) &&
      /<\/([A-Za-z_][\w.-]*:)?document\s*>/u.test(document) &&
      (document.includes("http://schemas.openxmlformats.org/wordprocessingml/2006/main") ||
        document.includes("http://purl.oclc.org/ooxml/wordprocessingml/main"));
  } catch { return false; }
}
