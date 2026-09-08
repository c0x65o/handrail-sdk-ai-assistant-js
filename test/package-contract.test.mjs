import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import path from "node:path";
import test from "node:test";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const packageJson = JSON.parse(
  readFileSync(path.join(packageRoot, "package.json"), "utf8"),
);

test("uses the canonical AI Assistant package identity", () => {
  assert.equal(packageJson.name, "@handrail/ai-assistant");
  assert.match(packageJson.version, /^0\.2\./u);
  assert.equal(packageJson.bin["handrail-ai-assistant"], "./scripts/adopt.mjs");
});

test("git installs build the declared dist exports", () => {
  assert.equal(packageJson.scripts.prepare, "npm run build");
});

test("declares the React subpath as an optional peer boundary", () => {
  assert.deepEqual(packageJson.exports["./react"], {
    types: "./dist/react/index.d.ts",
    import: "./dist/react/index.js",
    default: "./dist/react/index.js",
  });
  assert.equal(packageJson.peerDependencies.react, ">=18");
  assert.deepEqual(packageJson.peerDependenciesMeta.react, { optional: true });
  assert.equal(packageJson.sideEffects, false);
  assert.equal(packageJson.dependencies["react-markdown"], undefined);
});

test("keeps styled-only Markdown dependencies out of headless installs", () => {
  assert.equal(packageJson.dependencies["react-markdown"], undefined);
  assert.equal(packageJson.optionalDependencies?.["react-markdown"], undefined);
  for (const name of ["react-markdown", "remark-gfm"]) {
    assert.equal(packageJson.dependencies[name], undefined);
    assert.equal(packageJson.optionalDependencies?.[name], undefined);
    assert.deepEqual(packageJson.peerDependenciesMeta[name], { optional: true });
    assert.ok(packageJson.peerDependencies[name]);
  }
});

test("declares managed runtime support as an explicit trusted-server boundary", () => {
  assert.deepEqual(packageJson.exports["./server/managed"], {
    types: "./dist/server/managed.d.ts",
    import: "./dist/server/managed.js",
    default: "./dist/server/managed.js",
  });
});

test("declares request protection as an explicit trusted-server boundary", () => {
  assert.deepEqual(packageJson.exports["./server/trusted-server"], {
    types: "./dist/server/trusted-server.d.ts",
    import: "./dist/server/trusted-server.js",
    default: "./dist/server/trusted-server.js",
  });
});

test("isolates the new client, UI, gateway, MCP, and Postgres boundaries", () => {
  for (const subpath of [
    "./client", "./react/headless", "./react/styled", "./server/application-gateway",
    "./server/assistant-context",
    "./connectors/mcp", "./adapters/spartan-aegis", "./adapters/mills-family", "./persistence/postgres",
  ]) {
    assert.ok(packageJson.exports[subpath], `missing explicit export ${subpath}`);
  }
  for (const dependency of ["express", "pg", "@modelcontextprotocol/sdk"]) {
    assert.equal(packageJson.dependencies[dependency], undefined);
    assert.equal(packageJson.peerDependencies[dependency], undefined);
  }
});

test("ships the supported Spartan Aegis adapter as an isolated server boundary", async () => {
  const adapter = await import(pathToFileURL(
    path.join(packageRoot, packageJson.exports["./adapters/spartan-aegis"].import),
  ).href);
  assert.equal(adapter.SPARTAN_AEGIS_ADAPTER_VERSION, "handrail.spartan-aegis.v1");
  assert.equal(typeof adapter.createSpartanAegisPlugin, "function");
  assert.equal(adapter.SPARTAN_AEGIS_TOOL_LOOP_LIMITS.maxTotalToolCalls, 75);
  assert.equal(adapter.SPARTAN_AEGIS_MAXIMUM_INPUT_MESSAGES, 30);
});

test("ships the supported Mills Family adapter as an isolated server boundary", async () => {
  const adapter = await import(pathToFileURL(
    path.join(packageRoot, packageJson.exports["./adapters/mills-family"].import),
  ).href);
  assert.equal(adapter.MILLS_FAMILY_ADAPTER_VERSION, "handrail.mills-family.v1");
  assert.equal(typeof adapter.createMillsFamilyPlugin, "function");
});

