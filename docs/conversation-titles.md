# SDK-owned conversation titles

`createHandrailAssistant` owns automatic title generation after a durable turn
completes. This does not depend on Send, Enter, an open browser, or the client
implementation. Reading the catalog also checks completed imported
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

The hook watches every loaded completed conversation, independent of the
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
and completed turn. Completed generated results survive a failed catalog write
and can be persisted after restart without a second provider call.

The SDK uses the existing provider-operation store's uncertainty policy: an
operation that started but has no durable completed result is not blindly
dispatched again for that turn. A later completed turn has a new identity and
can try again; reconciling an uncertain operation remains an explicit operation.
The existing title stays visible, and title failures are diagnostic-only. Usage
admission and durable receipts are separate from the answer's invocation and
contain no prompt or transcript text.

## Mills and Spartan adoption

This change is an SDK source candidate. Both app manifests currently pin
`b70bb1c000ac7710ebbc12538635ac86a401cf30`; those installations do not include it.
Do not point an application dependency at an uncommitted checkout, a branch,
or a local package. After the SDK has an approved immutable commit, update the
public HTTPS Git SHA and matching lockfile through the normal install/build
pipeline, then make these adapter changes together:

- Spartan: supply the title provider through the high-level provider, configure
  `New thread` as a placeholder, replace the local completion/title effect with
  `useConversationTitles`, and remove the high-level `titleGeneration` override
  and duplicated title usage orchestration. Its existing authorized catalog
  `rename` adapter remains the domain persistence seam.
- Mills: supply the title provider and implement the retained household catalog's
  authorized optimistic `rename` operation (it currently reports unsupported).
  Keep the standard launcher, which already owns the client observer. Configure
  the retained catalog's placeholder label if it differs from `New conversation`.

Keep the existing consumer behavior until its SDK pin is advanced; removing
host callbacks while it still runs the old SDK would reintroduce missing titles.
Verify completed turns from Enter, Send, and mobile; reopened placeholders;
manual rename/archive races; tenant isolation; provider failure; and separate
usage receipts through each mounted high-level gateway before deployment.
