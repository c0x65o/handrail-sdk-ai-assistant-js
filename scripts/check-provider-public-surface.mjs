import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { stdout } from "node:process";
import { URL, fileURLToPath } from "node:url";

const distDirectory = fileURLToPath(new URL("../dist", import.meta.url));

function declarationFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory()
      ? declarationFiles(path)
      : entry.name.endsWith(".d.ts")
        ? [path]
        : [];
  });
}

const files = declarationFiles(distDirectory);
assert(files.length > 0, "build declarations before checking the public surface");

const runtimeNeutralFiles = files.filter(
  (path) =>
    !/[\\/]browser[\\/]/u.test(path) &&
    !/[\\/]client[\\/]/u.test(path) &&
    !/[\\/]react[\\/]/u.test(path) &&
    !/[\\/]react-headless[\\/]/u.test(path) &&
    !/[\\/]react-styled[\\/]/u.test(path) &&
    !/[\\/]react-markdown[\\/]/u.test(path) &&
    !/[\\/]server[\\/]/u.test(path) &&
    !/[\\/](?:mcp|postgres)[\\/]/u.test(path) &&
    !/[\\/]presence[\\/]live-delivery\.d\.ts$/u.test(path) &&
    !/[\\/]sync[\\/]http\.d\.ts$/u.test(path) &&
    !/[\\/]transports[\\/](?:application-gateway|managed-runtime|sse)\.d\.ts$/u.test(path) &&
    !/[\\/]providers[\\/](?!index\.d\.ts$)[^\\/]+\.d\.ts$/u.test(path),
);
const browserDeclarationFiles = files.filter((path) => /[\\/]browser[\\/]/u.test(path));
const reactDeclarationFiles = files.filter((path) => /[\\/](?:react|react-headless|react-styled|react-markdown)[\\/]/u.test(path));
const runtimeNeutralDeclarations = runtimeNeutralFiles
  .map((path) => readFileSync(path, "utf8"))
  .join("\n");
