# Synthetic chat-file fixtures

These contain no customer data. Expected content is invoice **7421**, vendor
**Example Books**, total **USD 123.45**.

- `invoice.png`: raster invoice, visually inspected after generation.
- `invoice.pdf`: Chromium-rendered invoice with actual text.
- `invoice-scan.pdf`: Chromium PDF containing only the raster invoice.
- `invoice.docx`: compressed minimal OOXML Word document containing the same text.
- `manifest.json`: checksums, upload references and canonical saved references.
  A matching copy is tested by the Flutter SDK client and widgets.

`generate.mjs` regenerates the set using fflate and local Playwright. PDF creation
metadata may change, so regenerate the manifest and refresh the Flutter copy
together. Tests read saved fixtures and do not launch a browser or regenerate them.
The generator closes its browser in a `finally` block. This is fixture generation,
not an application or Mobile Preview reproduction.