test("keeps the React Native headless entry free of DOM and react-dom dependencies", () => {
  const source = readFileSync(path.join(packageRoot, "dist/react-headless/index.js"), "utf8");
  const declarations = readFileSync(path.join(packageRoot, "dist/react-headless/index.d.ts"), "utf8");
  assert.doesNotMatch(source, /["']react-dom["']|["']\.\.\/react\/(?:dialog|drawer|launcher)\.js["']/);
  assert.doesNotMatch(declarations, /HTMLElement|HTMLInputElement|HTMLTextAreaElement|Document|Window/);
});

test("declares OpenAI as an explicit opt-in provider boundary", () => {
  assert.deepEqual(packageJson.exports["./providers/openai"], {
    types: "./dist/providers/openai.d.ts",
    import: "./dist/providers/openai.js",
    default: "./dist/providers/openai.js",
  });
  assert.equal(packageJson.dependencies.openai, undefined);
});

test("declares OpenAI voice features as dedicated opt-in provider boundaries", () => {
  assert.deepEqual(packageJson.exports["./providers/openai/transcription"], {
    types: "./dist/providers/openai-transcription.d.ts",
    import: "./dist/providers/openai-transcription.js",
    default: "./dist/providers/openai-transcription.js",
  });
  assert.deepEqual(packageJson.exports["./providers/openai/realtime"], {
    types: "./dist/providers/openai-realtime.d.ts",
    import: "./dist/providers/openai-realtime.js",
    default: "./dist/providers/openai-realtime.js",
  });
  assert.equal(packageJson.dependencies.openai, undefined);
  assert.equal(packageJson.devDependencies.openai, undefined);
  assert.equal(packageJson.peerDependencies.openai, undefined);
  assert.equal(packageJson.optionalDependencies?.openai, undefined);
});

test("declares Anthropic as an explicit opt-in provider boundary", () => {
  assert.deepEqual(packageJson.exports["./providers/anthropic"], {
    types: "./dist/providers/anthropic.d.ts",
    import: "./dist/providers/anthropic.js",
    default: "./dist/providers/anthropic.js",
  });
  assert.equal(packageJson.dependencies["@anthropic-ai/sdk"], undefined);
});

test("declares Gemini as an explicit opt-in provider boundary", () => {
  assert.deepEqual(packageJson.exports["./providers/gemini"], {
    types: "./dist/providers/gemini.d.ts",
    import: "./dist/providers/gemini.js",
    default: "./dist/providers/gemini.js",
  });
  assert.equal(packageJson.dependencies["@google/genai"], undefined);
  assert.equal(packageJson.dependencies["@google/generative-ai"], undefined);
});

test("declares xAI as an explicit opt-in provider boundary", () => {
  assert.deepEqual(packageJson.exports["./providers/xai"], {
    types: "./dist/providers/xai.d.ts",
    import: "./dist/providers/xai.js",
    default: "./dist/providers/xai.js",
  });
  assert.equal(packageJson.dependencies.openai, undefined);
  assert.equal(packageJson.dependencies.xai, undefined);
  assert.equal(packageJson.dependencies["@xai-org/xai-sdk"], undefined);
});

test("resolves every public ESM export from the built package", async () => {
  for (const exportName of Object.keys(packageJson.exports)) {
    const target = packageJson.exports[exportName].import;
    const moduleUrl = pathToFileURL(path.join(packageRoot, target)).href;
    const imported = await import(moduleUrl);
    assert.equal(typeof imported, "object", `${exportName} ESM export`);
  }
});

test("exports citation records and normalization from the built core entry", async () => {
  const moduleUrl = pathToFileURL(
    path.join(packageRoot, packageJson.exports["."].import),
  ).href;
  const imported = await import(moduleUrl);
  assert.deepEqual(imported.CITATION_SOURCE_TYPES, ["web", "document", "tool"]);
  assert.equal(typeof imported.normalizeCitationRecords, "function");
  assert.equal(typeof imported.deduplicateCitationRecords, "function");
});

test("exports bounded web search without an HTTP or provider dependency", async () => {
  const moduleUrl = pathToFileURL(
    path.join(packageRoot, packageJson.exports["."].import),
  ).href;
  const imported = await import(moduleUrl);
  assert.equal(typeof imported.WEB_SEARCH_LIMITS, "object");
  assert.equal(typeof imported.WebSearchService, "function");
  assert.equal(typeof imported.WebSearchError, "function");
  assert.equal(typeof imported.createWebSearchCitationRecords, "function");
  assert.equal(typeof imported.createWebSearchToolRegistration, "function");
  assert.equal(imported.fetch, undefined);
  assert.equal(imported.OpenAI, undefined);
});

test("exports provider-neutral realtime voice without browser or provider code", async () => {
  const moduleUrl = pathToFileURL(
    path.join(packageRoot, packageJson.exports["."].import),
  ).href;
  const imported = await import(moduleUrl);
  assert.equal(
    imported.REALTIME_VOICE_CONTRACT_VERSION,
    "handrail.realtime-voice.v1",
  );
  assert.equal(typeof imported.parseRealtimeVoiceBootstrapRequest, "function");
  assert.equal(typeof imported.createRealtimeVoiceClientSession, "function");
  assert.equal(
    typeof imported.createIdempotentRealtimeVoiceSessionAuthority,
    "function",
  );
  assert.equal(typeof imported.parseRealtimeVoiceServerToolCall, "function");
  assert.equal(typeof imported.createRealtimeVoiceServerToolBridge, "function");
  assert.equal(
    typeof imported.InMemoryRealtimeVoiceToolCallBindingStore,
    "function",
  );
  assert.equal(imported.RTCPeerConnection, undefined);
  assert.equal(imported.OpenAI, undefined);
  assert.equal(imported.React, undefined);
});

test("exports the provider-neutral transcription contract from the built core entry", async () => {
  const moduleUrl = pathToFileURL(
    path.join(packageRoot, packageJson.exports["."].import),
  ).href;
  const imported = await import(moduleUrl);
  assert.equal(
    imported.TRANSCRIPTION_CONTRACT_VERSION,
    "handrail.transcription.v1",
  );
  assert.equal(typeof imported.TRANSCRIPTION_LIMITS, "object");
  assert.equal(typeof imported.parseTranscriptionRequest, "function");
  assert.equal(typeof imported.executeTranscription, "function");
  assert.equal(imported.OpenAI, undefined);
  assert.equal(imported.React, undefined);
});

test("isolates OpenAI transcription to the existing opt-in provider entry", async () => {
  const core = await import(pathToFileURL(
    path.join(packageRoot, packageJson.exports["."].import),
  ).href);
  const browser = await import(pathToFileURL(
    path.join(packageRoot, packageJson.exports["./browser"].import),
  ).href);
  const openai = await import(pathToFileURL(
    path.join(packageRoot, packageJson.exports["./providers/openai"].import),
  ).href);
  const transcription = await import(pathToFileURL(
    path.join(
      packageRoot,
      packageJson.exports["./providers/openai/transcription"].import,
    ),
  ).href);

  assert.equal(core.createOpenAITranscriptionCapability, undefined);
  assert.equal(browser.createOpenAITranscriptionCapability, undefined);
  assert.equal(typeof openai.createOpenAITranscriptionCapability, "function");
  assert.equal(typeof openai.OPENAI_TRANSCRIPTION_LIMITS, "object");
  assert.equal(
    typeof transcription.createOpenAITranscriptionCapability,
    "function",
  );
  assert.equal(typeof transcription.OPENAI_TRANSCRIPTION_LIMITS, "object");
  assert.ok(Array.isArray(transcription.OPENAI_TRANSCRIPTION_AUDIO_FORMATS));
});

test("isolates OpenAI realtime to its dedicated opt-in provider entry", async () => {
  const core = await import(pathToFileURL(
    path.join(packageRoot, packageJson.exports["."].import),
  ).href);
  const browser = await import(pathToFileURL(
    path.join(packageRoot, packageJson.exports["./browser"].import),
  ).href);
  const openai = await import(pathToFileURL(
    path.join(packageRoot, packageJson.exports["./providers/openai"].import),
  ).href);
  const realtime = await import(pathToFileURL(
    path.join(packageRoot, packageJson.exports["./providers/openai/realtime"].import),
  ).href);

  assert.equal(core.createOpenAIRealtimeServer, undefined);
  assert.equal(browser.createOpenAIRealtimeServer, undefined);
  assert.equal(openai.createOpenAIRealtimeServer, undefined);
  assert.equal(typeof realtime.createOpenAIRealtimeServer, "function");
  assert.equal(typeof realtime.OPENAI_REALTIME_LIMITS, "object");
});

test("exports trusted-server protection only from its dedicated server entry", async () => {
  const core = await import(pathToFileURL(
    path.join(packageRoot, packageJson.exports["."].import),
  ).href);
  const browser = await import(pathToFileURL(
    path.join(packageRoot, packageJson.exports["./browser"].import),
  ).href);
  const trustedServer = await import(pathToFileURL(
    path.join(packageRoot, packageJson.exports["./server/trusted-server"].import),
  ).href);

  assert.equal(core.createTrustedServerRequestProtectorV1, undefined);
  assert.equal(browser.createTrustedServerRequestProtectorV1, undefined);
  assert.equal(
    trustedServer.TRUSTED_SERVER_REQUEST_PROTECTION_VERSION,
    "trusted-server.request-protection.v1",
  );
  assert.equal(typeof trustedServer.TRUSTED_SERVER_V1_LIMITS, "object");
  assert.equal(
    typeof trustedServer.createTrustedServerRequestProtectorV1,
    "function",
  );
});

test("exports browser audio capture only from the browser entry", async () => {
  const core = await import(pathToFileURL(
    path.join(packageRoot, packageJson.exports["."].import),
  ).href);
  const browser = await import(pathToFileURL(
    path.join(packageRoot, packageJson.exports["./browser"].import),
  ).href);

  assert.equal(core.createBrowserAudioCaptureController, undefined);
  assert.equal(core.intakeBrowserAudio, undefined);
  assert.equal(core.BrowserAudioCaptureError, undefined);
  assert.equal(typeof browser.createBrowserAudioCaptureController, "function");
  assert.equal(typeof browser.intakeBrowserAudio, "function");
  assert.equal(typeof browser.BrowserAudioCaptureError, "function");
  assert.ok(Array.isArray(browser.BROWSER_AUDIO_CAPTURE_ERROR_CODES));
  assert.equal(browser.React, undefined);
});

test("exports WebRTC voice control only from the browser entry", async () => {
  const core = await import(pathToFileURL(
    path.join(packageRoot, packageJson.exports["."].import),
  ).href);
  const browser = await import(pathToFileURL(
    path.join(packageRoot, packageJson.exports["./browser"].import),
  ).href);

  assert.equal(core.createBrowserRealtimeVoiceController, undefined);
  assert.equal(core.BROWSER_REALTIME_VOICE_LIMITS, undefined);
  assert.equal(typeof browser.createBrowserRealtimeVoiceController, "function");
  assert.equal(typeof browser.BROWSER_REALTIME_VOICE_LIMITS, "object");
  assert.equal(browser.OpenAI, undefined);
  assert.equal(browser.React, undefined);
});

test("imports the browser entry without browser audio globals", () => {
  const browserEntry = pathToFileURL(
    path.join(packageRoot, packageJson.exports["./browser"].import),
  ).href;
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `for (const name of ["navigator", "MediaRecorder", "RTCPeerConnection", "document", "Blob", "File", "URL"]) Reflect.deleteProperty(globalThis, name); await import(${JSON.stringify(browserEntry)});`,
    ],
    { cwd: packageRoot, encoding: "utf8" },
  );

  assert.equal(
    result.status,
    0,
    `Browser-global-free import failed:\n${result.stderr || result.stdout}`,
  );
});

