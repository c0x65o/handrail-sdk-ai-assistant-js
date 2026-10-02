import { describe, expect, it, vi } from "vitest";

import {
  AI_RUNTIME_PROTOCOL_LIMITS,
  AI_RUNTIME_PROTOCOL_VERSION,
  CITATION_LIMITS,
  parseStreamEvents,
  type AttachmentReference,
  type AuthoritativeAttribution,
  type ProviderAdapterInvocation,
  type ProviderAdapterResult,
  type ProviderAdapterStream,
  type StreamEvent,
} from "../src/index.js";
import {
  createOpenAIProviderAdapter,
  type OpenAIChatCompletionRequest,
  type OpenAIRequestOptions,
} from "../src/providers/openai.js";

const pdfDocumentInput = {
  supported_mime_types: ["application/pdf"] as const,
  max_document_count: 2,
  max_document_bytes: 8,
  requires_host_resolution: true,
};

function pdfAttachment(
  overrides: Partial<AttachmentReference> = {},
): AttachmentReference<"application/pdf"> {
  return {
    attachment_id: "att_openai_pdf",
    content_ref: "ref_openai_pdf",
    media_type: "application/pdf",
    byte_size: 4,
    filename: "fixture.pdf",
    ...overrides,
  } as AttachmentReference<"application/pdf">;
}

const attribution: AuthoritativeAttribution = {
  organization: { id: "org_1", source: "server_derived", trust: "authoritative" },
  project: { id: "prj_1", source: "server_derived", trust: "authoritative" },
  service_environment: { id: "env_1", source: "server_derived", trust: "authoritative" },
  known_user: { id: "usr_1", source: "server_derived", trust: "authoritative" },
  session: { id: "ses_1", source: "server_derived", trust: "authoritative" },
  automation: { id: null, source: "server_derived", trust: "authoritative" },
};

function invocation(
  overrides: Partial<ProviderAdapterInvocation> = {},
): ProviderAdapterInvocation {
  return {
    messages: [
      { role: "user", content: [{ type: "text", text: "Hello" }] },
    ],
    tools: [],
    tool_results: [],
    generation: { max_output_tokens: 128, temperature: 0.25 },
    signal: new AbortController().signal,
    context: {
      request_id: "req_openai_fixture",
      trace_id: "trc_openai_fixture",
      attribution,
      correlation_hints: {},
      metadata: { fixture: "openai_adapter" },
    },
    ...overrides,
  };
}

async function* chunks(...values: unknown[]): AsyncGenerator<unknown> {
  for (const value of values) yield value;
}

const usageChunk = {
  choices: [],
  usage: {
    prompt_tokens: 12,
    completion_tokens: 7,
    total_tokens: 19,
    prompt_tokens_details: { cached_tokens: 3 },
    completion_tokens_details: { reasoning_tokens: 2 },
  },
};

const urlCitation = (
  overrides: Record<string, unknown> = {},
) => ({
  type: "url_citation",
  start_index: 0,
  end_index: 5,
  title: "Example source",
  url: "HTTPS://Example.COM:443/source?b=2&a=1#section",
  ...overrides,
});

const fileCitation = (
  overrides: Record<string, unknown> = {},
) => ({
  type: "file_citation",
  index: 6,
  file_id: "file-native-private-123",
  filename: "Reference.pdf",
  ...overrides,
});

async function collect(stream: ProviderAdapterStream): Promise<{
  events: StreamEvent[];
  result: ProviderAdapterResult;
}> {
  const events: StreamEvent[] = [];
  let item = await stream.next();
  while (!item.done) {
    events.push(item.value);
    item = await stream.next();
  }
  return { events, result: item.value };
}

function expectValid(events: StreamEvent[]): void {
  expect(parseStreamEvents(events)).toBe(events);
  expect(events[0]).toMatchObject({
    type: "response.started",
    protocol_version: AI_RUNTIME_PROTOCOL_VERSION,
    sequence: 0,
  });
  expect(
    events.filter((event) =>
      ["response.completed", "response.cancelled", "response.error"].includes(
        event.type,
      ),
    ),
  ).toHaveLength(1);
}

