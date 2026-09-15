// Regenerate synthetic QA files only. Tests read the saved fixtures directly.
// Optional PLAYWRIGHT_CHROMIUM_EXECUTABLE selects an already installed browser.
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { strToU8, zipSync } from 'fflate';

const directory = fileURLToPath(new URL('.', import.meta.url));
await mkdir(directory, { recursive: true });
const text = 'Synthetic QA invoice 7421. Vendor: Example Books. Total: USD 123.45.';
const files = {
  '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  '_rels/.rels': '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  'word/document.xml': `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p><w:sectPr/></w:body></w:document>`,
};
await writeFile(`${directory}invoice.docx`, zipSync(Object.fromEntries(Object.entries(files).map(([key, value]) => [key, strToU8(value)])),
  { mtime: new Date('2026-01-01T00:00:00Z'), level: 6 }));
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
  ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 300 }, deviceScaleFactor: 1 });
  await page.setContent(`<html><body style="font:28px Arial;padding:30px;color:#000;background:#fff"><h1>Synthetic QA invoice 7421</h1><p>Vendor: Example Books</p><p>Total: USD 123.45</p></body></html>`);
  const png = await page.screenshot({ path: `${directory}invoice.png` });
  await page.pdf({ path: `${directory}invoice.pdf`, format: 'A4', printBackground: true });
  // This PDF contains only the raster invoice: there is no extractable invoice text.
  await page.setContent(`<html><body style="margin:0"><img style="width:100%" src="data:image/png;base64,${png.toString('base64')}" /></body></html>`);
  await page.pdf({ path: `${directory}invoice-scan.pdf`, format: 'A4', printBackground: true });
} finally { await browser.close(); }
const manifest = [];
for (const [filename, media_type] of [['invoice.png', 'image/png'], ['invoice.pdf', 'application/pdf'],
  ['invoice-scan.pdf', 'application/pdf'], ['invoice.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']]) {
  const bytes = await readFile(`${directory}${filename}`);
  const attachment_id = `att_${filename.replaceAll('.', '_')}`;
  manifest.push({ filename, sha256: createHash('sha256').update(bytes).digest('hex'),
    uploaded: { attachment_id, content_ref: `ref_${attachment_id}`, media_type, byte_size: bytes.length, filename },
    saved: { kind: media_type.startsWith('image/') ? 'image' : 'document', attachment_id, media_type, size_bytes: bytes.length, filename } });
}
await writeFile(`${directory}manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
