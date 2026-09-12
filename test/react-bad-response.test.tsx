// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BadResponseButton } from "../src/react/index.js";
import { StyledChatPreset } from "../src/react-styled/index.js";
import { createInitialConversationState, type ConversationMessageRecord, type ConversationTurnRecord,
  type BadResponseReporter, type BadResponseReportReceipt } from "../src/index.js";

afterEach(cleanup);
const message = { message_id: "message", turn_id: "turn", role: "assistant", created_at: null,
  attribution: null, attachments: [], content: [{ type: "text", text: "Private response" }],
} as unknown as ConversationMessageRecord;
const success: BadResponseReporter = async (request) => ({ eventId: request.eventId,
  bugId: "bug", classification: "bad_response", reviewStatus: "pending" });

describe("optional bad-response action", () => {
  it("is hidden by default and when disabled, and never appears on non-assistant messages", () => {
    const report = vi.fn(success);
    const props = { conversationId: "conversation", message };
    const view = render(<BadResponseButton {...props}/>);
    expect(screen.queryByRole("button")).toBeNull();
    view.rerender(<BadResponseButton {...props} reporting={{ enabled: false, report }}/>);
    expect(screen.queryByRole("button")).toBeNull();
    for (const role of ["user", "system", null] as const) {
      view.rerender(<BadResponseButton {...props} message={{ ...message, role }} reporting={{ enabled: true, report }}/>);
      expect(screen.queryByRole("button")).toBeNull();
    }
    view.rerender(<BadResponseButton {...props} message={{ ...message, content: [] }} reporting={{ enabled: true, report }}/>);
    expect(screen.queryByRole("button")).toBeNull();
    expect(report).not.toHaveBeenCalled();
  });

  it("waits for an intake receipt and blocks concurrent and repeated submissions", async () => {
    let resolve!: (receipt: BadResponseReportReceipt) => void;
    const report = vi.fn<BadResponseReporter>(() => new Promise((done) => { resolve = done; }));
    render(<BadResponseButton conversationId="conversation" message={message} reporting={{ enabled: true, report }}/>);
    const button = screen.getByRole("button", { name: "Bad response" });
    act(() => { fireEvent.click(button); fireEvent.click(button); });
    expect(report).toHaveBeenCalledTimes(1);
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("status").textContent).toBe("");
    const request = report.mock.calls[0]![0];
    expect(request).toEqual({ eventId: expect.any(String), conversationId: "conversation", messageId: "message", turnId: "turn" });
    await act(async () => resolve(await success(request, { signal: new AbortController().signal })));
    expect(screen.getByRole("status").textContent).toBe("Response reported for review.");
    fireEvent.click(screen.getByRole("button", { name: "Reported" }));
    expect(report).toHaveBeenCalledTimes(1);
  });

  it("shows a safe error and retries the same frozen request", async () => {
    const report = vi.fn<BadResponseReporter>().mockRejectedValueOnce(new Error("secret upstream response"))
      .mockImplementation(success);
    render(<BadResponseButton conversationId="conversation" message={message} reporting={{ enabled: true, report }}/>);
    fireEvent.click(screen.getByRole("button", { name: "Bad response" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Please try again"));
    expect(document.body.textContent).not.toContain("secret");
    fireEvent.click(screen.getByRole("button", { name: "Bad response" }));
    await screen.findByRole("button", { name: "Reported" });
    expect(report.mock.calls[0]![0]).toBe(report.mock.calls[1]![0]);
  });

  it("does not report success when the host returns only a generic bug receipt", async () => {
    const report = vi.fn(async () => ({ bugId: "bug" })) as unknown as BadResponseReporter;
    render(<BadResponseButton conversationId="conversation" message={message} reporting={{ enabled: true, report }}/>);
    fireEvent.click(screen.getByRole("button", { name: "Bad response" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Please try again"));
    expect(screen.queryByRole("button", { name: "Reported" })).toBeNull();
  });

  it("aborts when the target changes and ignores the old response", async () => {
    let resolve!: (receipt: BadResponseReportReceipt) => void;
    const report = vi.fn<BadResponseReporter>(() => new Promise((done) => { resolve = done; }));
    const view = render(<BadResponseButton conversationId="first" message={message} reporting={{ enabled: true, report }}/>);
    fireEvent.click(screen.getByRole("button", { name: "Bad response" }));
    const [request, options] = report.mock.calls[0]!;
    view.rerender(<BadResponseButton conversationId="second" message={message} reporting={{ enabled: true, report }}/>);
    expect(options.signal.aborted).toBe(true);
    await act(async () => resolve(await success(request, options)));
    expect(screen.getByRole("button", { name: "Bad response" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("");
  });

  it("honors a prevented click and cancels pending requests when disabled", () => {
    const report = vi.fn<BadResponseReporter>(() => new Promise(() => undefined));
    const props = { conversationId: "conversation", message, reporting: { enabled: true, report } };
    const view = render(<BadResponseButton {...props} onClick={(event) => event.preventDefault()}/>);
    fireEvent.click(screen.getByRole("button", { name: "Bad response" }));
    expect(report).not.toHaveBeenCalled();
    view.rerender(<BadResponseButton {...props}/>);
    fireEvent.click(screen.getByRole("button", { name: "Bad response" }));
    view.rerender(<BadResponseButton {...props} reporting={{ enabled: false, report }}/>);
    expect(report.mock.calls[0]![1].signal.aborted).toBe(true);
  });

  it("integrates with the preset, keeps Copy, and waits for the target turn to finish", async () => {
    const state = { ...createInitialConversationState("conversation" as never), messages: [message],
      active_turn_id: "turn" as never, turns: [{ turn_id: "turn", output_message_ids: ["message"],
        status: "running", remote_may_still_be_running: true } as unknown as ConversationTurnRecord] };
    const report = vi.fn(success);
    const view = render(<StyledChatPreset state={state}/>);
    expect(screen.getByRole("button", { name: "Copy" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Bad response" })).toBeNull();
    view.rerender(<StyledChatPreset state={state} badResponseReporting={{ enabled: true, report }}/>);
    expect((screen.getByRole("button", { name: "Bad response" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Bad response" }));
    expect(report).not.toHaveBeenCalled();
    const complete = { ...state, active_turn_id: null,
      turns: [{ ...state.turns[0]!, status: "completed" as const, remote_may_still_be_running: false }] };
    view.rerender(<StyledChatPreset state={complete} badResponseReporting={{ enabled: true, report }}/>);
    fireEvent.click(screen.getByRole("button", { name: "Bad response" }));
    await screen.findByRole("button", { name: "Reported" });
    view.rerender(<StyledChatPreset state={complete} messageActions={false} badResponseReporting={{ enabled: true, report }}/>);
    expect(screen.queryByRole("button", { name: "Reported" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Copy" })).toBeNull();
  });
});