test("exports the approval proposal store contract from the built core entry", async () => {
  const moduleUrl = pathToFileURL(
    path.join(packageRoot, packageJson.exports["."].import),
  ).href;
  const imported = await import(moduleUrl);
  assert.equal(typeof imported.InMemoryApprovalProposalStore, "function");
  assert.equal(typeof imported.ApprovalProposalStoreError, "function");
  assert.equal(typeof imported.APPROVAL_PROPOSAL_STORE_LIMITS, "object");
  assert.equal(typeof imported.createApprovalCoordinator, "function");
  assert.equal(typeof imported.APPROVAL_COORDINATOR_LIMITS, "object");
});

test("exports the conversation catalog contract from the built core entry", async () => {
  const moduleUrl = pathToFileURL(
    path.join(packageRoot, packageJson.exports["."].import),
  ).href;
  const imported = await import(moduleUrl);
  assert.equal(typeof imported.CONVERSATION_CATALOG_LIMITS, "object");
  assert.equal(typeof imported.parseConversationCatalogDescriptor, "function");
  assert.equal(typeof imported.paginateConversationCatalogDescriptors, "function");
  assert.equal(typeof imported.authorizeConversationCatalogRequest, "function");
  assert.equal(typeof imported.ConversationCatalogError, "function");
  assert.equal(typeof imported.InMemoryConversationCatalog, "function");
  assert.equal(
    typeof imported.IN_MEMORY_CONVERSATION_CATALOG_LIMITS,
    "object",
  );
});

