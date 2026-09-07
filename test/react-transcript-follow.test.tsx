/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { StrictMode, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSmartTranscriptFollow } from "../src/react/index.js";
import { StyledChatPreset } from "../src/react-styled/index.js";
import { createInitialConversationState } from "../src/conversation/state.js";

function Harness({ conversationId = "first", visible = true }: { conversationId?: string; visible?: boolean }) {
  const [version, setVersion] = useState(1);
  const follow = useSmartTranscriptFollow({ conversationId, contentVersion: version, thresholdPixels: 40 });
  return <>
    {visible ? <section aria-label="Transcript" ref={follow.transcriptRef} onScroll={follow.onScroll}>
      <div data-testid="content">Message {version}</div>
    </section> : null}
    <button onClick={() => setVersion((value) => value + 1)}>Append</button>
    {!follow.following ? <button aria-label="Jump to latest message" onClick={() => follow.scrollToLatest()}>
      {follow.hasNewContent ? "New messages" : "Jump to latest"}
    </button> : null}
  </>;
}

// Model clamped browser geometry; smooth scrolls deliberately remain in flight.
function geometry(transcript = screen.getByRole("region", { name: "Transcript" })) {
  const size = { height: 1000, viewport: 200, top: 800 };
  Object.defineProperties(transcript, {
    scrollHeight: { configurable: true, get: () => size.height },
    clientHeight: { configurable: true, get: () => size.viewport },
    scrollTop: { configurable: true, get: () => size.top, set: (top: number) => { size.top = top; } },
  });
  const scrollTo = vi.fn((options: ScrollToOptions) => {
    if (options.behavior !== "smooth") size.top = Math.max(0, Math.min(options.top ?? 0, size.height - size.viewport));
  });
  Object.defineProperty(transcript, "scrollTo", { configurable: true, value: scrollTo });
  fireEvent.scroll(transcript);
  return { transcript, size, scrollTo };
}
function observers() {
  const callbacks: ResizeObserverCallback[] = [];
  const observed = new Set<Element>();
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: ResizeObserverCallback) { callbacks.push(callback); }
    observe = (element: Element) => { observed.add(element); };
    disconnect = () => observed.clear();
  });
  const frames = new Map<number, FrameRequestCallback>();
  let nextId = 0;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    frames.set(++nextId, callback); return nextId;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => { frames.delete(id); });
  return { observed, frames,
    resize: () => act(() => { callbacks.forEach((callback) => callback([], {} as ResizeObserver)); }),
    flush: async () => {
      await act(async () => { await Promise.resolve(); });
      act(() => { const pending = [...frames.values()]; frames.clear(); pending.forEach((callback) => callback(0)); });
    },
  };
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("smart transcript following", () => {
  it("follows a large append using the position before content grew", () => {
    render(<Harness/>);
    const { size, scrollTo } = geometry();
    size.height = 2200;
    fireEvent.click(screen.getByText("Append"));
    expect(size.top).toBe(2000);
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 2200, behavior: "instant" });
  });
  it("pauses immediately on a small upward wheel gesture and resumes when the reader returns to the bottom", () => {
    render(<Harness/>);
    const { transcript, size, scrollTo } = geometry();
    fireEvent.wheel(transcript, { deltaY: -5 });
    size.top = 795;
    fireEvent.scroll(transcript);
    size.height = 1200;
    fireEvent.click(screen.getByText("Append"));
    expect(scrollTo).not.toHaveBeenCalled();
    expect(screen.getByText("New messages")).toBeTruthy();
    size.top = 1000;
    fireEvent.scroll(transcript);
    fireEvent.click(screen.getByText("Append"));
    expect(scrollTo).toHaveBeenCalled();
    expect(screen.queryByLabelText("Jump to latest message")).toBeNull();
  });
  it("resets on a thread switch with the same content version, including switching back", () => {
    const view = render(<Harness/>);
    const { transcript, size } = geometry();
    size.top = 100;
    fireEvent.scroll(transcript);
    view.rerender(<Harness conversationId="second"/>);
    expect(size.top).toBe(800);
    size.top = 90;
    fireEvent.scroll(transcript);
    view.rerender(<Harness/>);
    expect(size.top).toBe(800);
  });
  it("keeps following through a smooth jump and lets an upward gesture cancel it", () => {
    render(<Harness/>);
    const { transcript, size, scrollTo } = geometry();
    size.top = 100;
    fireEvent.scroll(transcript);
    fireEvent.click(screen.getByLabelText("Jump to latest message"));
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 1000, behavior: "smooth" });
    size.top = 300;
    fireEvent.scroll(transcript);
    expect(screen.queryByLabelText("Jump to latest message")).toBeNull();
    fireEvent.wheel(transcript, { deltaY: -10 });
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 300, behavior: "instant" });
    scrollTo.mockClear();
    fireEvent.click(screen.getByText("Append"));
    expect(scrollTo).not.toHaveBeenCalled();
  });
  it("pauses for touch and keyboard reading", () => {
    render(<Harness/>);
    const { transcript, scrollTo } = geometry();
    fireEvent.touchStart(transcript, { touches: [{ clientY: 100 }] });
    fireEvent.touchMove(transcript, { touches: [{ clientY: 110 }] });
    fireEvent.click(screen.getByText("Append"));
    expect(scrollTo).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText("Jump to latest message"));
    fireEvent.keyDown(transcript, { key: "PageUp" });
    scrollTo.mockClear();
    fireEvent.click(screen.getByText("Append"));
    expect(scrollTo).not.toHaveBeenCalled();
  });
  it("follows delayed content and composer/viewport resizing without a new revision", async () => {
    const observer = observers();
    render(<Harness/>);
    const { size } = geometry();
    expect(observer.observed.has(screen.getByTestId("content"))).toBe(true);
    size.height = 1600;
    observer.resize();
    await observer.flush();
    expect(size.top).toBe(1400);
    size.viewport = 120;
    observer.resize();
    await observer.flush();
    expect(size.top).toBe(1480);
  });
  it("detects host DOM changes and leaves a reader in place during delayed growth", async () => {
    const observer = observers();
    render(<Harness/>);
    const { transcript, size } = geometry();
    const message = document.createElement("div");
    message.textContent = "Delayed reply";
    size.height = 1500;
    transcript.append(message);
    await observer.flush();
    expect(observer.observed.has(message)).toBe(true);
    expect(size.top).toBe(1300);
    fireEvent.wheel(transcript, { deltaY: -200 });
    size.top = 1100;
    fireEvent.scroll(transcript);
    size.height = 1700;
    observer.resize();
    await observer.flush();
    expect(size.top).toBe(1100);
    expect(screen.getByText("New messages")).toBeTruthy();
  });
  it("does not mistake a content clamp or viewport resize for reader movement", () => {
    render(<Harness/>);
    const { transcript, size } = geometry();
    size.height = 900;
    size.top = 700;
    fireEvent.scroll(transcript);
    size.viewport = 100;
    fireEvent.scroll(transcript);
    fireEvent.click(screen.getByText("Append"));
    expect(size.top).toBe(800);
    expect(screen.queryByLabelText("Jump to latest message")).toBeNull();
  });
  it("reattaches to a replacement scrollport and cleans up frames in Strict Mode", async () => {
    const observer = observers();
    const view = render(<StrictMode><Harness/></StrictMode>);
    const first = screen.getByRole("region");
    view.rerender(<StrictMode><Harness visible={false}/></StrictMode>);
    expect(observer.observed.has(first)).toBe(false);
    view.rerender(<StrictMode><Harness/></StrictMode>);
    expect(observer.observed.has(screen.getByRole("region"))).toBe(true);
    observer.resize();
    view.unmount();
    expect(observer.frames.size).toBe(0);
    expect(observer.observed.size).toBe(0);
    await observer.flush();
  });
  it("honors reduced motion for explicit jumps", () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
    render(<Harness/>);
    const { transcript, size, scrollTo } = geometry();
    size.top = 100;
    fireEvent.scroll(transcript);
    fireEvent.click(screen.getByLabelText("Jump to latest message"));
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 1000, behavior: "instant" });
  });
  it("resets the standard preset on conversations with identical revision and message counts", () => {
    const first = createInitialConversationState("first" as never);
    const second = createInitialConversationState("second" as never);
    const view = render(<StyledChatPreset state={first}/>);
    const { transcript, size } = geometry(screen.getByRole("region", { name: "Conversation transcript" }));
    size.top = 100;
    fireEvent.scroll(transcript);
    view.rerender(<StyledChatPreset state={second}/>);
    expect(size.top).toBe(800);
    expect(screen.queryByLabelText("Jump to latest message")).toBeNull();
  });
});
