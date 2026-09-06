/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useState } from "react";
import { StandardChatComposer, BrowserDictationControl } from "../src/react-styled/composer.js";
import { composerApprovalModeFromRequest, withComposerApprovalMode, type ComposerApprovalMode } from "../src/composer-approval.js";
import type { ConversationComposerResult } from "../src/react/index.js";
import { parseChatRequest, type ChatRequest } from "../src/protocol.js";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function composer() {
  return { draft: "A draft", setDraft: vi.fn(), attachments: [], errors: [], canSend: true, isSending: false,
    acquireSubmissionBlock: vi.fn(() => vi.fn()), submit: vi.fn(async () => null), stop: vi.fn(),
    getTextareaProps: () => ({ value: "A draft", onChange: vi.fn(), onPaste: vi.fn() }),
    getFileInputProps: () => ({ multiple: true, accept: "image/png,application/pdf", onChange: vi.fn() }),
    getDropProps: () => ({ onDrop: vi.fn() }),
  } as unknown as ConversationComposerResult;
}
it("keeps badge visibility separate from automatic execution and shows an accessible switch", () => {
  function Host() {
    const [mode, setMode] = useState<ComposerApprovalMode>("required");
    const [visible, setVisible] = useState(true);
    return <><button onClick={() => setVisible(!visible)}>Visibility</button><output>{mode}</output>
      <StandardChatComposer composer={composer()} voiceControls={null} approvalMode={mode}
        onApprovalModeChange={setMode} showApprovalControl={visible}/></>;
  }
  render(<Host/>);
  expect(screen.getByRole("textbox").getAttribute("rows")).toBe("1");
  expect(screen.getByRole("button", { name: "Add files and images" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Approval settings" }));
  expect((screen.getByRole("switch") as HTMLInputElement).checked).toBe(false);
  fireEvent.click(screen.getByRole("switch"));
  expect(screen.getByText("automatic")).toBeTruthy();
  fireEvent.click(screen.getByText("Visibility"));
  expect(screen.queryByRole("button", { name: "Approval settings" })).toBeNull();
  expect(screen.getByText("automatic")).toBeTruthy();
});
it("retains the chosen mode with the request and rejects invalid modes", () => {
  const request: ChatRequest = { protocol_version: "handrail.ai-runtime.v1", continuation_of: null,
    messages: [{ role: "user", content: [{ type: "text", text: "Add a task" }] }], tools: [], tool_results: [],
    generation: { max_output_tokens: 100, temperature: 0 }, correlation_hints: {}, metadata: { task: "test" } };
  const retained = parseChatRequest(withComposerApprovalMode(request, "automatic"));
  expect(composerApprovalModeFromRequest(retained)).toBe("automatic");
  expect(request.metadata).toEqual({ task: "test" });
  expect(composerApprovalModeFromRequest(request)).toBeUndefined();
  expect(() => composerApprovalModeFromRequest({ metadata: { handrail_approval_mode: "anything" } })).toThrow();
});
it("dictates into the latest draft, blocks submission, and aborts on unmount", () => {
  const instances: FakeRecognition[] = [];
  class FakeRecognition {
    onresult: ((event: unknown) => void) | null = null; onend: (() => void) | null = null;
    start = vi.fn(); stop = vi.fn(); abort = vi.fn();
    constructor() { instances.push(this); }
  }
  vi.stubGlobal("SpeechRecognition", FakeRecognition);
  const input = composer(), release = vi.fn();
  vi.mocked(input.acquireSubmissionBlock).mockReturnValue(release);
  const view = render(<BrowserDictationControl composer={input}/>);
  fireEvent.click(screen.getByRole("button", { name: "Dictate a message" }));
  expect(input.acquireSubmissionBlock).toHaveBeenCalledOnce();
  view.rerender(<BrowserDictationControl composer={{ ...input, draft: "Edited while listening" }}/>);
  act(() => instances[0]!.onresult?.({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: "hello" } }] }));
  expect(input.setDraft).toHaveBeenCalledWith("Edited while listening hello");
  expect(input.submit).not.toHaveBeenCalled();
  view.unmount();
  expect(instances[0]!.abort).toHaveBeenCalledOnce();
  expect(release).toHaveBeenCalledOnce();
});
