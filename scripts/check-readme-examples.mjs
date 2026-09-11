import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import path from "node:path";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const read = (relativePath) =>
  readFileSync(path.join(packageRoot, relativePath), "utf8");

assert.doesNotThrow(() => read("dist/index.d.ts"), "build declarations are required");
execFileSync(
  process.execPath,
  [
    path.join(packageRoot, "node_modules/typescript/bin/tsc"),
    "-p",
    path.join(packageRoot, "examples/tsconfig.json"),
  ],
  { cwd: packageRoot, stdio: "inherit" },
);
execFileSync(
  process.execPath,
  [path.join(packageRoot, "scripts/check-protected-web-search-example.mjs")],
  { cwd: packageRoot, stdio: "inherit" },
);

const readme = read("README.md");
const packageJson = JSON.parse(read("package.json"));
const headless = read("examples/headless-runtime.ts");
const trustedServer = read("examples/trusted-server-transports.ts");
const protectedWebSearch = read("examples/protected-web-search.mjs");
const reactPresentations = read("examples/react-presentations.tsx");
const composerSource = read("src/react/use-conversation-composer.ts");

const referencedExamplePaths = [...new Set(
  [...readme.matchAll(/\]\(\.\/(examples\/[^)#?]+)\)/gu)]
    .map((match) => match[1]),
)];
assert.ok(referencedExamplePaths.length > 0, "README links checked examples");
const referencedExamples = referencedExamplePaths.map((relativePath) => {
  assert.match(
    relativePath,
    /^examples\/[^/]+\.(?:ts|tsx|mjs)$/u,
    `README example link stays inside the checked examples directory: ${relativePath}`,
  );
  return [relativePath, read(relativePath)];
});

for (const [exportPath, conditions] of Object.entries(packageJson.exports)) {
  const packageEntry = exportPath === "."
    ? "@handrail/ai-assistant"
    : `@handrail/ai-assistant/${exportPath.slice(2)}`;
  assert.match(
    readme,
    new RegExp(
      "^\\| `" + packageEntry.replaceAll("/", "\\/") + "` \\|",
      "mu",
    ),
    `README supported-entry table documents ${packageEntry}`,
  );
  assert.doesNotThrow(
    () => read(conditions.types.replace(/^\.\//u, "")),
    `${packageEntry} built declaration exists`,
  );
}

for (const lifecycleApi of [
  "createConversationRuntime",
  "restoreActiveTurn",
  "resumeTurn",
  "observe",
  "sendMessage",
  "stopObserving",
  "cancelTurn",
  "destroy",
  "BoundedToolExecutor",
  "runToolLoop",
  "NormalizedUsageReceipt",
]) {
  assert.ok(readme.includes(lifecycleApi), `README documents ${lifecycleApi}`);
  assert.ok(headless.includes(lifecycleApi), `headless example checks ${lifecycleApi}`);
}

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
const assertDeclarationApis = (label, declarationPaths, apiNames) => {
  const declarations = declarationPaths.map(read).join("\n");
  for (const apiName of apiNames) {
    assert.match(
      declarations,
      new RegExp(`\\b${escapeRegex(apiName)}\\b`, "u"),
      `${label} publicly declares ${apiName}`,
    );
    assert.ok(readme.includes(`\`${apiName}\``), `README documents ${apiName}`);
  }
};

const rootBarrel = read("dist/index.d.ts");
for (const moduleName of [
  "attachments/index.js",
  "citations.js",
  "conversation/index.js",
  "provider-context-checkpoint-store.js",
  "provider-context.js",
  "realtime/index.js",
  "transcription.js",
  "web-search.js",
]) {
  assert.ok(rootBarrel.includes(moduleName), `root entry exports ${moduleName}`);
}

assertDeclarationApis(
  "attachment lifecycle",
  [
    "dist/protocol.d.ts",
    "dist/attachments/uploader.d.ts",
    "dist/providers/index.d.ts",
    "dist/browser/attachments.d.ts",
    "dist/react/use-conversation-composer.d.ts",
  ],
  [
    "AttachmentReference",
    "AttachmentUploader",
    "ProviderModelCapabilities",
    "intakeFileInputPdfs",
    "intakeDroppedPdfs",
    "attachmentIntake",
    "imageIntake",
  ],
);
assertDeclarationApis(
  "citation lifecycle",
  ["dist/citations.d.ts", "dist/react/citations.d.ts"],
  ["CitationSource", "CitationRecordSet", "CitationList", "CitationItem"],
);
assertDeclarationApis(
  "provider-context lifecycle",
  [
    "dist/provider-context.d.ts",
    "dist/provider-context-checkpoint-store.d.ts",
    "dist/runtime.d.ts",
    "dist/providers/openai-context.d.ts",
  ],
  [
    "ProviderContextCapability",
    "ProviderContextCheckpointStore",
    "InMemoryProviderContextCheckpointStore",
    "ConversationRuntimeProviderContextOptions",
    "createOpenAIProviderContextCapability",
  ],
);
assertDeclarationApis(
  "conversation catalog lifecycle",
  [
    "dist/conversation/catalog.d.ts",
    "dist/conversation/in-memory-catalog.d.ts",
    "dist/conversation/runtime-registry.d.ts",
    "dist/conversation/title-generation.d.ts",
    "dist/react/conversation-picker.d.ts",
  ],
  [
    "ConversationCatalog",
    "InMemoryConversationCatalog",
    "ConversationTitleGenerationService",
    "ConversationRuntimeRegistry",
    "ConversationPickerRoot",
    "useConversationPicker",
  ],
);
assertDeclarationApis(
  "durable approval lifecycle",
  [
    "dist/conversation/approval-proposal-store.d.ts",
    "dist/conversation/approval-coordinator.d.ts",
    "dist/tools/approval-execution.d.ts",
    "dist/react/approval-review.d.ts",
  ],
  [
    "ApprovalProposalStore",
    "InMemoryApprovalProposalStore",
    "createApprovalCoordinator",
    "createApprovalExecutionCoordinator",
    "ApprovalReviewRoot",
    "useApprovalReview",
  ],
);
assertDeclarationApis(
  "transcription lifecycle",
  [
    "dist/transcription.d.ts",
    "dist/browser/audio.d.ts",
    "dist/react/transcription.d.ts",
    "dist/providers/openai-transcription.d.ts",
  ],
  [
    "TranscriptionCapability",
    "createBrowserAudioCaptureController",
    "intakeBrowserAudio",
    "TranscriptionControlsRoot",
    "createOpenAITranscriptionCapability",
  ],
);
assertDeclarationApis(
  "realtime voice lifecycle",
  [
    "dist/realtime/session.d.ts",
    "dist/realtime/tool-bridge.d.ts",
    "dist/browser/realtime-voice.d.ts",
    "dist/react/realtime-voice.d.ts",
    "dist/providers/openai-realtime.d.ts",
  ],
  [
    "createBrowserRealtimeVoiceController",
    "createIdempotentRealtimeVoiceSessionAuthority",
    "createRealtimeVoiceServerToolBridge",
    "RealtimeVoiceControlsRoot",
    "createOpenAIRealtimeServer",
  ],
);
assertDeclarationApis(
  "web-search and trusted-server lifecycle",
  ["dist/web-search.d.ts", "dist/server/trusted-server.d.ts"],
  [
    "WebSearchService",
    "createWebSearchCitationRecords",
    "createWebSearchToolRegistration",
    "TRUSTED_SERVER_REQUEST_PROTECTION_VERSION",
    "createTrustedServerRequestProtectorV1",
  ],
);

assert.doesNotMatch(readme, /currently scaffolded|will be added separately/iu);
assert.match(
  readme,
  /Browser\s+and mobile code must call that application server\./u,
);
assert.match(
  readme,
  /Never put provider\s+credentials, managed tokens, or authorization headers in client code/iu,
);

const readmeInvariants = [
  ["generalized browser attachment intake", /@handrail\/ai-assistant\/browser[^\n]*generalized image\/document attachment intake/iu],
  ["negotiated document capability", /Document behavior is negotiated, never inferred/iu],
  ["OpenAI document opt-in", /OpenAI[^\n]*explicitly configured protocol document MIME subset[^\n]*trusted host[^\n]*resolve_document_reference[^\n]*otherwise unsupported/iu],
  ["non-OpenAI document support is explicit", /(?:Anthropic|Gemini|xAI)[^\n]*Explicitly unsupported by the built-in adapter/iu],
  ["canonical history is preserved", /provider-context checkpoints never replace, truncate[\s\S]{0,180}canonical conversation history/iu],
  ["provider-context fingerprints and invalidation", /fingerprint covers[\s\S]{0,400}invalidates the checkpoint/iu],
  ["provider-context retry and cancellation boundaries", /Stable idempotency keys[\s\S]{0,260}same abort signal/iu],
  ["storage-neutral catalog", /ConversationCatalog[^\n]*storage-neutral lifecycle contract/iu],
  ["catalog requires no database", /without requiring a database/iu],
  ["in-memory catalog is non-durable", /InMemoryConversationCatalog[\s\S]{0,120}non-durable/iu],
  ["one runtime per open conversation", /one `ConversationRuntime` per open conversation/iu],
  ["approval lifecycle statuses", /`pending`, `confirmed`, `rejected`, `expired`,\s*`executing`, `executed`, and `failed`/iu],
  ["model output cannot authorize side effects", /Model output and tool discovery never authorize side effects/iu],
  ["credentials and realtime tools stay off clients", /Credentials\s+and realtime server-side tool execution must stay off clients/iu],
  ["authoritative realtime hangup", /authoritative hangup[\s\S]{0,260}cleanup safe to repeat/iu],
  ["web search is host operated", /SDK does not operate, deploy, or credential an external search provider/iu],
  ["web-search URL policy and deduplication", /validates every[\s\S]{0,320}deterministically deduplicates/iu],
  ["trusted-server contract is versioned", /TRUSTED_SERVER_REQUEST_PROTECTION_VERSION/iu],
  ["host owns infrastructure", /Deployment, file\/object storage, authentication implementation, provider\s+credentials, external-service operation, databases[\s\S]{0,180}remain host-owned/iu],
  ["sensitive durable metadata is prohibited", /Durable metadata[\s\S]{0,260}must not retain binary image\/document\s+contents, audio, transcripts, prompts, credentials, hidden instructions/iu],
  ["sensitive logging is prohibited", /Do not log any of the sensitive values listed above/iu],
  ["React remains optional and unstyled", /React entry is optional and unstyled[\s\S]{0,80}core remains React-free/iu],
];
for (const [label, invariant] of readmeInvariants) {
  assert.match(readme, invariant, `README states ${label}`);
}

assert.match(
  readme,
  /When both options are supplied,\s*`attachmentIntake` takes precedence/iu,
  "README documents attachmentIntake precedence",
);
assert.match(
  readme,
  /When `attachmentIntake` is omitted[\s\S]{0,120}`imageIntake` behavior remains available/iu,
  "README documents source-compatible imageIntake fallback",
);
assert.match(composerSource, /const generalizedIntake = options\.attachmentIntake \?\? \(options\.imageIntake === undefined \? \{\} : undefined\);/u);
assert.match(composerSource, /generalizedIntake === undefined/u);
assert.match(composerSource, /options\.imageIntake/u);

for (const providerPath of [
  "src/providers/anthropic.ts",
  "src/providers/gemini.ts",
  "src/providers/xai.ts",
]) {
  const providerSource = read(providerPath);
  assert.match(providerSource, /document_input: \{ supported: false \}/u);
  assert.match(providerSource, /PROVIDER_CONTEXT_NOT_SUPPORTED/u);
}
const openaiSource = read("src/providers/openai.ts");
assert.match(openaiSource, /document_input\?: DocumentInputCapabilityDescriptor/u);
assert.match(openaiSource, /resolve_document_reference/u);
assert.match(openaiSource, /createOpenAIProviderContextCapability/u);

for (const contradiction of [
  /\b(?:Anthropic|Gemini|xAI)\b[^\n]{0,100}\b(?:supports|supported)\b[^\n]{0,60}\b(?:PDF|document|provider-context)/iu,
  /\bOpenAI\b[^\n]{0,80}\b(?:always|unconditionally|by default)\b[^\n]{0,80}\b(?:PDF|document|provider-context)/iu,
  /provider-context checkpoints?[^.\n]{0,100}\b(?:may|can|does|will)\s+(?:replace|truncate|delete)\b[^.\n]{0,80}canonical/iu,
  /SDK\s+(?:operates|hosts|deploys|credentials)\s+(?:an?\s+)?external search provider/iu,
]) {
  assert.doesNotMatch(readme, contradiction, "README contains no capability or ownership contradiction");
}

for (const [label, contents] of [["README.md", readme], ...referencedExamples]) {
  assert.doesNotMatch(contents, /\bbearer\s+[a-z0-9._~+/=-]{8,}/iu, `${label} has no bearer value`);
  assert.doesNotMatch(contents, /(?:^|[^a-z0-9])sk-[a-z0-9_-]{8,}\b/imu, `${label} has no key-like value`);
  assert.doesNotMatch(
    contents,
    /-----begin (?:[a-z0-9]+ )*private key-----/iu,
    `${label} has no private key material`,
  );
  assert.doesNotMatch(
    contents,
    /\b(?:api[_-]?key|private[_-]?key|access[_-]?token|client[_-]?secret)\s*[:=]\s*["'][a-z0-9._~+/=-]{8,}["']/iu,
    `${label} has no assigned key-like value`,
  );
  assert.doesNotMatch(
    contents,
    /\b(?:kubectl|helm|terraform|pulumi|flyctl|vercel|netlify)\s+(?:apply|deploy|install|up|push)\b/iu,
    `${label} has no live deployment instruction`,
  );
  assert.doesNotMatch(
    contents,
    /\bcurl\s+(?:-[a-z]+\s+)*https?:\/\//iu,
    `${label} has no live external-operation instruction`,
  );
  assert.doesNotMatch(
    contents,
    /\b(?:must|required|only|depends on|requires)\b[^.\n]{0,80}\b(?:Express|Fastify|Next\.js|NestJS|Koa|Hono)\b/iu,
    `${label} does not mandate a web framework`,
  );
  assert.doesNotMatch(
    contents,
    /\b(?:durable metadata|logs?|telemetry)\b[^.\n]{0,50}\b(?:may|can|should|must|does|will)\s+(?:store|retain|record|include|log)\b[^.\n]{0,80}\b(?:prompts?|transcripts?|audio|credentials?|hidden instructions?|tool (?:inputs?|results?)|provider-native)/iu,
    `${label} has no unsafe retention or logging claim`,
  );
}

for (const [relativePath, contents] of referencedExamples.filter(
  ([relativePath]) => !relativePath.includes("trusted-server") &&
    !relativePath.includes("protected-web-search") &&
    !relativePath.includes("golden-authenticated-app") &&
    !relativePath.includes("spartan-aegis-high-level"),
)) {
  assert.doesNotMatch(
    contents,
    /from\s+["']@handrail\/ai-assistant\/(?:providers|server)\//u,
    `${relativePath} does not import trusted-server code into a client/runtime-neutral recipe`,
  );
  assert.doesNotMatch(
    contents,
    /\b(?:apiKey|api_key|managedToken|managed_token|providerCredential|provider_credential)\s*:/u,
    `${relativePath} contains no client credential property`,
  );
}

for (const [relativePath, contents] of referencedExamples.filter(
  ([relativePath]) => relativePath.includes("react-"),
)) {
  assert.doesNotMatch(
    contents,
    /\b(?:createRealtimeVoiceServerToolBridge|createApprovalExecutionCoordinator|createDirectProviderTransport)\b/u,
    `${relativePath} contains no trusted-server execution constructor`,
  );
}

for (const clientOnlyBoundary of [
  /authorization/iu,
  /getHeaders/u,
  /api[_-]?key/iu,
  /managed[_-]?token/iu,
]) {
  assert.doesNotMatch(
    headless,
    clientOnlyBoundary,
    "runtime-neutral headless example contains no client credential plumbing",
  );
}

assert.match(trustedServer, /createDirectProviderTransport/u);
assert.match(trustedServer, /createManagedRuntimeTransport/u);
assert.match(protectedWebSearch, /createTrustedServerRequestProtectorV1/u);
assert.match(protectedWebSearch, /WebSearchService/u);
assert.match(protectedWebSearch, /@handrail\/ai-assistant\/server\/trusted-server/u);
assert.doesNotMatch(protectedWebSearch, /\bfetch\s*\(/u);

for (const recipe of [
  "ChatDialogRecipe",
  "ChatTabsRecipe",
  "ChatDrawerRecipe",
  "ChatLauncherRecipe",
  "FullPageChatRecipe",
  "CustomHooksChatRecipe",
]) {
  assert.ok(reactPresentations.includes(recipe), `React example checks ${recipe}`);
  assert.ok(readme.includes(recipe), `README documents ${recipe}`);
}

assert.doesNotMatch(reactPresentations, /import\s+["'][^"']+\.(?:css|scss|sass|less)["']/u);
assert.doesNotMatch(reactPresentations, /<style\b|document\.(?:body|documentElement)\.style/iu);
