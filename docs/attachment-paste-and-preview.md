# Clipboard images and attachment previews

## Cause and behavior

The React composer previously applied the upload byte limit directly to the
clipboard file. Browsers can expose a copied JPEG as PNG, whose bytes are much
larger than the original file. A deterministic Chromium reproduction starts
with a 2,670,630-byte JPEG, copies its decoded pixels as a 23,074,581-byte PNG,
and reproduces `too_large` in the existing image intake. The user's original
image bytes were not provided; the reproduction establishes the failure
mechanism rather than the exact size of their clipboard payload.

The shared composer now prepares oversized clipboard PNGs before normal intake.
It tries JPEG quality 0.92, 0.86 and 0.8 at the original resolution, stopping as
soon as the host's byte limit is met. The reproduced upload is 4,085,273 bytes,
with its original 2600 × 2600 dimensions. The preview and uploaded metadata
refer to the prepared JPEG. Already-small images, picker/drop uploads, GIFs and
other original files retain their bytes. Transparent pixels in a converted PNG
are composited on white. Preparation is bounded to 64 MiB of input and 40 million
pixels; images that cannot fit receive the measured size and applicable limit.
It never resizes diagrams or falls below quality 0.8 to force acceptance.

Send is blocked during preparation. Conversation/account changes and unmount
abort pending work; late results cannot attach to a different conversation.
Image/document intake still owns count/type validation and object-URL cleanup.
The clipboard snapshot reads each file once and also supports a files-only
clipboard collection.

The standard composer renders thumbnail cards, filenames/sizes and accessible
X removal controls. Progress appears only while uploading. Failed previews
retain the removal action. Draft and saved images share a native modal viewer
with zoom/reset, close, keyboard focus containment, and focus restoration.
The viewer owns Escape/Tab before outer host dialogs' document handlers, so
Escape closes the image without closing chat. Saved-file authorization and
protected downloads remain in their existing adapters.

Both exported stylesheets include the viewer styles, including applications
that bundle styles for CSP and pass `includeStyles={false}`. No new runtime
style element is introduced by individual images.

## Verification

- SDK TypeScript check and build passed.
- 135 focused SDK tests passed across browser intake, clipboard preparation,
  composer, previews, primitives, styled UI and uploader suites.
- Chromium checked compression, retained dimensions, thumbnails, removal,
  saved-image enlargement, zoom, Escape, host capture-handler isolation and
  focus at 320, 390 and 1280 px. See [measurements](qa/attachment-paste-2026-09-15/result.json),
  [phone composer](qa/attachment-paste-2026-09-15/composer-320.png), and
  [desktop viewer](qa/attachment-paste-2026-09-15/viewer-1280.png).
- Mills was compiled/typechecked against the built candidate; 23 focused
  attachment/composer/API/contract tests passed.
- Spartan's 8 attachment/lifetime tests and Hitcents' 13 chat tests passed
  against the built candidate through temporary aliases. These are local
  source checks; dependency manifests and lockfiles were unchanged.

Reproduce with `npm run build` and `node scripts/check-attachment-ui.mjs`.
`HANDRAIL_TEST_CHROMIUM` selects an existing browser executable;
`HANDRAIL_ATTACHMENT_SCREENSHOT_DIR` retains screenshots and measurements.
In this runner, `TMPDIR=/tmp` avoids Chromium's Unix socket path-length limit.

## Adoption status

These are uncommitted source changes. Mills, Spartan and Hitcents remain pinned
to public SDK commit `8cc42d0437de4e0d61e42d1239dfe7abbf911cb9` (0.2.48).
Publishing an authorized SDK commit, updating each app to that full public
HTTPS Git SHA with matching lockfiles, and releasing the apps are separate
steps. No dependency replacement, commit, push, PR or deployment was performed.
