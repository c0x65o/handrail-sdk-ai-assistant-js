/** @vitest-environment jsdom */

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { ReactPresentationFixture } from "../examples/react-presentations.js";

const fixtures: ReactPresentationFixture[] = [];

afterEach(() => {
  cleanup();
  for (const fixture of fixtures.splice(0)) fixture.dispose();
});

async function fixture() {
  const { createReactPresentationFixture } = await import(
    "../examples/react-presentations.js"
  );
  const value = await createReactPresentationFixture();
  fixtures.push(value);
  return value;
}

async function startTurn(scope: HTMLElement, value: ReactPresentationFixture) {
  fireEvent.change(within(scope).getByRole("textbox", { name: "Message" }), {
    target: { value: "Keep this turn active" },
  });
  fireEvent.click(within(scope).getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(value.runtime.getSnapshot().active_turn_id).not.toBeNull());
}

describe("checked React presentation recipes", () => {
  it("imports and renders all six without package CSS, fonts, or global styling", async () => {
    const headBeforeImport = document.head.innerHTML;
    const documentStyleBefore = document.documentElement.getAttribute("style");
    const bodyStyleBefore = document.body.getAttribute("style");
    const recipes = await import("../examples/react-presentations.js");

    expect(document.head.innerHTML).toBe(headBeforeImport);
    expect(document.documentElement.getAttribute("style")).toBe(documentStyleBefore);
    expect(document.body.getAttribute("style")).toBe(bodyStyleBefore);

    const value = await fixture();
    const components = [
      recipes.ChatDialogRecipe,
      recipes.ChatTabsRecipe,
      recipes.ChatDrawerRecipe,
      recipes.ChatLauncherRecipe,
      recipes.FullPageChatRecipe,
      recipes.CustomHooksChatRecipe,
    ];

    for (const Recipe of components) {
      const rendered = render(
        <Recipe runtime={value.runtime} uploader={value.uploader} />,
      );
      expect(document.querySelectorAll("style, link[rel='stylesheet']")).toHaveLength(0);
      expect(document.querySelectorAll("[style]")).toHaveLength(0);
      document.querySelectorAll("[class]").forEach((element) => {
        expect(element.className).toMatch(/^app-/u);
      });
      expect(document.documentElement.getAttribute("style")).toBe(documentStyleBefore);
      expect(document.body.getAttribute("style")).toBe(bodyStyleBefore);
      rendered.unmount();
    }
  });

  it("exposes named dialog, transcript/live semantics, presence, attachments, and actions", async () => {
    const { ChatDialogRecipe } = await import("../examples/react-presentations.js");
    const value = await fixture();
    render(<ChatDialogRecipe runtime={value.runtime} uploader={value.uploader} />);

    const dialog = screen.getByRole("dialog", { name: "Support chat dialog" });
    expect(within(dialog).getByRole("region", { name: "Support messages" })).toBeTruthy();
    expect(within(dialog).getByRole("list", { name: "Messages" })).toBeTruthy();
    expect(within(dialog).getByRole("status", { name: "Response status" })).toBeTruthy();
    expect(within(dialog).getByRole("status", { name: "Conversation announcements" })
      .getAttribute("aria-live")).toBe("polite");
    expect(within(dialog).getByRole("list", { name: "People in this conversation" }))
      .toBeTruthy();
    expect(within(dialog).getByRole("status", { name: "Typing status" })).toBeTruthy();
    expect(within(dialog).getByRole("form", { name: "Send a support message" })).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Send message" })).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Stop response" })).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Retry" })).toBeTruthy();

    const image = new File(["image"], "example.png", {
      type: "image/png",
      lastModified: 1_700_000_000_000,
    });
    const pdf = new File(["pdf"], "guide.pdf", {
      type: "application/pdf",
      lastModified: 1_700_000_000_001,
    });
    const input = within(dialog).getByLabelText("Attach files");
    expect(input.getAttribute("accept")).toBe(
      "image/jpeg,image/png,image/gif,image/webp,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/csv,text/tab-separated-values",
    );
    fireEvent.change(input, {
      target: { files: [image, pdf] },
    });
    const remove = await within(dialog).findByRole("button", {
      name: "Remove example.png",
    });
    fireEvent.click(remove);
    expect(await within(dialog).findByRole("button", { name: "Remove guide.pdf" })).toBeTruthy();
    await waitFor(() => {
      expect(within(dialog).queryByRole("button", { name: "Remove example.png" })).toBeNull();
    });
  });

  it("renders the named launcher and tabs presentation", async () => {
    const { ChatLauncherRecipe, ChatTabsRecipe } = await import(
      "../examples/react-presentations.js"
    );
    const launcherFixture = await fixture();
    const launcher = render(
      <ChatLauncherRecipe
        runtime={launcherFixture.runtime}
        uploader={launcherFixture.uploader}
      />,
    );
    expect(screen.getByRole("button", { name: "Open support launcher" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Support launcher panel" })).toBeTruthy();
    launcher.unmount();

    const tabsFixture = await fixture();
    render(<ChatTabsRecipe runtime={tabsFixture.runtime} uploader={tabsFixture.uploader} />);
    expect(screen.getByRole("tablist", { name: "Support workspace" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Chat" }).getAttribute("aria-selected"))
      .toBe("true");
    expect(screen.getByRole("tabpanel", { name: "Chat" })).toBeTruthy();
  });

  it.each([
    ["dialog", "ChatDialogRecipe", "Close support dialog", "dialog", "Support chat dialog"],
    ["drawer", "ChatDrawerRecipe", "Close support drawer", "complementary", "Support chat drawer"],
    ["launcher", "ChatLauncherRecipe", "Close support launcher", "region", "Support launcher panel"],
  ] as const)(
    "closing the %s presentation does not request authoritative cancellation",
    async (_label, exportName, closeName, role, accessibleName) => {
      const recipes = await import("../examples/react-presentations.js");
      const Recipe = recipes[exportName];
      const value = await fixture();
      render(<Recipe runtime={value.runtime} uploader={value.uploader} />);
      const shell = screen.getByRole(role, { name: accessibleName });
      await startTurn(shell, value);

      fireEvent.click(within(shell).getByRole("button", { name: closeName }));
      await waitFor(() => {
        expect(screen.queryByRole(role, { name: accessibleName })).toBeNull();
      });
      expect(value.transport.cancellationInputs).toHaveLength(0);
    },
  );

  it("hiding the chat tab does not cancel, while the explicit Stop action does", async () => {
    const { ChatDialogRecipe, ChatTabsRecipe } = await import(
      "../examples/react-presentations.js"
    );
    const tabsFixture = await fixture();
    const tabs = render(
      <ChatTabsRecipe runtime={tabsFixture.runtime} uploader={tabsFixture.uploader} />,
    );
    const panel = screen.getByRole("tabpanel", { name: "Chat" });
    await startTurn(panel, tabsFixture);
    fireEvent.click(screen.getByRole("tab", { name: "Details" }));
    expect(document.querySelector(".app-chat-tabs__panel")?.hasAttribute("hidden"))
      .toBe(true);
    expect(tabsFixture.transport.cancellationInputs).toHaveLength(0);
    tabs.unmount();

    const dialogFixture = await fixture();
    render(
      <ChatDialogRecipe runtime={dialogFixture.runtime} uploader={dialogFixture.uploader} />,
    );
    const dialog = screen.getByRole("dialog", { name: "Support chat dialog" });
    await startTurn(dialog, dialogFixture);
    fireEvent.click(within(dialog).getByRole("button", { name: "Stop response" }));
    await waitFor(() => {
      expect(dialogFixture.transport.cancellationInputs).toHaveLength(1);
    });
  });
});
