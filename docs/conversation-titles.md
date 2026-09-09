# SDK-owned conversation titles

`createHandrailAssistant` owns automatic title generation as soon as a durable turn
has saved user text. This does not depend on Send, Enter, an open browser, or the client
implementation. Reading the catalog also checks imported
conversations that still have a placeholder title.

The default `openaiResponses({ model })` provider supplies a separate Responses
API call for titles. It uses capped user text, a short SDK-owned title prompt,
and the configured model. It sends no conversation tools, hosted search,
attachments, continuation data, or domain/system instructions. Both ordinary
text deltas and final output text are accepted without duplicating them.
The host continues to provide its authorized model and credential configuration.

## Configuration

New SDK catalogs leave an untitled conversation's title null. For existing
catalogs, configure the labels that mean “not named yet”:

```ts
const assistant = await createHandrailAssistant({
  // Existing authorization, provider, persistence, and usage configuration...
  automaticTitles: { placeholderTitles: ["New thread"] },
});
```

Automatic generation is enabled when `provider.generateTitle` exists.
`openaiResponses` supplies it without additional host code. A custom provider
implements that hook, returning text from `input.context.userTexts` and using
`input.signal`. Call `input.recordUsage(usage, status)` when reported provider
usage is available; otherwise the SDK records explicit unavailable token usage.
The SDK supplies authenticated context separately from model-visible title text.
Do not rename the catalog, schedule generation, or implement usage HTTP calls
inside the hook. The old `titleGeneration` endpoint override is retained for
compatibility; it does not replace the provider hook for automatic generation.

`automaticTitles: false` disables server automatic generation.
`timeoutMilliseconds` defaults to 30,000 and may be configured from 1 to 300,000.
Catalogs must support authorized optimistic `rename` operations. Existing named
or archived conversations are preserved, including manual changes made while
the model is generating a title.

## React surfaces

`HandrailAssistantLauncher` already uses the shared title observer. Custom React
and React Native presentations use the same hook from `react` or
`react/headless`:

```tsx
useConversationTitles({
  client,
  placeholderTitles: ["New thread"],
  onTitle: refreshConversationLabel,
});
```

The hook watches every loaded running or completed conversation, independent of the
selected thread and submit method. It refreshes the saved title and retains a
compatibility catalog write for older gateways that only return generated text.
It re-reads the catalog before writing so a server-persisted or manually renamed
title is not overwritten. `enabled: false` (or the launcher's `autoTitle={false}`)
disables this client observer, not server-owned generation.

Other clients read the same saved catalog title. They do not need to implement
generation or persistence; their normal catalog refresh determines when the new
label appears.

## Persistence and failures

The SDK authorizes catalog access before reading user text or joining pending
work. Concurrent requests within one server share a promise. A scoped durable
provider-operation claim prevents a second server from dispatching the same
operation. Its identity includes the assistant, tenant, scope, conversation,
and latest admitted turn. Running and completed observations of the same turn
share an operation identity. Completed generated results survive a failed catalog write
and can be persisted after restart without a second provider call.

The SDK uses the existing provider-operation store's uncertainty policy: an
operation that started but has no durable completed result is not blindly
dispatched again for that turn. A later turn has a new identity and
can try again; reconciling an uncertain operation remains an explicit operation.
The existing title stays visible, and title failures are diagnostic-only. Usage
admission and durable receipts are separate from the answer's invocation and
contain no prompt or transcript text.

## Mills and Spartan adoption

Both app manifests pin `135ac5ab541b124ddd78b65a4c69d6fcb0008b41`, which includes
completion-triggered titles. The running-turn trigger in this checkout requires
a new immutable SDK commit and matching consumer lockfiles before deployment.
Do not point application dependencies at an uncommitted checkout or branch.

Spartan's adapter uses the SDK Responses title provider and shared React title
observer. Its existing authorized catalog rename adapter remains the domain
persistence seam. The legacy gateway keeps its separate compatibility path.

Mills still uses a custom provider without a title hook, and its retained
household catalog reports rename unsupported. That integration needs a title
provider hook and an authorized optimistic rename implementation before server
automatic titles can apply there. Standard SDK catalogs and `openaiResponses`
providers supply these capabilities by default.

Verify running turns from Enter and Send, reopened placeholders, manual
rename/archive races, provider failure, and separate usage receipts before
consumer deployment.