describe("OpenAIProviderAdapter", () => {
  it("streams text and normalizes cached/reasoning token subsets with unknown cost", async () => {
    const request = vi.fn(() =>
      chunks(
        { choices: [{ index: 0, delta: { content: "Hel" }, finish_reason: null }] },
        { choices: [{ index: 0, delta: { content: "lo" }, finish_reason: "stop" }] },
        usageChunk,
      ),
    );
    const output = await collect(
      createOpenAIProviderAdapter({ model: "gpt-fixture", request }).invoke(
        invocation(),
      ),
    );

    expect(output.events.map((event) => event.type)).toEqual([
      "response.started",
      "response.text.delta",
      "response.text.delta",
      "response.usage",
      "response.completed",
    ]);
    expectValid(output.events);
    expect(output.result).toEqual({
      status: "completed",
      outcome: "stop",
      usage: {
        input_tokens: 12,
        cached_input_tokens: 3,
        output_tokens: 7,
        reasoning_tokens: 2,
        total_tokens: 19,
        provider_cost: { known: false },
      },
    });
  });

  it("assembles fragmented tool arguments and emits only the complete call", async () => {
    const request = vi.fn(() =>
      chunks(
        {
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index: 0,
                id: "call_weather",
                function: { name: "lookup_weather", arguments: "{\"city\":" },
              }],
            },
            finish_reason: null,
          }],
        },
        {
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{ index: 0, function: { arguments: "\"Chicago\"}" } }],
            },
            finish_reason: "tool_calls",
          }],
        },
        usageChunk,
      ),
    );
    const output = await collect(
      createOpenAIProviderAdapter({ model: "gpt-fixture", request }).invoke(
        invocation(),
      ),
    );

    expect(output.events.filter((event) => event.type === "response.tool_call")).toEqual([
      expect.objectContaining({
        type: "response.tool_call",
        tool_call_id: "call_weather",
        name: "lookup_weather",
        arguments: { city: "Chicago" },
      }),
    ]);
    expectValid(output.events);
    expect(output.result).toMatchObject({ status: "completed", outcome: "tool_calls" });
  });

  it("maps image references, tools, tool results, generation settings, and the signal", async () => {
    let payload: OpenAIChatCompletionRequest | undefined;
    let requestOptions: OpenAIRequestOptions | undefined;
    const controller = new AbortController();
    const request = vi.fn(
      (value: OpenAIChatCompletionRequest, options: OpenAIRequestOptions) => {
        payload = value;
        requestOptions = options;
        return chunks(
          { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
          usageChunk,
        );
      },
    );
    const resolveImage = vi.fn(() => ({
      url: "https://images.example.test/fixture.png",
      detail: "high" as const,
    }));
    const input = invocation({
      signal: controller.signal,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "Describe " },
          {
            type: "image",
            attachment: {
              attachment_id: "att_openai_fixture",
              content_ref: "ref_openai_fixture",
              media_type: "image/png",
              byte_size: 1024,
            },
            alt_text: "fixture",
          },
        ],
      }],
      tools: [{
        name: "lookup_weather",
        description: "Look up weather.",
        input_schema: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
      }],
      tool_results: [{
        tool_call_id: "call_previous",
        name: "lookup_weather",
        content: [{ type: "json", value: { temperature: 72 } }],
        is_error: false,
      }],
      generation: { max_output_tokens: 64, temperature: 0.5 },
    });

    await collect(
      createOpenAIProviderAdapter({
        model: "gpt-fixture",
        request,
        resolve_image_reference: resolveImage,
      }).invoke(input),
    );

    expect(resolveImage).toHaveBeenCalledWith(
      expect.objectContaining({ content_ref: "ref_openai_fixture" }),
    );
    expect(payload).toMatchObject({
      model: "gpt-fixture",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Describe " },
            {
              type: "image_url",
              image_url: {
                url: "https://images.example.test/fixture.png",
                detail: "high",
              },
            },
          ],
        },
        {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call_previous",
            type: "function",
            function: { name: "lookup_weather", arguments: "{}" },
          }],
        },
        {
          role: "tool",
          tool_call_id: "call_previous",
          content: "{\"temperature\":72}",
        },
      ],
      tools: [{
        type: "function",
        function: {
          name: "lookup_weather",
          parameters: { type: "object" },
        },
      }],
      parallel_tool_calls: false,
      max_completion_tokens: 64,
      temperature: 0.5,
      stream: true,
      stream_options: { include_usage: true },
    });
    expect(requestOptions?.signal).toBe(controller.signal);
  });

  it.each([
    ["length", "length"],
    ["stop", "stop"],
  ] as const)("maps %s to the matching terminal outcome", async (finishReason, outcome) => {
    const output = await collect(
      createOpenAIProviderAdapter({
        model: "gpt-fixture",
        request: () => chunks(
          { choices: [{ index: 0, delta: {}, finish_reason: finishReason }] },
          usageChunk,
        ),
      }).invoke(invocation()),
    );

    expect(output.events.at(-1)).toMatchObject({
      type: "response.completed",
      outcome,
    });
    expect(output.result).toMatchObject({ status: "completed", outcome });
    expectValid(output.events);
  });

  it.each(["explicit_stop", "deadline_exceeded", "policy_revoked", "runtime_shutdown"] as const)("propagates AbortSignal and returns one cancellation terminal", async (reason) => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const request = vi.fn(
      (_payload: OpenAIChatCompletionRequest, options: OpenAIRequestOptions) => {
        receivedSignal = options.signal;
        return (async function* () {
          await new Promise<void>((_resolve, reject) => {
            options.signal.addEventListener(
              "abort",
              () => reject(new DOMException("Aborted", "AbortError")),
              { once: true },
            );
          });
          yield undefined;
        })();
      },
    );
    const stream = createOpenAIProviderAdapter({ model: "gpt-fixture", request }).invoke(
      invocation({ signal: controller.signal }),
    );
    const started = await stream.next();
    const pending = stream.next();
    await vi.waitFor(() => expect(receivedSignal).toBe(controller.signal));
    controller.abort(reason);
    const cancelled = await pending;
    const done = await stream.next();

    expect(started.value).toMatchObject({ type: "response.started" });
    expect(cancelled.value).toMatchObject({
      type: "response.cancelled",
      reason: reason,
    });
    expect(done).toEqual({
      done: true,
      value: { status: "cancelled", reason: reason, usage: null },
    });
    expectValid([started.value as StreamEvent, cancelled.value as StreamEvent]);
  });

  it("normalizes 429 as retryable without leaking the raw provider error", async () => {
    const output = await collect(
      createOpenAIProviderAdapter({
        model: "gpt-fixture",
        request: async () => {
          throw {
            status: 429,
            message: "raw secret sk-fixture-do-not-leak",
            headers: { authorization: "Bearer hidden" },
            response: { native: true },
          };
        },
      }).invoke(invocation()),
    );

    expect(output.events.at(-1)).toMatchObject({
      type: "response.error",
      error: { code: "rate_limited", retryable: true },
    });
    expect(output.result).toMatchObject({
      status: "failed",
      error: { kind: "provider", code: "rate_limited", retryable: true },
    });
    const serialized = JSON.stringify(output);
    expect(serialized).not.toContain("sk-fixture");
    expect(serialized).not.toContain("authorization");
    expect(serialized).not.toContain("headers");
    expect(serialized).not.toContain("native");
    expectValid(output.events);
  });

  it("normalizes a non-retryable provider request error", async () => {
    const output = await collect(
      createOpenAIProviderAdapter({
        model: "gpt-fixture",
        request: async () => { throw { status: 400, body: { raw: true } }; },
      }).invoke(invocation()),
    );

    expect(output.events.at(-1)).toMatchObject({
      type: "response.error",
      error: { category: "request", code: "invalid_request", retryable: false },
    });
    expect(output.result).toMatchObject({
      status: "failed",
      error: { kind: "client", code: "invalid_request", retryable: false },
    });
    expectValid(output.events);
  });

  it("normalizes authentication failures without exposing provider details", async () => {
    const output = await collect(
      createOpenAIProviderAdapter({
        model: "gpt-fixture",
        request: async () => { throw { status: 401, message: "invalid api key" }; },
      }).invoke(invocation()),
    );

    expect(output.events.at(-1)).toMatchObject({
      type: "response.error",
      error: {
        category: "authentication",
        code: "unauthenticated",
        retryable: false,
      },
    });
    expect(output.result).toMatchObject({
      status: "failed",
      error: { kind: "client", code: "unauthenticated", retryable: false },
    });
    expect(JSON.stringify(output)).not.toContain("invalid api key");
    expectValid(output.events);
  });

  it("normalizes transient 5xx failures as retryable", async () => {
    const output = await collect(
      createOpenAIProviderAdapter({
        model: "gpt-fixture",
        request: async () => { throw { status: 503 }; },
      }).invoke(invocation()),
    );

    expect(output.result).toMatchObject({
      status: "failed",
      error: {
        kind: "provider",
        code: "upstream_unavailable",
        retryable: true,
      },
    });
    expectValid(output.events);
  });

  it("fails safely on malformed upstream data", async () => {
    const output = await collect(
      createOpenAIProviderAdapter({
        model: "gpt-fixture",
        request: () => chunks({ choices: [{ index: 0, delta: { content: 42 } }] }),
      }).invoke(invocation()),
    );

    expect(output.events.map((event) => event.type)).toEqual([
      "response.started",
      "response.error",
    ]);
    expect(output.result).toMatchObject({
      status: "failed",
      error: {
        kind: "provider",
        code: "upstream_unavailable",
        message: "The provider returned malformed streaming data.",
      },
    });
    expectValid(output.events);
  });

  it("rejects unsupported capabilities before calling upstream", async () => {
    const request = vi.fn(() => chunks());
    const output = await collect(
      createOpenAIProviderAdapter({
        model: "gpt-fixture",
        request,
        supports_tool_calls: false,
      }).invoke(invocation({
        tools: [{
          name: "lookup_weather",
          description: "Look up weather.",
          input_schema: { type: "object" },
        }],
      })),
    );

    expect(request).not.toHaveBeenCalled();
    expect(output.result).toMatchObject({
      status: "failed",
      error: { kind: "client", code: "invalid_request", retryable: false },
    });
    expectValid(output.events);
  });

  it("constructs from a host-injected BYOK request boundary with checked citation projection", async () => {
    const hostConfiguredRequest = vi.fn(() =>
      chunks(
        { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        usageChunk,
      ),
    );
    const adapter = createOpenAIProviderAdapter({
      model: "gpt-host-configured",
      request: hostConfiguredRequest,
    });
    const output = await collect(adapter.invoke(invocation()));

    expect(adapter.metadata).toMatchObject({
      provider_id: "openai",
      model_id: "gpt-host-configured",
      capabilities: {
        citation_projection: { supported: true },
      },
    });
    expect(hostConfiguredRequest).toHaveBeenCalledOnce();
    expect(output.result.status).toBe("completed");
    expect(output.events.some((event) => event.type === "response.citation_batch")).toBe(false);
  });

  it("normalizes interleaved URL/file annotations with deterministic identities and first-seen order", async () => {
    const annotationChunks = () => chunks(
      {
        choices: [{
          index: 0,
          delta: { content: "See " },
          finish_reason: null,
        }],
      },
      {
        choices: [{
          index: 0,
          delta: { annotations: [urlCitation()] },
          finish_reason: null,
        }],
      },
      {
        choices: [{
          index: 0,
          delta: {
            content: "the source",
            annotations: [
              urlCitation(),
              {
                type: "future_annotation",
                provider_payload: "unknown-native-payload",
              },
            ],
          },
          finish_reason: null,
        }],
      },
      {
        choices: [{
          index: 0,
          delta: { content: " and file.", annotations: [fileCitation()] },
          finish_reason: "stop",
        }],
      },
      usageChunk,
    );
    const adapter = createOpenAIProviderAdapter({
      model: "gpt-fixture",
      request: annotationChunks,
    });
    const first = await collect(adapter.invoke(invocation()));
    const second = await collect(adapter.invoke(invocation()));

    expect(first.events.map((event) => event.type)).toEqual([
      "response.started",
      "response.text.delta",
      "response.text.delta",
      "response.text.delta",
      "response.citation_batch",
      "response.usage",
      "response.completed",
    ]);
    const citationBatch = first.events.find(
      (event) => event.type === "response.citation_batch",
    );
    const repeatedBatch = second.events.find(
      (event) => event.type === "response.citation_batch",
    );
    expect(citationBatch).toMatchObject({
      type: "response.citation_batch",
      target: {
        type: "assistant_message",
        message_id: expect.stringMatching(/^assistant:[a-f0-9]{16}$/),
      },
      sources: [
        {
          source_id: expect.stringMatching(/^source:[a-f0-9]{16}$/),
          type: "web",
          label: "Example source",
          locator: "https://example.com/source?b=2&a=1#section",
        },
        {
          source_id: expect.stringMatching(/^source:[a-f0-9]{16}$/),
          type: "document",
          label: "Reference.pdf",
          locator: expect.stringMatching(/^document:[a-f0-9]{16}$/),
        },
      ],
      citations: [
        { order: 0, citation_id: expect.stringMatching(/^citation:[a-f0-9]{16}$/) },
        { order: 1, citation_id: expect.stringMatching(/^citation:[a-f0-9]{16}$/) },
      ],
    });
    expect(repeatedBatch).toEqual(citationBatch);
    expectValid(first.events);
    expect(first.result.status).toBe("completed");

    const serialized = JSON.stringify({ events: first.events, result: first.result });
    for (const rejectedNativeValue of [
      "annotations",
      "url_citation",
      "file_citation",
      "file_id",
      "file-native-private-123",
      "start_index",
      "end_index",
      "unknown-native-payload",
      "provider_payload",
    ]) {
      expect(serialized).not.toContain(rejectedNativeValue);
    }
  });

  it.each([
    [
      "unsafe URL",
      urlCitation({ url: "http://127.0.0.1/rejected-native-locator" }),
      "http://127.0.0.1/rejected-native-locator",
    ],
    [
      "malformed URL citation",
      {
        type: "url_citation",
        start_index: 0,
        title: "Missing end",
        url: "https://example.com",
      },
      "https://example.com",
    ],
    [
      "oversized URL label",
      urlCitation({ title: "oversized-native-label".repeat(CITATION_LIMITS.labelLength) }),
      "oversized-native-label",
    ],
    [
      "malformed file citation",
      fileCitation({ index: -1 }),
      "file-native-private-123",
    ],
  ])("fails safely on a recognized %s without leaking its payload", async (
    _label,
    annotation,
    rejectedValue,
  ) => {
    const output = await collect(
      createOpenAIProviderAdapter({
        model: "gpt-fixture",
        request: () => chunks(
          {
            choices: [{
              index: 0,
              delta: { annotations: [annotation] },
              finish_reason: "stop",
            }],
          },
          usageChunk,
        ),
      }).invoke(invocation()),
    );

    expect(output.events.map((event) => event.type)).toEqual([
      "response.started",
      "response.error",
    ]);
    expect(output.result).toMatchObject({
      status: "failed",
      error: {
        kind: "provider",
        code: "upstream_unavailable",
        message: "The provider returned malformed streaming data.",
      },
    });
    const serialized = JSON.stringify({ events: output.events, result: output.result });
    expect(serialized).not.toContain(rejectedValue);
    expect(serialized).not.toContain("annotations");
    expect(serialized).not.toContain("file_id");
    expectValid(output.events);
  });

  it("rejects conflicting recognized annotations through the sanitized malformed path", async () => {
    const output = await collect(
      createOpenAIProviderAdapter({
        model: "gpt-fixture",
        request: () => chunks(
          {
            choices: [{
              index: 0,
              delta: {
                annotations: [
                  fileCitation(),
                  fileCitation({ filename: "Conflicting-reference.pdf" }),
                ],
              },
              finish_reason: "stop",
            }],
          },
          usageChunk,
        ),
      }).invoke(invocation()),
    );

    expect(output.events.map((event) => event.type)).toEqual([
      "response.started",
      "response.error",
    ]);
    const serialized = JSON.stringify({ events: output.events, result: output.result });
    expect(serialized).not.toContain("file-native-private-123");
    expect(serialized).not.toContain("Conflicting-reference.pdf");
    expectValid(output.events);
  });

  it("does not emit buffered citations after cancellation", async () => {
    const controller = new AbortController();
    async function* cancellableChunks(): AsyncGenerator<unknown> {
      yield {
        choices: [{
          index: 0,
          delta: { content: "partial", annotations: [fileCitation()] },
          finish_reason: null,
        }],
      };
      controller.abort("policy_revoked");
      yield usageChunk;
    }
    const output = await collect(
      createOpenAIProviderAdapter({
        model: "gpt-fixture",
        request: cancellableChunks,
      }).invoke(invocation({ signal: controller.signal })),
    );

    expect(output.events.map((event) => event.type)).toEqual([
      "response.started",
      "response.text.delta",
      "response.cancelled",
    ]);
    expect(output.result).toEqual({
      status: "cancelled",
      reason: "policy_revoked",
      usage: null,
    });
    expect(JSON.stringify(output)).not.toContain("file-native-private-123");
    expectValid(output.events);
  });

  it("maps mixed text, image, and PDF content in stable order", async () => {
    let payload: OpenAIChatCompletionRequest | undefined;
    const request = vi.fn((value: OpenAIChatCompletionRequest) => {
      payload = value;
      return chunks(
        { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        usageChunk,
      );
    });
    const controller = new AbortController();
    const attachment = pdfAttachment();
    const resolveImageReference = vi.fn(() => ({
      url: "https://images.example.test/mixed.png",
      detail: "low" as const,
    }));
    const resolveDocumentReference = vi.fn((_reference, context) => {
      expect(context.signal).toBe(controller.signal);
      return {
        media_type: "application/pdf" as const,
        bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
      };
    });
    const adapter = createOpenAIProviderAdapter({
      model: "gpt-fixture",
      request,
      resolve_image_reference: resolveImageReference,
      document_input: pdfDocumentInput,
    });

    const output = await collect(adapter.invoke(invocation({
      signal: controller.signal,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "Compare " },
          {
            type: "image",
            attachment: {
              attachment_id: "att_openai_image",
              content_ref: "ref_openai_image",
              media_type: "image/png",
              byte_size: 2,
            },
          },
          { type: "document", attachment },
          { type: "text", text: " carefully" },
        ],
      }],
      resolve_document_reference: resolveDocumentReference,
    })));

    expect(adapter.metadata.capabilities.document_input).toEqual({
      supported: true,
      capability: pdfDocumentInput,
    });
    expect(resolveDocumentReference).toHaveBeenCalledWith(attachment, {
      signal: controller.signal,
    });
    expect(payload?.messages[0]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "Compare " },
        {
          type: "image_url",
          image_url: {
            url: "https://images.example.test/mixed.png",
            detail: "low",
          },
        },
        {
          type: "file",
          file: {
            filename: "fixture.pdf",
            file_data: "data:application/pdf;base64,JVBERg==",
          },
        },
        { type: "text", text: " carefully" },
      ],
    });
    expect(output.result.status).toBe("completed");
    expectValid(output.events);
  });

  it("keeps document input unsupported without explicit capability configuration", async () => {
    const request = vi.fn(() => chunks());
    const resolveDocumentReference = vi.fn(() => ({
      media_type: "application/pdf" as const,
      bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
    }));
    const adapter = createOpenAIProviderAdapter({ model: "gpt-fixture", request });
    const output = await collect(adapter.invoke(invocation({
      messages: [{
        role: "user",
        content: [{ type: "document", attachment: pdfAttachment() }],
      }],
      resolve_document_reference: resolveDocumentReference,
    })));

    expect(adapter.metadata.capabilities.document_input).toEqual({ supported: false });
    expect(resolveDocumentReference).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(output.result).toMatchObject({
      status: "failed",
      error: { kind: "client", code: "invalid_request" },
    });
    expectValid(output.events);
  });

  it("rejects assistant documents before resolution or upstream invocation", async () => {
    const request = vi.fn(() => chunks());
    const resolveDocumentReference = vi.fn(() => ({
      media_type: "application/pdf" as const,
      bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
    }));
    const output = await collect(
      createOpenAIProviderAdapter({
        model: "gpt-fixture",
        request,
        document_input: pdfDocumentInput,
      }).invoke(invocation({
        messages: [{
          role: "assistant",
          content: [{ type: "document", attachment: pdfAttachment() }],
        }],
        resolve_document_reference: resolveDocumentReference,
      })),
    );

    expect(resolveDocumentReference).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(output.result).toMatchObject({
      status: "failed",
      error: { kind: "client", code: "invalid_request" },
    });
    expectValid(output.events);
  });

  it.each([
    ["wrong MIME", { media_type: "image/png" }],
    ["URL content reference", { content_ref: "https://example.test/file.pdf" }],
    ["unsafe attachment identifier", { attachment_id: "../att_pdf" }],
    ["unsafe filename", { filename: "../fixture.pdf" }],
    [
      "overlong filename",
      {
        filename: "x".repeat(
          AI_RUNTIME_PROTOCOL_LIMITS.attachmentFilenameLength + 1,
        ),
      },
    ],
    ["oversized attachment metadata", { byte_size: 9 }],
    ["provider-native attachment field", { file_id: "file-fixture" }],
  ])("rejects %s before document resolution", async (_label, overrides) => {
    const request = vi.fn(() => chunks());
    const resolveDocumentReference = vi.fn(() => ({
      media_type: "application/pdf" as const,
      bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
    }));
    const attachment = {
      ...pdfAttachment(),
      ...overrides,
    } as AttachmentReference<"application/pdf">;
    const output = await collect(
      createOpenAIProviderAdapter({
        model: "gpt-fixture",
        request,
        document_input: pdfDocumentInput,
      }).invoke(invocation({
        messages: [{
          role: "user",
          content: [{ type: "document", attachment }],
        }],
        resolve_document_reference: resolveDocumentReference,
      })),
    );

    expect(resolveDocumentReference).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(output.result).toMatchObject({
      status: "failed",
      error: { kind: "client", code: "invalid_request" },
    });
    expectValid(output.events);
  });

  it("enforces the configured document count before resolution", async () => {
    const request = vi.fn(() => chunks());
    const resolveDocumentReference = vi.fn();
    const output = await collect(
      createOpenAIProviderAdapter({
        model: "gpt-fixture",
        request,
        document_input: { ...pdfDocumentInput, max_document_count: 1 },
      }).invoke(invocation({
        messages: [{
          role: "user",
          content: [
            { type: "document", attachment: pdfAttachment() },
            {
              type: "document",
              attachment: pdfAttachment({
                attachment_id: "att_openai_pdf_2",
                content_ref: "ref_openai_pdf_2",
              }),
            },
          ],
        }],
        resolve_document_reference: resolveDocumentReference,
      })),
    );

    expect(resolveDocumentReference).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(output.result.status).toBe("failed");
    expectValid(output.events);
  });

  it.each([
    ["wrong resolved MIME", { media_type: "image/png", bytes: new Uint8Array(4) }],
    ["non-byte data", { media_type: "application/pdf", bytes: "JVBERg==" }],
    ["byte-size mismatch", { media_type: "application/pdf", bytes: new Uint8Array(3) }],
    ["oversized data", { media_type: "application/pdf", bytes: new Uint8Array(9) }],
    [
      "provider-native resolver field",
      {
        media_type: "application/pdf",
        bytes: new Uint8Array(4),
        file_id: "file-fixture",
      },
    ],
  ])("rejects malformed resolver output: %s", async (_label, resolved) => {
    const request = vi.fn(() => chunks());
    const resolveDocumentReference = vi.fn(() => resolved);
    const output = await collect(
      createOpenAIProviderAdapter({
        model: "gpt-fixture",
        request,
        document_input: pdfDocumentInput,
      }).invoke(invocation({
        messages: [{
          role: "user",
          content: [{ type: "document", attachment: pdfAttachment() }],
        }],
        resolve_document_reference: resolveDocumentReference as NonNullable<
          ProviderAdapterInvocation["resolve_document_reference"]
        >,
      })),
    );

    expect(resolveDocumentReference).toHaveBeenCalledOnce();
    expect(request).not.toHaveBeenCalled();
    expect(output.result).toMatchObject({
      status: "failed",
      error: { kind: "client", code: "invalid_request" },
    });
    expectValid(output.events);
  });

  it("validates configured document capability metadata", () => {
    const request = vi.fn(() => chunks());
    expect(() => createOpenAIProviderAdapter({
      model: "gpt-fixture",
      request,
      document_input: { ...pdfDocumentInput, max_document_count: 0 },
    })).toThrow(TypeError);
    expect(() => createOpenAIProviderAdapter({
      model: "gpt-fixture",
      request,
      document_input: {
        ...pdfDocumentInput,
        requires_host_resolution: false,
      },
    })).toThrow(TypeError);
  });

  it("pre-aborts documents without resolution or upstream invocation", async () => {
    const controller = new AbortController();
    controller.abort("policy_revoked");
    const request = vi.fn(() => chunks());
    const resolveDocumentReference = vi.fn();
    const output = await collect(
      createOpenAIProviderAdapter({
        model: "gpt-fixture",
        request,
        document_input: pdfDocumentInput,
      }).invoke(invocation({
        signal: controller.signal,
        messages: [{
          role: "user",
          content: [{ type: "document", attachment: pdfAttachment() }],
        }],
        resolve_document_reference: resolveDocumentReference,
      })),
    );

    expect(resolveDocumentReference).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(output.events.map((event) => event.type)).toEqual([
      "response.started",
      "response.cancelled",
    ]);
    expect(output.result).toEqual({
      status: "cancelled",
      reason: "policy_revoked",
      usage: null,
    });
    expectValid(output.events);
  });

  it("cancels during document resolution exactly once and never invokes upstream", async () => {
    const controller = new AbortController();
    const request = vi.fn(() => chunks());
    const resolveDocumentReference = vi.fn((_reference, context) => {
      expect(context.signal).toBe(controller.signal);
      return new Promise<never>(() => undefined);
    });
    const stream = createOpenAIProviderAdapter({
      model: "gpt-fixture",
      request,
      document_input: pdfDocumentInput,
    }).invoke(invocation({
      signal: controller.signal,
      messages: [{
        role: "user",
        content: [{ type: "document", attachment: pdfAttachment() }],
      }],
      resolve_document_reference: resolveDocumentReference,
    }));

    const started = await stream.next();
    const pending = stream.next();
    await vi.waitFor(() => expect(resolveDocumentReference).toHaveBeenCalledOnce());
    controller.abort("deadline_exceeded");
    const cancelled = await pending;
    const done = await stream.next();

    expect(request).not.toHaveBeenCalled();
    expect(cancelled.value).toMatchObject({
      type: "response.cancelled",
      reason: "deadline_exceeded",
    });
    expect(done).toEqual({
      done: true,
      value: { status: "cancelled", reason: "deadline_exceeded", usage: null },
    });
    expectValid([
      started.value as StreamEvent,
      cancelled.value as StreamEvent,
    ]);
  });
});
