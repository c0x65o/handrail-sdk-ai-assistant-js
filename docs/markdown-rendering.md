# Shared message Markdown

React and Flutter chat surfaces use SDK-owned Markdown components. Applications
provide text, theme, and navigation behavior. They do not provide parsers or GFM
plugins. Legacy and SDK-backed conversation screens can use the same component.

## Format contract

Both renderers support headings, paragraphs, nested ordered/unordered lists,
emphasis, block quotes, links, inline/fenced code, and GFM pipe tables. Tables
support header cells, column alignment, inline formatting, and escaped pipes.
Raw HTML is never executed. User messages retain literal source text. Incomplete
streamed text is accepted on every render; a table becomes a table when its
delimiter row is sufficiently complete. Saving or copying a message retains the
original Markdown. Existing history gains formatting when rendered again.

`test/fixtures/markdown.json` is consumed by both the React and Flutter tests.
The contract is semantic parity, not identical font metrics across platforms.

```markdown
| Asset | Owner | Value |
| :--- | :---: | ---: |
| **Cash** | *Mills* | `$100` |
| Trust \| Reserve | [Details](https://example.com) | $200 |
```

## React

```tsx
import { HandrailMarkdown } from '@handrail/ai-assistant/react/markdown';

<HandrailMarkdown className="application-message" linkMode="same-window">
  {answer}
</HandrailMarkdown>
```

Styled presets use this same component by default. `role="user"` renders literal
text. `linkMode` is `external` by default (absolute HTTP(S) destinations open in a
new tab), `new-window` for all links, `same-window`, or `disabled`. `onLinkClick`
receives only safe destinations and may prevent default navigation to use an app
router. `images` opts into inline image display; attachment rendering is separate.
The component owns table borders, padding, alignment, and a keyboard-focusable
horizontal scroll region. Its `tableLabel` can be localized. Theme colors inherit
from the host; table borders use `--hr-border` when available. No separate CSS
import is required for table sizing and scrolling.

The implementation uses `react-markdown` and `remark-gfm`. These are optional
peers, like React itself, and are required for `react/styled` and `react/markdown`.
Web consumers declare `react-markdown: ^10.1.0` and `remark-gfm: ^4.0.1` and update
their lockfiles. The SDK supplies plugin configuration and all rendering logic.
Core, client, server, and headless imports do not load Markdown or React DOM.
The Git installation's normal prepare/build pipeline compiles SDK exports.

## Flutter

```dart
import 'package:handrail_ai_widgets/handrail_ai_widgets.dart';

HandrailMarkdown(data: answer, selectable: true)
```

The widget owns `flutter_markdown_plus` and `markdown` dependencies and GFM
configuration. `isUserMessage` preserves literal text. `styleSheet` accepts the
re-exported `MarkdownStyleSheet` for app presentation. Tables use intrinsic
columns inside a horizontal scroll view. Links only navigate through a supplied
`onTapLink` callback after the SDK URL policy permits them. Inline images are
disabled so apps retain their separate attachment flow.

## Adoption and validation

Pin Handrail packages to a published, full Git commit SHA over public HTTPS with
matching npm/pub lockfiles. Flutter packages use the repository paths
`flutter/handrail_ai_widgets` and `flutter/handrail_ai_client`. Do not ship a local
path override, vendored candidate, branch/tag pin, or fabricated revision.
The selected revision must actually contain these components before consumers
can install the migration normally.

Run the SDK production build, React Markdown/preset tests, package-boundary
checks, Flutter Markdown tests and analysis, then affected app compilation and
transcript tests. Browser layout validation must check actual table scrolling at
narrow widths, not only the presence of CSS properties. Development source
qualification does not prove that a pinned release has been adopted.


For the standalone browser layout test, install a Playwright Chromium browser and
run `npm run check:markdown-layout`. `HANDRAIL_TEST_CHROMIUM` can select an existing
Chromium executable. `HANDRAIL_MARKDOWN_SCREENSHOT_DIR` optionally saves screenshots
of synthetic fixtures at 320, 390, and 1280 pixels. This test does not open an app,
use app credentials, or bypass a Mobile Preview proxy.