const runtimeNeutralDeclarationCode = runtimeNeutralDeclarations
  .replace(/\/\*[\s\S]*?\*\//gu, "")
  .replace(/\/\/[^\n]*/gu, "");
const browserAndReactDeclarationCode = [
  ...browserDeclarationFiles,
  ...reactDeclarationFiles,
]
  .map((path) => readFileSync(path, "utf8"))
  .join("\n")
  .replace(/\/\*[\s\S]*?\*\//gu, "")
  .replace(/\/\/[^\n]*/gu, "");
const packageEntry = readFileSync(join(distDirectory, "index.d.ts"), "utf8");
const openAIEntry = readFileSync(
  join(distDirectory, "providers", "openai.d.ts"),
  "utf8",
);
const openAIContextEntry = readFileSync(
  join(distDirectory, "providers", "openai-context.d.ts"),
  "utf8",
);
const openAITranscriptionEntry = readFileSync(
  join(distDirectory, "providers", "openai-transcription.d.ts"),
  "utf8",
);
const openAIRealtimeEntry = readFileSync(
  join(distDirectory, "providers", "openai-realtime.d.ts"),
  "utf8",
);
const anthropicEntry = readFileSync(
  join(distDirectory, "providers", "anthropic.d.ts"),
  "utf8",
);
const geminiEntry = readFileSync(
  join(distDirectory, "providers", "gemini.d.ts"),
  "utf8",
);
const xaiEntry = readFileSync(
  join(distDirectory, "providers", "xai.d.ts"),
  "utf8",
);
const managedEntry = readFileSync(
  join(distDirectory, "server", "managed.d.ts"),
  "utf8",
);
const trustedServerEntry = readFileSync(
  join(distDirectory, "server", "trusted-server.d.ts"),
  "utf8",
);

assert.match(
  packageEntry,
  /export \* from ["']\.\/providers\/index\.js["'];/,
  "the package entry point must export the provider adapter contract",
);
assert.match(
  packageEntry,
  /export \* from ["']\.\/transports\/index\.js["'];/,
  "the package entry point must export the conversation transport contract",
);
assert.match(
  packageEntry,
  /export \* from ["']\.\/provider-context\.js["'];/,
  "the package entry point must export only the provider-neutral context contract",
);
assert.match(
  packageEntry,
  /export \* from ["']\.\/realtime\/index\.js["'];/,
  "the package entry point must export the provider-neutral realtime voice contract",
);
assert.match(
  packageEntry,
  /export \* from ["']\.\/transcription\.js["'];/,
  "the package entry point must export the provider-neutral transcription contract",
);
assert.match(
  runtimeNeutralDeclarationCode,
  /type:\s*["']response\.citation_batch["']/,
  "the provider-neutral protocol must declare citation batch stream events",
);
assert.match(
  runtimeNeutralDeclarationCode,
  /citation_projection\??:\s*ProviderCitationProjectionCapability/,
  "the provider contract must declare citation projection support",
);
assert.match(
  packageEntry,
  /export \* from ["']\.\/web-search\.js["'];/,
  "the package entry point must export the provider-neutral web-search contract",
);
assert.match(
  openAIEntry,
  /export declare (?:class OpenAIProviderAdapter|function createOpenAIProviderAdapter)/,
  "the opt-in OpenAI entry must export its provider adapter",
);
assert.match(
  openAIEntry,
  /export \* from ["']\.\/openai-context\.js["'];/,
  "the opt-in OpenAI entry must export its SDK-independent context boundary",
);
assert.match(
  openAIEntry,
  /export \* from ["']\.\/openai-transcription\.js["'];/,
  "the opt-in OpenAI entry must export its trusted-server transcription boundary",
);
assert.match(
  openAIContextEntry,
  /export declare function createOpenAIProviderContextCapability/,
  "the opt-in OpenAI context boundary must expose capability construction",
);
assert.match(
  openAITranscriptionEntry,
  /export declare function createOpenAITranscriptionCapability/,
  "the opt-in OpenAI transcription boundary must expose capability construction",
);
assert.match(
  openAITranscriptionEntry,
  /export declare const OPENAI_TRANSCRIPTION_LIMITS/,
  "the opt-in OpenAI transcription boundary must expose its limits",
);
assert.match(
  openAIRealtimeEntry,
  /export declare function createOpenAIRealtimeServer/,
  "the opt-in OpenAI realtime boundary must expose server construction",
);
assert.match(
  openAIRealtimeEntry,
  /export declare const OPENAI_REALTIME_LIMITS/,
  "the opt-in OpenAI realtime boundary must expose its limits",
);
assert.match(
  anthropicEntry,
  /export declare (?:class AnthropicProviderAdapter|function createAnthropicProviderAdapter)/,
  "the opt-in Anthropic entry must export its provider adapter",
);
assert.match(
  geminiEntry,
  /export declare (?:class GeminiProviderAdapter|function createGeminiProviderAdapter)/,
  "the opt-in Gemini entry must export its provider adapter",
);
assert.match(
  xaiEntry,
  /export declare (?:class XAIProviderAdapter|function createXAIProviderAdapter)/,
  "the opt-in xAI entry must export its provider adapter",
);
assert.match(
  managedEntry,
  /export \* from ["']\.\.\/transports\/managed-runtime\.js["'];/,
  "the trusted-server managed entry must export ManagedRuntimeTransport",
);
assert.match(
  trustedServerEntry,
  /export declare function createTrustedServerRequestProtectorV1/,
  "the trusted-server protection boundary must expose protector construction",
);
assert.match(
  trustedServerEntry,
  /export declare const TRUSTED_SERVER_REQUEST_PROTECTION_VERSION/,
  "the trusted-server protection boundary must expose its version",
);
assert.doesNotMatch(
  packageEntry,
  /providers\/(?:openai|anthropic|gemini|xai)/,
  "the core package entry must not export concrete provider adapters",
);
assert.doesNotMatch(
  packageEntry,
  /(?:browser|react|server)\//,
  "the core package entry must not export browser, React, or server modules",
);
assert.doesNotMatch(
  browserAndReactDeclarationCode,
  /["'](?:\.\.\/)+(?:providers|server)\//,
  "browser and React declarations must not import provider or server modules",
);
assert.doesNotMatch(
  browserAndReactDeclarationCode,
  /\b(?:OpenAI|Anthropic|Gemini|GoogleGenerativeAI|xAI|TrustedServer)\b/,
  "browser and React declarations must not expose concrete provider or trusted-server types",
);

const declarationsCheckedForSdkImports =
  `${runtimeNeutralDeclarations}\n${openAIEntry}\n${openAIContextEntry}\n${openAITranscriptionEntry}\n${openAIRealtimeEntry}\n${anthropicEntry}\n${geminiEntry}\n${xaiEntry}\n${managedEntry}\n${trustedServerEntry}`;
const externalImports = [
  ...declarationsCheckedForSdkImports.matchAll(/from ["']([^"']+)["']/g),
]
  .map((match) => match[1])
  .filter((specifier) => specifier && !specifier.startsWith("."));
assert.deepEqual(
  externalImports,
  [],
  `public declarations must not import SDK types: ${externalImports.join(", ")}`,
);
const providerSdkImports = files
  .flatMap((path) => [
    ...readFileSync(path, "utf8").matchAll(/from ["']([^"']+)["']/g),
  ])
  .map((match) => match[1])
  .filter((specifier) =>
    /^(?:openai|@anthropic-ai\/|@google\/generative-ai$|@google\/genai$|xai$|@xai-org\/)/u.test(
      specifier,
    ),
  );
assert.deepEqual(
  providerSdkImports,
  [],
  `public declarations must not import provider SDK types: ${providerSdkImports.join(", ")}`,
);

const forbiddenMarkers = [
  /\bReact\b/,
  /\bOpenAI\b/,
  /\bAnthropic\b/,
  /\bGemini\b/,
  /\bGoogleGenerativeAI\b/,
  /\bxAI\b/,
  /\bChatCompletionChunk\b/,
  /\bMessageStreamEvent\b/,
  /\bGenerateContentResponse\b/,
  /\braw_(?:request|response|error)\b/,
  /\b(?:provider|native|sdk)_chunk\b/,
  /\bannotations?\b/i,
  /\b(?:file|url)_citation\b/i,
  /\bnative_payload\b/i,
  /\bfetch\b/,
  /\bResponse\b/,
  /\bEventSource\b/,
  /\bNodeJS\b/,
  /\bBuffer\b/,
  /\b(?:Blob|File|FileList|MediaRecorder|MediaStream|MediaStreamConstraints|RTCPeerConnection|RTCDataChannel|Window|Navigator|HTMLElement|HTMLInputElement|HTMLTextAreaElement)\b/,
  /\bcredentials?\b/i,
];

for (const marker of forbiddenMarkers) {
  assert.doesNotMatch(
    runtimeNeutralDeclarationCode,
    marker,
    `public declarations contain provider-native marker ${marker.source}`,
  );
}

stdout.write(
  `checked ${runtimeNeutralFiles.length} core-neutral, ${browserDeclarationFiles.length} browser, ${reactDeclarationFiles.length} React, and ${files.length - runtimeNeutralFiles.length - browserDeclarationFiles.length - reactDeclarationFiles.length} opt-in declaration files\n`,
);
