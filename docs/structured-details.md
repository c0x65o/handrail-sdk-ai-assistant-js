# Readable approval and tool details

The standard React approval card, DOM approval review primitives and typed JSON
tool results display labeled fields and nested numbered lists. They do not dump
JSON into the transcript. Flutter's standard approval card uses the equivalent
`HandrailStructuredDetails` widget from the declared Flutter SDK repository.

Labels split snake case and camel case. Values remain literal and selectable:
amounts are not rounded, units are not inferred, strings are not interpreted as
HTML or links, and no fields are summarized or silently truncated. Booleans read
as Yes/No; null, empty strings, arrays and objects have explicit empty states.
Descriptions and long identifiers wrap within the available width. Keyboard
focus and approval decision controls remain available.

Custom business cards should use the same formatter **after** their existing
server-authorized review and binding checks:

```tsx
import { StructuredDetails } from '@handrail/ai-assistant/react';

// review is the existing authorized, validated review, not arbitrary tool input.
<StructuredDetails aria-label="Saved change details" value={review.arguments} />
```

The formatter does not load a review, decide permission, approve a proposal or
change its argument binding. Keep incomplete/redacted-review restrictions,
financial disclosures, version checks and decision receipts in their existing
controllers. Custom result renderers remain supported for domain-specific cards.
Ordinary assistant text and requested code examples keep their existing rendering.

`handrailChatPresetCss` includes `HANDRAIL_STRUCTURED_DETAILS_CSS`; applications
bundling the preset CSS at build time automatically get the layout after upgrading.
DOM consumers without the preset can bundle that exported CSS separately. Scope
host metadata `dl` selectors to their own elements so they do not override nested
SDK fields.

## Adoption and qualification

Public source baselines verified during this change:

- JS: `007f88c2723c6d1e9ef89cbb2cb1c46f0dab4c96` (0.2.39).
- Flutter: `7ef5795a823b282ee53dc08951ada1817be11c24` (widgets 0.1.1; client 0.1.10).

Use these public HTTPS Git revisions with matching package-manager locks and
normal SDK compilation during installation. A source update is not an app rollout.
Cents uses the standard cards. Aegis and Mills have retained business review
cards that must also delegate their detail values to this formatter; Mills mobile
has a retained proposal card with the same requirement.

The reusable browser layout check is:

```sh
npm run build
node scripts/check-structured-details-layout.mjs
```

It checks light/dark layouts at 320, 390 and 1280 pixels, long values, larger text,
and keyboard expansion of the review. `HANDRAIL_TEST_CHROMIUM` optionally selects
a local Chromium executable; `HANDRAIL_DETAILS_SCREENSHOT_DIR` saves images and a
report. This is an isolated synthetic component check, not a live financial action.

### September 14 installed-consumer validation

All three web consumers now normally install JS 0.2.39 at the full SHA above;
all three mobile consumers install both Flutter packages from the matching
declared sibling revision. Manifest, root lock, installed lock/package config
and normal compiled SDK output were checked. The static adoption command passed
for all three web hosts. No source aliases or local SDK dependencies were used.

| Scope | Passing focused tests | Typed/layout checks |
| --- | ---: | --- |
| JS SDK approvals, details and primitives | 47 | Typecheck, normal build and scoped lint |
| Flutter SDK details and approvals | 6 | Scoped analysis; 320/800px with large text |
| Cents web | 13 | Browser TypeScript |
| Aegis web | 13 | Scoped assistant UI TypeScript |
| Mills web | 15 | Full TypeScript; tests with `NODE_ENV=test` |
| Cents mobile | 29 | Installed-package widget/test compilation |
| Aegis mobile | 15 | Installed-package widget/test compilation |
| Mills mobile | 28 | Installed-package compilation and scoped analysis |

The shared browser fixture also passed six light/dark layouts, long-token and
large-text wrapping, and keyboard expansion checks. Images/report are at
`/tmp/handrail-structured-details-2767c635/` in this workspace.
The apps' custom Aegis/Mills detail renderers are wired to the installed shared
components; their existing exact-binding, incomplete-review, role and financial
authorization tests pass. The raw UI JSON scan has no remaining approval-detail
fallbacks in these consumers; protocol serialization and ordinary message/code
rendering are intentionally separate.

These are local source and installed-package results. App rollout is still
pending; this interactive change did not authorize or perform app commits,
pushes, PRs or deployments. No production data or approval permissions changed.
The broader assistant cleanup goal remains a separate blocked rollout effort.
