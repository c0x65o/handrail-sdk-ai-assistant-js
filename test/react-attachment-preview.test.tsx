// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageAttachmentPreview, StyledChatPreset, ProtectedMessageAttachmentPreview, type MessageAttachmentLoader } from "../src/react-styled/index.js";
import { createInitialConversationState } from "../src/conversation/state.js";

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const attachment = { attachment_id: "att_photo" as never, media_type: "image/jpeg", size_bytes: 2871477 };
describe("saved attachment previews", () => {
  it("renders a card without a filename or URL and passes the canonical conversation to resolvers", () => {
    const message = { message_id: "message" as never, role: "user" as const, content: [],
      attachments: [attachment], created_at: null, attribution: null };
    const state = { ...createInitialConversationState("conversation" as never), messages: [message] };
    const view = render(<StyledChatPreset state={state}/>);
    expect(view.getByText("Image")).toBeTruthy();
    expect(view.getByText(/2.7 MB/)).toBeTruthy();
    const resolve = vi.fn(() => "/authorized/photo");
    view.rerender(<StyledChatPreset state={state} resolveAttachmentUrl={resolve}/>);
    expect(resolve).toHaveBeenCalledWith(attachment, message, "conversation");
    expect(view.getByRole("img").getAttribute("src")).toBe("/authorized/photo");
  });
  it("keeps a usable link after image failure and resets for a refreshed URL", () => {
    const view = render(<MessageAttachmentPreview attachment={attachment} url="/authorized/one"/>);
    fireEvent.error(view.getByRole("img"));
    expect(view.queryByRole("img")).toBeNull();
    expect(view.getByRole("link").getAttribute("href")).toBe("/authorized/one");
    expect(view.getByRole("link").getAttribute("target")).toBe("_blank");
    expect(view.getByText(/Preview unavailable/)).toBeTruthy();
    view.rerender(<MessageAttachmentPreview attachment={attachment} url="/authorized/two"/>);
    expect(view.getByRole("img").getAttribute("src")).toBe("/authorized/two");
    view.rerender(<MessageAttachmentPreview attachment={attachment} url="javascript:alert(1)"/>);
    expect(view.queryByRole("link")).toBeNull();
    expect(view.queryByRole("img")).toBeNull();
  });
});

function objectUrls() {
  let id = 0;
  const create = vi.fn(() => `blob:attachment-${++id}`), revoke = vi.fn();
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: create });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revoke });
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
  return { create, revoke, click };
}

it("uses the default protected renderer, retries failed reads, deduplicates activation and releases temporary URLs", async () => {
  const urls = objectUrls();
  let finish!: (bytes: Uint8Array) => void;
  const load = vi.fn<MessageAttachmentLoader>().mockRejectedValueOnce(new Error("PRIVATE server payload"))
    .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const file = { ...attachment, media_type: "application/pdf", filename: "report.pdf", size_bytes: 3 };
  const state = { ...createInitialConversationState("saved-conversation" as never), messages: [
    { message_id: "message" as never, role: "user" as const, content: [], attachments: [file], created_at: null, attribution: null },
  ] };
  const view = render(<StyledChatPreset state={state} loadAttachment={load}/>);
  expect(load).not.toHaveBeenCalled();
  fireEvent.click(view.getByRole("button", { name: "Download report.pdf" }));
  await view.findByText("Attachment unavailable. Try again.");
  expect(view.queryByText(/PRIVATE/)).toBeNull();
  fireEvent.click(view.getByRole("button", { name: "Download report.pdf" }));
  fireEvent.click(view.getByRole("button", { name: "Loading attachment…" }));
  expect(load).toHaveBeenCalledTimes(2);
  expect(load).toHaveBeenLastCalledWith(expect.objectContaining({ conversationId: "saved-conversation", attachmentId: "att_photo",
    mediaType: "application/pdf", byteSize: 3 }));
  await act(async () => { finish(new Uint8Array([1, 2, 3])); });
  expect(urls.click).toHaveBeenCalledOnce();
  expect((urls.click.mock.contexts[0] as HTMLAnchorElement).download).toBe("report.pdf");
  view.unmount();
  expect(urls.revoke).toHaveBeenCalledWith("blob:attachment-1");
});

it.each(["account", "conversation", "unmount"])("aborts and ignores a late saved-file read after %s changes", async (change) => {
  const urls = objectUrls();
  let finish!: (bytes: Uint8Array) => void;
  const load = vi.fn<MessageAttachmentLoader>(() => new Promise((resolve) => { finish = resolve; }));
  const replacement = vi.fn<MessageAttachmentLoader>(async () => new Uint8Array([2]));
  const file = { ...attachment, media_type: "application/pdf", size_bytes: 1 };
  const view = render(<ProtectedMessageAttachmentPreview attachment={file} conversationId="saved" loadAttachment={load}/>);
  fireEvent.click(view.getByRole("button", { name: "Download Document" }));
  const completeOld = finish;
  const signal = load.mock.calls[0]![0].signal;
  if (change === "unmount") view.unmount();
  else view.rerender(<ProtectedMessageAttachmentPreview attachment={file} conversationId={change === "conversation" ? "other" : "saved"}
    loadAttachment={change === "account" ? replacement : load}/>);
  expect(signal.aborted).toBe(true);
  await act(async () => { completeOld(new Uint8Array([1])); });
  expect(urls.create).not.toHaveBeenCalled();
  expect(urls.click).not.toHaveBeenCalled();
});

it("reauthorizes an image download and cleans up its preview when scope changes", async () => {
  const urls = objectUrls();
  const load = vi.fn<MessageAttachmentLoader>().mockResolvedValueOnce(new Uint8Array([1])).mockRejectedValueOnce(new Error("expired"))
    .mockResolvedValueOnce(new Uint8Array([2]));
  const file = { ...attachment, size_bytes: 1 };
  const view = render(<ProtectedMessageAttachmentPreview attachment={file} conversationId="first" loadAttachment={load}/>);
  await view.findByRole("img");
  fireEvent.click(view.getByRole("button", { name: "Download Image" }));
  await view.findByText("Attachment unavailable. Try again.");
  expect(urls.click).not.toHaveBeenCalled();
  view.rerender(<ProtectedMessageAttachmentPreview attachment={file} conversationId="second" loadAttachment={load}/>);
  await waitFor(() => expect(view.getByRole("img").getAttribute("src")).toBe("blob:attachment-2"));
  expect(urls.revoke).toHaveBeenCalledWith("blob:attachment-1");
  expect(load).toHaveBeenCalledTimes(3);
  view.unmount();
  expect(urls.revoke).toHaveBeenCalledWith("blob:attachment-2");
});

it("preserves explicit host URL adapters instead of calling the negotiated loader", () => {
  objectUrls();
  const load = vi.fn<MessageAttachmentLoader>();
  const state = { ...createInitialConversationState("conversation" as never), messages: [
    { message_id: "message" as never, role: "user" as const, content: [], attachments: [attachment], created_at: null, attribution: null },
  ] };
  const view = render(<StyledChatPreset state={state} loadAttachment={load} resolveAttachmentUrl={() => "/legacy/protected/file"}/>);
  expect(view.getByRole("link").getAttribute("href")).toBe("/legacy/protected/file");
  expect(load).not.toHaveBeenCalled();
});