test("imports core and browser entries when React resolution is unavailable", () => {
  const loaderUrl = new URL("./fixtures/reject-react-loader.mjs", import.meta.url);
  const entryUrls = [".", "./browser"].map((exportName) =>
    pathToFileURL(
      path.join(packageRoot, packageJson.exports[exportName].import),
    ).href,
  );
  const result = spawnSync(
    process.execPath,
    [
      "--experimental-loader",
      fileURLToPath(loaderUrl),
      "--input-type=module",
      "--eval",
      `await Promise.all(${JSON.stringify(entryUrls)}.map((entry) => import(entry)));`,
    ],
    { cwd: packageRoot, encoding: "utf8" },
  );

  assert.equal(
    result.status,
    0,
    `React-free entry import failed:\n${result.stderr || result.stdout}`,
  );
});

test("core, client, server, and headless imports do not require Markdown peers", () => {
  const entries = [".", "./browser", "./client", "./server/assistant", "./react/headless"].map(name =>
    pathToFileURL(path.join(packageRoot, packageJson.exports[name].import)).href);
  const result = spawnSync(process.execPath, [
    "--experimental-loader", fileURLToPath(new URL("./fixtures/reject-markdown-loader.mjs", import.meta.url)),
    "--input-type=module", "--eval",
    `await Promise.all(${JSON.stringify(entries)}.map(entry => import(entry)));`,
  ], { cwd: packageRoot, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("dry pack contains only intended package assets", () => {
  const output = execFileSync(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["pack", "--dry-run", "--json", "--ignore-scripts"],
    { cwd: packageRoot, encoding: "utf8" },
  );
  const [{ files }] = JSON.parse(output);
  const packedFiles = new Set(files.map(({ path: filePath }) => filePath));

  for (const expected of [
    "dist/index.js",
    "dist/index.d.ts",
    "dist/browser/index.js",
    "dist/browser/index.d.ts",
    "dist/client/index.js",
    "dist/client/index.d.ts",
    "dist/react/index.js",
    "dist/react/index.d.ts",
    "dist/react-styled/index.js",
    "dist/react-styled/index.d.ts",
    "dist/server/application-gateway.js",
    "dist/server/application-gateway.d.ts",
    "dist/server/managed.js",
    "dist/server/managed.d.ts",
    "dist/server/trusted-server.js",
    "dist/server/trusted-server.d.ts",
    "dist/mcp/index.js",
    "dist/mcp/index.d.ts",
    "dist/postgres/index.js",
    "dist/postgres/index.d.ts",
    "dist/providers/openai.js",
    "dist/providers/openai.d.ts",
    "dist/providers/openai-transcription.js",
    "dist/providers/openai-transcription.d.ts",
    "dist/react-markdown/index.js",
    "dist/react-markdown/index.d.ts",
    "flutter/handrail_ai_widgets/lib/markdown.dart",
    "dist/providers/openai-realtime.js",
    "dist/providers/openai-realtime.d.ts",
    "dist/providers/anthropic.js",
    "dist/providers/anthropic.d.ts",
    "dist/providers/gemini.js",
    "dist/providers/gemini.d.ts",
    "dist/providers/xai.js",
    "dist/providers/xai.d.ts",
    "scripts/adopt.mjs",
    "templates/standard-react-node/server.ts",
    "templates/standard-react-node/client.tsx",
    "templates/standard-react-node/README.md",
  ]) {
    assert.ok(packedFiles.has(expected), `missing packed file ${expected}`);
  }

  for (const filePath of packedFiles) {
    assert.doesNotMatch(filePath, /(?:^|\/)\.dart_tool\//u);
    assert.doesNotMatch(filePath, /^(?:src|test)\//u);
    if (filePath.startsWith("scripts/")) assert.equal(filePath, "scripts/adopt.mjs");
    assert.doesNotMatch(
      filePath,
      /\.(?:css|less|sass|scss|eot|otf|ttf|woff2?)$/u,
    );
    assert.match(filePath, /^(?:dist\/|docs\/|flutter\/handrail_ai_(?:client|widgets)\/|scripts\/adopt\.mjs$|templates\/standard-react-node\/|LICENSE$|README\.md$|package\.json$)/u);
  }
});
