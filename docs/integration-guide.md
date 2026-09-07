# Integration guide

The recommended production shape has one authenticated application gateway and
one of three client presentations. Provider credentials, authoritative user
identity, profile lookup, tool permissions, and persistence remain on the
application server.

## Choose a client path

| Need | Configuration | UI import |
| --- | --- | --- |
| Custom web/native UI or no UI | `conversations: { mode: "single", ... }` or `mode: "multiple"` | none or `@handrail/ai-assistant/react/headless` |
| One ready-made web chat | `conversations: { mode: "single", ... }` | `@handrail/ai-assistant/react/styled` |
| Thread picker and background turns | `conversations: { mode: "multiple", ... }` | `@handrail/ai-assistant/react/styled` |

The checked, credential-free golden path is split by deployment boundary:

- [`golden-authenticated-app.ts`](../examples/golden-authenticated-app.ts) is
  the trusted gateway, server-owned assistant context, catalog, and in-process
  Fetch adapter.
- [`golden-headless-client.ts`](../examples/golden-headless-client.ts) sends a
  complete authenticated turn without React.
- [`golden-styled-single.tsx`](../examples/golden-styled-single.tsx) renders the
  same client as one styled conversation.
- [`golden-styled-multiple.tsx`](../examples/golden-styled-multiple.tsx) enables
  the picker, independently running threads, and unread/error launcher state.

Replace the example bearer verifier, application data lookup, provider
transport, persistence, and in-process Fetch adapter. The client/UI shape does
not otherwise change when the gateway moves to HTTPS.

## Identity and context

Use `createAssistantGatewayAuthorizer` from
`@handrail/ai-assistant/server/assistant-context`. It deliberately separates:

1. `principal`: authenticated server identity used by gateway authorization;
2. `attribution`: authoritative organization/project/environment/user/session
   identifiers emitted in protocol events;
3. `model`: only instructions and profile fields intentionally disclosed to
   the model;
4. `tools`: server-only authorization and execution context;
5. `presence`: optional ephemeral UI identity; and
6. `clientCorrelationHints`: explicitly untrusted values that never become
   attribution, tool authority, or model context.

Resolve the principal from a verified session or token and load the remaining
fields from authoritative application storage. Never copy a principal, tenant,
role, permission, plan, or profile from the turn request body. For adapters
with an instructions option, `serverAssistantInstructions(context)` renders
only the explicitly model-visible section. Applications still own redaction
and must not place credentials, secrets, or unnecessary personal data there.

## Single and multiple conversations

`createHandrailAiClient({ conversations: { mode: "single", ... } })` creates
`client.conversation` directly. It does not construct a catalog registry or
workspace. This is the shortest path for a fixed support/copilot surface.

`mode: "multiple"` creates `client.registry` and `client.workspace`. Switching
threads does not stop another thread's turn; completion and errors update the
workspace and launcher badge. Production multi-device history additionally
requires the gateway synchronization capability or a host-owned durable event
store/sync coordinator.

The older `runtime`, `createRuntime`, and `authorizeRuntime` options remain
supported. Do not combine them with `conversations`; migrate one client at a
time to the explicit mode.

For an endpoint-driven assistant that should show only the current conversation,
set `conversationPicker={false}` on `HandrailAssistantLauncher` (or
`HandrailChatWorkspace`). This removes both New and Threads, including their
catalog controls, while keeping conversation restoration, messages, uploads,
and voice controls active. Omit the prop to use the default thread picker.

## Theme contract

`HandrailChatTheme` supports `mode: "light" | "dark" | "system"` and typed
tokens. `theme` values become stable CSS properties, and a component's explicit
`style` values take final precedence.

| Token | CSS property |
| --- | --- |
| `colors.accent` | `--hr-accent` |
| `colors.background` | `--hr-bg` |
| `colors.panel` | `--hr-panel` |
| `colors.text` | `--hr-text` |
| `colors.muted` | `--hr-muted` |
| `colors.border` | `--hr-border` |
| `colors.danger` | `--hr-danger` |
| `colors.activity` | `--hr-activity` |
| `radii.panel` | `--hr-radius-panel` |
| `radii.message` | `--hr-radius-message` |
| `radii.control` | `--hr-radius-control` |
| `fontFamily` | `--hr-font` |

Applications can continue using CSS variables/classes, `className`, `style`,
message/attachment/tool renderers, the unstyled primitives, or headless hooks.
The styled preset's safe Markdown subset covers headings, paragraphs, lists,
links, inline code, and fenced code without installing a Markdown/React parser
for headless consumers. Use `renderMessageContent` for a richer host-owned
renderer.

Tool results appear in the styled transcript only when a matching renderer is
registered through `rendererPlugins`. Unregistered results remain available to
the runtime and tool activity; the styled UI does not dump their JSON into an
assistant message. Intentional code blocks in assistant Markdown still render.

### Saved image attachments

React presets render attachment cards even when filenames are absent. Supply
`resolveAttachmentUrl(attachment, message, conversationId)` to resolve the saved
attachment ID through your authenticated content route; never treat an opaque ID
as a URL. The third argument supplies the selected canonical conversation, so a
preview also works after a reload or a send from another device. The exported
`MessageAttachmentPreview` renders the same card in custom transcripts and keeps
an open action when image loading fails. Hosts using bearer authorization can
fetch bytes with their protected transport, provide an object URL, and revoke it
when the preview is released.

Flutter hosts can use `HandrailAttachmentPreview` from `handrail_ai_widgets` with
an account/conversation-scoped `attachmentId`, `label`, `mediaType`, and an
asynchronous `loadBytes` callback. Keep authorization in that callback. The widget
ignores responses after disposal or a change of attachment scope and presents
loading, preview, and retry states without leaking server errors. `onOpen` lets
the host open its document viewer.

Both clients should retain canonical attachment messages if execution fails
before an application-specific history mirror is written. Reconcile using
attachment identity; polling or loading history must never resubmit a failed
request. Ready uploads remain subject to the host's conversation ownership,
retention, and content validation rules.
