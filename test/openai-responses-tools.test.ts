import { describe, expect, it } from "vitest";
import { createDeferredToolDiscoveryPlan } from "../src/index.js";
import { buildOpenAIResponsesRequest, createOpenAIResponsesProviderAdapter, projectOpenAIResponsesTools } from "../src/providers/openai.js";

const definitions = Array.from({ length: 89 }, (_, index) => ({
  name: `aegis_tool_${index}`, description: `Aegis operation ${index}`,
  input_schema: { type: "object" as const, properties: { id: { type: "string" } }, additionalProperties: false },
}));

describe("OpenAI Responses deferred tool projection", () => {
  it("keeps a large authorized catalog deferred behind hosted tool search", () => {
    const plan = createDeferredToolDiscoveryPlan({
      tools: definitions,
      namespaces: [
        { name: "assets", description: "Asset operations", toolNames: definitions.slice(0, 45).map((tool) => tool.name) },
        { name: "security", description: "Security operations", toolNames: definitions.slice(45).map((tool) => tool.name) },
      ], maximumEagerTools: 4,
    });
    const projected = projectOpenAIResponsesTools({ plan, supportsToolSearch: true, hosted: { toolSearch: { execution: "server" }, webSearch: { search_context_size: "low" } } });
    expect(projected.filter((tool) => tool.type === "function")).toHaveLength(0);
    expect(projected.filter((tool) => tool.type === "namespace")).toHaveLength(2);
    expect(projected).toContainEqual(expect.objectContaining({ type: "tool_search", execution: "server" }));
    expect(projected).toContainEqual(expect.objectContaining({ type: "web_search" }));
  });

  it("uses only bounded eager tools when a model lacks tool search", () => {
    const plan = createDeferredToolDiscoveryPlan({
      tools: definitions.slice(0, 4), namespaces: [{ name: "deferred", description: "Deferred operations", toolNames: definitions.slice(1).slice(0, 3).map((tool) => tool.name) }],
    });
    const projected = projectOpenAIResponsesTools({ plan, supportsToolSearch: false });
    expect(projected).toEqual([expect.objectContaining({ type: "function", name: "aegis_tool_0" })]);
  });

  it.each([undefined, true, false])("preserves schemas with explicit functionStrict %s", functionStrict => {
    const tools = definitions.slice(0, 3);
    const plan = createDeferredToolDiscoveryPlan({ tools, namespaces: [
      { name: "aegis", description: "ERP", toolNames: tools.slice(1).map(tool => tool.name) },
    ] });
    const projected = projectOpenAIResponsesTools({ plan, supportsToolSearch: true,
      ...(functionStrict === undefined ? {} : { functionStrict }) });
    const functions = projected.flatMap(tool => tool.type === "function" ? [tool] : tool.type === "namespace" ? tool.tools : []);
    expect(functions).toHaveLength(3);
    expect(functions.every(tool => tool.strict === (functionStrict ?? true))).toBe(true);
    expect(functions.map(tool => tool.parameters)).toEqual(tools.map(tool => tool.input_schema));
    expect(functions.every(tool => tool.parameters.required === undefined)).toBe(true);
  });

  it("replays assistant text as supported plain history without changing message order or text", () => {
    const request = buildOpenAIResponsesRequest({ model: "gpt-example", supportsToolSearch: false,
      plan: createDeferredToolDiscoveryPlan({ tools: [], namespaces: [] }),
      invocation: { messages: [
        { role: "user", content: [{ type: "text", text: "Earlier request" }] },
        { role: "assistant", content: [{ type: "text", text: "Saved " }, { type: "text", text: "answer.\n" }] },
        { role: "user", content: [{ type: "text", text: "Continue" }] },
      ], tools: [], tool_results: [], generation: { max_output_tokens: 1000, temperature: 0 },
      signal: new AbortController().signal, context: { request_id: "r", trace_id: "t", attribution: {} as never, correlation_hints: {} } },
    });
    expect(request.input).toEqual([
      { role: "user", content: [{ type: "input_text", text: "Earlier request" }] },
      { role: "assistant", content: "Saved answer.\n" },
      { role: "user", content: [{ type: "input_text", text: "Continue" }] },
    ]);
  });

  it("builds a stateless Responses request from a provider invocation", () => {
    const plan = createDeferredToolDiscoveryPlan({ tools: definitions.slice(0, 2), namespaces: [{ name: "aegis", description: "ERP", toolNames: definitions.slice(0, 2).map((tool) => tool.name) }] });
    const request = buildOpenAIResponsesRequest({
      model: "gpt-example", plan, supportsToolSearch: true,
      toolChoice: "required", includeReasoningEncryptedContent: true, reasoningEffort: "low",
      invocation: {
        messages: [{ role: "user", content: [{ type: "text", text: "List assets" }] }], tools: definitions.slice(0, 2), tool_results: [],
        generation: { max_output_tokens: 1000, temperature: 0 }, signal: new AbortController().signal,
        context: { request_id: "r", trace_id: "t", attribution: {} as never, correlation_hints: {} },
      },
    });
    expect(request).toMatchObject({ stream: true, store: false, parallel_tool_calls: false,
      max_output_tokens: 1000, tool_choice: "required", include: ["reasoning.encrypted_content"],
      reasoning: { effort: "low" } });
    expect(request.input[0]).toMatchObject({ role: "user" });
  });

  it("runs the Responses streaming provider path", async () => {
    let nativeRequest: unknown;
    const adapter = createOpenAIResponsesProviderAdapter({
      model: "gpt-example", maximumInputMessages: 30, functionStrict: false,
      namespaces: [{ name: "aegis", description: "ERP", toolNames: ["aegis_tool_0"] }],
      request: async function* (request) {
        nativeRequest = request;
        yield { type: "response.output_text.delta", delta: "Checking " };
        yield { type: "response.function_call_arguments.done", call_id: "call-1", namespace: "aegis", name: "aegis_tool_0", arguments: "{\"id\":\"1\"}" };
        yield { type: "response.completed", response: { output: [{ type: "function_call", call_id: "call-1", namespace: "aegis", name: "aegis_tool_0", arguments: "{\"id\":\"1\"}" }], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, input_tokens_details: { cached_tokens: 2 }, output_tokens_details: { reasoning_tokens: 1 } } } };
      },
    });
    const stream = adapter.invoke({
      messages: Array.from({ length: 31 }, (_, index) => ({ role: "user" as const,
        content: [{ type: "text" as const, text: `Check ${index}` }] })), tools: definitions.slice(0, 1), tool_results: [],
      generation: { max_output_tokens: 1000, temperature: 0 }, signal: new AbortController().signal,
      context: { request_id: "r", trace_id: "t", attribution: {
        organization: { id: "o", source: "server_derived", trust: "authoritative" }, project: { id: "p", source: "server_derived", trust: "authoritative" }, service_environment: { id: "e", source: "server_derived", trust: "authoritative" },
        known_user: { id: null, source: "server_derived", trust: "authoritative" }, session: { id: null, source: "server_derived", trust: "authoritative" }, automation: { id: null, source: "server_derived", trust: "authoritative" },
      }, correlation_hints: {} },
    });
    const events = [];
    let terminal;
    while (true) { const item = await stream.next(); if (item.done) { terminal = item.value; break; } events.push(item.value); }
    expect(events.map((event) => event.type)).toEqual(["response.started", "response.text.delta", "response.tool_call", "response.usage", "response.completed"]);
    expect(terminal).toMatchObject({ status: "completed", outcome: "tool_calls", usage: { cached_input_tokens: 2 } });
    expect(nativeRequest).toMatchObject({ store: false, tools: expect.arrayContaining([expect.objectContaining({ type: "tool_search" })]) });
    expect(nativeRequest).toMatchObject({ tools: expect.arrayContaining([
      expect.objectContaining({ type: "namespace", tools: [expect.objectContaining({ strict: false })] }),
    ]) });
    expect((nativeRequest as { input: unknown[] }).input).toHaveLength(30);
    expect((nativeRequest as { input: { content: { text: string }[] }[] }).input[0]?.content[0]?.text).toBe("Check 1");
  });

  it("retains bounded store:false output across a tool continuation and projects hosted citations", async () => {
    const nativeRequests: unknown[] = [];
    const adapter = createOpenAIResponsesProviderAdapter({
      model: "gpt-example",
      namespaces: [{ name: "aegis", description: "ERP", toolNames: ["aegis_tool_0"] }],
      hosted: { webSearch: { search_context_size: "low" } },
      includeReasoningEncryptedContent: true,
      reasoningEffort: "low",
      toolChoice: (invocation) => invocation.continuation_of ? "auto" : "required",
      request: async function* (request) {
        nativeRequests.push(request);
        if (nativeRequests.length === 1) {
          yield { type: "response.output_item.done", item: { type: "reasoning", id: "reasoning-1", encrypted_content: "opaque" } };
          yield { type: "response.function_call_arguments.done", call_id: "call-1", namespace: "aegis", name: "aegis_tool_0", arguments: "{\"id\":\"1\"}" };
          yield { type: "response.completed", response: { output: [
            { type: "reasoning", id: "reasoning-1", encrypted_content: "opaque" },
            { type: "function_call", call_id: "call-1", namespace: "aegis", name: "aegis_tool_0", arguments: "{\"id\":\"1\"}" },
          ], usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } } };
          return;
        }
        yield { type: "response.output_text.delta", delta: "Invoice found." };
        yield { type: "response.completed", response: { output: [{ type: "message", content: [{
          type: "output_text", text: "Invoice found.", annotations: [{ type: "url_citation", title: "Provider source", url: "https://example.com/invoice" }],
        }] }], usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 } } };
      },
    });
    const attribution = {
      organization: { id: "o", source: "server_derived" as const, trust: "authoritative" as const },
      project: { id: "p", source: "server_derived" as const, trust: "authoritative" as const },
      service_environment: { id: "e", source: "server_derived" as const, trust: "authoritative" as const },
      known_user: { id: null, source: "server_derived" as const, trust: "authoritative" as const },
      session: { id: null, source: "server_derived" as const, trust: "authoritative" as const },
      automation: { id: null, source: "server_derived" as const, trust: "authoritative" as const },
    };
    const invoke = (requestId: string, continuationOf: string | null, toolResults: never[] | [{ tool_call_id: string; name: string; content: [{ type: "text"; text: string }]; is_error: false }]) => adapter.invoke({
      continuation_of: continuationOf,
      messages: [{ role: "user", content: [{ type: "text", text: "Check" }] }],
      tools: definitions.slice(0, 1), tool_results: toolResults,
      generation: { max_output_tokens: 1000, temperature: 0 }, signal: new AbortController().signal,
      context: { request_id: requestId, trace_id: `trace-${requestId}`, attribution, correlation_hints: {} },
    });
    const collect = async (stream: ReturnType<typeof invoke>) => {
      const events = [];
      for (;;) { const item = await stream.next(); if (item.done) return { events, result: item.value }; events.push(item.value); }
    };
    const first = await collect(invoke("r1", null, []));
    expect(first.result).toMatchObject({ status: "completed", outcome: "tool_calls" });
    const second = await collect(invoke("r2", "r1", [{ tool_call_id: "call-1", name: "aegis_tool_0", content: [{ type: "text", text: "ok" }], is_error: false }]));
    expect(second.result).toMatchObject({ status: "completed", outcome: "stop" });
    expect(second.events.map((event) => event.type)).toEqual([
      "response.started", "response.text.delta", "response.citation_batch", "response.usage", "response.completed",
    ]);
    expect(second.events.find((event) => event.type === "response.citation_batch")).toMatchObject({
      sources: [{ type: "web", label: "Provider source", locator: "https://example.com/invoice" }],
    });
    expect(nativeRequests[1]).toMatchObject({ input: expect.arrayContaining([
      expect.objectContaining({ type: "reasoning", encrypted_content: "opaque" }),
      expect.objectContaining({ type: "function_call", call_id: "call-1" }),
      expect.objectContaining({ type: "function_call_output", call_id: "call-1", output: "ok" }),
    ]), tool_choice: "auto", include: ["reasoning.encrypted_content"], reasoning: { effort: "low" } });
    expect(nativeRequests[0]).toMatchObject({ tool_choice: "required" });
  });

  it("rejects a namespaced function call that does not match the advertised identity", async () => {
    const adapter = createOpenAIResponsesProviderAdapter({
      model: "gpt-example", namespaces: [{ name: "aegis", description: "ERP", toolNames: ["aegis_tool_0"] }],
      request: async function* () {
        yield { type: "response.function_call_arguments.done", call_id: "call-1", namespace: "wrong", name: "aegis_tool_0", arguments: "{}" };
      },
    });
    const stream = adapter.invoke({ messages: [{ role: "user", content: [{ type: "text", text: "Check" }] }], tools: definitions.slice(0, 1), tool_results: [],
      generation: { max_output_tokens: 100, temperature: 0 }, signal: new AbortController().signal,
      context: { request_id: "r", trace_id: "t", attribution: {
        organization: { id: "o", source: "server_derived", trust: "authoritative" }, project: { id: "p", source: "server_derived", trust: "authoritative" }, service_environment: { id: "e", source: "server_derived", trust: "authoritative" },
        known_user: { id: null, source: "server_derived", trust: "authoritative" }, session: { id: null, source: "server_derived", trust: "authoritative" }, automation: { id: null, source: "server_derived", trust: "authoritative" },
      }, correlation_hints: {} },
    });
    let terminal;
    for (;;) { const item = await stream.next(); if (item.done) { terminal = item.value; break; } }
    expect(terminal).toMatchObject({ status: "failed", error: { code: "upstream_unavailable" } });
  });

  it("projects host-resolved PDFs only when explicit document capability is configured", async () => {
    let nativeRequest: unknown;
    const adapter = createOpenAIResponsesProviderAdapter({
      model: "gpt-example",
      document_input: { supported_mime_types: ["application/pdf"], max_document_count: 2, max_document_bytes: 1024, requires_host_resolution: true },
      request: async function* (request) {
        nativeRequest = request;
        yield { type: "response.output_text.delta", delta: "Read." };
        yield { type: "response.completed", response: { usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } } };
      },
    });
    const stream = adapter.invoke({ messages: [{ role: "user", content: [{ type: "document", attachment: {
      attachment_id: "document-1", content_ref: "ref_document_1", media_type: "application/pdf", byte_size: 3, filename: "invoice.pdf",
    } }] }], tools: [], tool_results: [], generation: { max_output_tokens: 100, temperature: 0 }, signal: new AbortController().signal,
      resolve_document_reference: async () => ({ media_type: "application/pdf", bytes: new Uint8Array([1, 2, 3]) }),
      context: { request_id: "pdf-r", trace_id: "pdf-t", attribution: {
        organization: { id: "o", source: "server_derived", trust: "authoritative" }, project: { id: "p", source: "server_derived", trust: "authoritative" }, service_environment: { id: "e", source: "server_derived", trust: "authoritative" },
        known_user: { id: null, source: "server_derived", trust: "authoritative" }, session: { id: null, source: "server_derived", trust: "authoritative" }, automation: { id: null, source: "server_derived", trust: "authoritative" },
      }, correlation_hints: {} },
    });
    for (;;) { const item = await stream.next(); if (item.done) break; }
    expect(adapter.metadata.capabilities.document_input).toMatchObject({ supported: true });
    expect(nativeRequest).toMatchObject({ input: [{ content: [expect.objectContaining({
      type: "input_file", filename: "invoice.pdf", file_data: "data:application/pdf;base64,AQID",
    })] }] });
  });

  it("projects host-resolved spreadsheets as native file inputs without PDF detail", async () => {
    let nativeRequest: unknown;
    const spreadsheetType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" as const;
    const adapter = createOpenAIResponsesProviderAdapter({
      model: "gpt-example",
      document_input: { supported_mime_types: [spreadsheetType, "text/csv"], max_document_count: 2,
        max_document_bytes: 1024, requires_host_resolution: true },
      request: async function* (request) {
        nativeRequest = request;
        yield { type: "response.completed", response: { usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } } };
      },
    });
    const stream = adapter.invoke({ messages: [{ role: "user", content: [{ type: "document", attachment: {
      attachment_id: "att_sheet", content_ref: "ref_sheet", media_type: spreadsheetType,
      byte_size: 3, filename: "adjustments.xlsx",
    } }] }], tools: [], tool_results: [], generation: { max_output_tokens: 100, temperature: 0 },
      signal: new AbortController().signal,
      resolve_document_reference: async () => ({ media_type: spreadsheetType, bytes: new Uint8Array([1, 2, 3]) }),
      context: { request_id: "xlsx-r", trace_id: "xlsx-t", attribution: {
        organization: { id: "o", source: "server_derived", trust: "authoritative" },
        project: { id: "p", source: "server_derived", trust: "authoritative" },
        service_environment: { id: "e", source: "server_derived", trust: "authoritative" },
        known_user: { id: null, source: "server_derived", trust: "authoritative" },
        session: { id: null, source: "server_derived", trust: "authoritative" },
        automation: { id: null, source: "server_derived", trust: "authoritative" },
      }, correlation_hints: {} },
    });
    for (;;) { const item = await stream.next(); if (item.done) break; }
    expect(nativeRequest).toMatchObject({ input: [{ content: [{
      type: "input_file", filename: "adjustments.xlsx", file_data: `data:${spreadsheetType};base64,AQID`,
    }] }] });
    expect(JSON.stringify(nativeRequest)).not.toContain('"detail"');
  });

  it("normalizes cancellation and retryable rate limits without leaking provider errors", async () => {
    const invocation = (signal: AbortSignal) => ({
      messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "Check" }] }],
      tools: [], tool_results: [], generation: { max_output_tokens: 100, temperature: 0 }, signal,
      context: { request_id: "r", trace_id: "t", attribution: {} as never, correlation_hints: {} },
    });
    const collect = async (adapter: ReturnType<typeof createOpenAIResponsesProviderAdapter>, signal: AbortSignal) => {
      const stream = adapter.invoke(invocation(signal)); const events = [];
      for (;;) { const item = await stream.next(); if (item.done) return { events, result: item.value }; events.push(item.value); }
    };
    const controller = new AbortController(); controller.abort("deadline_exceeded");
    const cancelled = await collect(createOpenAIResponsesProviderAdapter({ model: "gpt-example", request: async function* () {
      yield { type: "response.completed", response: { output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } };
    } }), controller.signal);
    expect(cancelled.events.at(-1)).toMatchObject({ type: "response.cancelled", reason: "deadline_exceeded" });
    expect(cancelled.result).toMatchObject({ status: "cancelled" });

    const limited = await collect(createOpenAIResponsesProviderAdapter({ model: "gpt-example", request: async () => {
      throw Object.assign(new Error("private provider detail"), { status: 429 });
    } }), new AbortController().signal);
    expect(limited.events.at(-1)).toMatchObject({ type: "response.error", error: { code: "rate_limited", retryable: true } });
    expect(JSON.stringify(limited)).not.toContain("private provider detail");
  });
  it.each([
    [400, "invalid_request", false], [401, "unauthenticated", false], [403, "forbidden", false],
    [404, "invalid_request", false], [409, "idempotency_conflict", false], [422, "invalid_request", false],
    [408, "deadline_exceeded", true], [429, "rate_limited", true], [503, "upstream_unavailable", true],
  ] as const)("classifies Responses HTTP %s without exposing the provider payload", async (status, code, retryable) => {
    const adapter = createOpenAIResponsesProviderAdapter({ model: "gpt-example", request: async () => {
      throw Object.assign(new Error("private provider message"), { status, body: { token: "private token" }, cause: new Error("private cause") });
    } });
    const stream = adapter.invoke({ messages: [{ role: "user", content: [{ type: "text", text: "Check" }] }],
      tools: [], tool_results: [], generation: { max_output_tokens: 100, temperature: 0 }, signal: new AbortController().signal,
      context: { request_id: "r", trace_id: "t", attribution: {} as never, correlation_hints: {} } });
    const events = [];
    let next = await stream.next();
    while (!next.done) { events.push(next.value); next = await stream.next(); }
    expect(next.value).toMatchObject({ status: "failed", error: { code, retryable } });
    expect(events.at(-1)).toMatchObject({ type: "response.error", error: { code, retryable } });
    expect(JSON.stringify({ result: next.value, events })).not.toContain("private");
  });

});
