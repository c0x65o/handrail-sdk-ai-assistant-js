// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageAttachmentPreview, StyledChatPreset } from "../src/react-styled/index.js";
import { createInitialConversationState } from "../src/conversation/state.js";

afterEach(cleanup);
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
