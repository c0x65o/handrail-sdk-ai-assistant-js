/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef, useRef, useState } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ChatLauncherBadge,
  ChatLauncherClose,
  ChatLauncherDescription,
  ChatLauncherPanel,
  ChatLauncherPortal,
  ChatLauncherRoot,
  ChatLauncherStatus,
  ChatLauncherTitle,
  ChatLauncherTrigger,
} from "../src/react/index.js";

afterEach(() => cleanup());

function Launcher({ modal = false }: { modal?: boolean }) {
  return (
    <ChatLauncherRoot modal={modal}>
      <ChatLauncherTrigger>Open chat</ChatLauncherTrigger>
      <ChatLauncherPanel>
        <ChatLauncherTitle>Customer support</ChatLauncherTitle>
        <ChatLauncherDescription>Ask a question</ChatLauncherDescription>
        <ChatLauncherClose>Close chat</ChatLauncherClose>
      </ChatLauncherPanel>
    </ChatLauncherRoot>
  );
}

describe("ChatLauncher", () => {
  it("supports uncontrolled click disclosure with stable ARIA linkage", () => {
    const { rerender } = render(<Launcher />);
    const trigger = screen.getByRole("button", { name: "Open chat" });
    const panelId = trigger.getAttribute("aria-controls");
    expect(panelId).toMatch(/^handrail-chat-launcher-panel-/u);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(trigger.getAttribute("aria-haspopup")).toBeNull();

    fireEvent.click(trigger);
    const panel = screen.getByRole("region", { name: "Customer support" });
    expect(panel.id).toBe(panelId);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(panel.getAttribute("aria-describedby")).toBe(
      screen.getByText("Ask a question").id,
    );

    rerender(<Launcher />);
    expect(screen.getByRole("button", { name: "Open chat" }).getAttribute("aria-controls"))
      .toBe(panelId);
  });

  it("supports controlled state and cancellable consumer handlers", () => {
    const changes: boolean[] = [];
    function Controlled() {
      const [open, setOpen] = useState(false);
      return (
        <ChatLauncherRoot
          open={open}
          onOpenChange={(next) => {
            changes.push(next);
            setOpen(next);
          }}
        >
          <ChatLauncherTrigger>Controlled trigger</ChatLauncherTrigger>
          <ChatLauncherPanel aria-label="Controlled panel">
            <ChatLauncherClose>Controlled close</ChatLauncherClose>
          </ChatLauncherPanel>
        </ChatLauncherRoot>
      );
    }
    render(<Controlled />);
    fireEvent.click(screen.getByRole("button", { name: "Controlled trigger" }));
    expect(screen.getByRole("region", { name: "Controlled panel" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Controlled close" }));
    expect(screen.queryByRole("region")).toBeNull();
    expect(changes).toEqual([true, false]);

    const onOpenChange = vi.fn();
    render(
      <ChatLauncherRoot onOpenChange={onOpenChange}>
        <ChatLauncherTrigger onClick={(event) => event.preventDefault()}>
          Cancelled trigger
        </ChatLauncherTrigger>
      </ChatLauncherRoot>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancelled trigger" }));
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("composes a consumer trigger with handlers, refs, ARIA, and keyboard activation", () => {
    const ref = createRef<HTMLButtonElement>();
    const nativeClick = vi.fn();
    const triggerClick = vi.fn();
    render(
      <ChatLauncherRoot>
        <ChatLauncherTrigger asChild onClick={triggerClick} ref={ref}>
          <button aria-label="Consumer icon" onClick={nativeClick} data-native="yes" />
        </ChatLauncherTrigger>
        <ChatLauncherPanel aria-label="Consumer panel" />
      </ChatLauncherRoot>,
    );
    const consumerButton = screen.getByRole("button", { name: "Consumer icon" });
    expect(ref.current).toBe(consumerButton);
    expect(consumerButton.dataset.native).toBe("yes");
    fireEvent.click(consumerButton);
    expect(nativeClick).toHaveBeenCalledOnce();
    expect(triggerClick).toHaveBeenCalledOnce();
    expect(screen.getByRole("region", { name: "Consumer panel" })).toBeTruthy();

    cleanup();
    render(
      <ChatLauncherRoot>
        <ChatLauncherTrigger asChild>
          <span aria-label="Keyboard icon" />
        </ChatLauncherTrigger>
        <ChatLauncherPanel aria-label="Keyboard panel" />
      </ChatLauncherRoot>,
    );
    const icon = screen.getByRole("button", { name: "Keyboard icon" });
    expect(icon.tabIndex).toBe(0);
    fireEvent.keyDown(icon, { key: "Enter" });
    expect(screen.getByRole("region", { name: "Keyboard panel" })).toBeTruthy();
  });

  it("honors preventDefault from the asChild native handler", () => {
    const onOpenChange = vi.fn();
    render(
      <ChatLauncherRoot onOpenChange={onOpenChange}>
        <ChatLauncherTrigger asChild>
          <button onClick={(event) => event.preventDefault()}>Veto child</button>
        </ChatLauncherTrigger>
      </ChatLauncherRoot>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Veto child" }));
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("exposes unread and runtime status accessibly, through data and render props", () => {
    render(
      <ChatLauncherRoot
        unreadCount={3}
        connectionStatus="connecting"
        turnStatus="error"
      >
        <ChatLauncherTrigger>Statuses</ChatLauncherTrigger>
        <ChatLauncherBadge data-testid="badge">
          {({ unreadCount }) => `${unreadCount}+`}
        </ChatLauncherBadge>
        <ChatLauncherStatus data-testid="status" />
      </ChatLauncherRoot>,
    );
    const badge = screen.getByTestId("badge");
    expect(badge.getAttribute("aria-label")).toBe("3 unread messages");
    expect(badge.textContent).toBe("3+");
    const status = screen.getByTestId("status");
    expect(status.textContent).toBe(
      "3 unread messages",
    );
    expect(status.dataset.busy).toBe("false");
    expect(status.dataset.error).toBe("true");
    expect(status.dataset.connectionStatus).toBe("connecting");
    expect(status.dataset.turnStatus).toBe("error");
    expect(screen.getByRole("button", { name: "Statuses" }).dataset.unreadCount)
      .toBe("3");
  });

  it("shows the current bulk-work summary and progress in the shared launcher status", () => {
    render(
      <ChatLauncherRoot activitySummary="Tracing prior invoice revenue accounts"
        activityProgress={{ completed: 18, total: 43, unit: "products" }} turnStatus="busy">
        <ChatLauncherStatus data-testid="bulk-status" />
      </ChatLauncherRoot>,
    );
    const status = screen.getByTestId("bulk-status");
    expect(status.textContent).toContain("Tracing prior invoice revenue accounts. 18 of 43 products");
    expect(status.dataset.activityCompleted).toBe("18");
    expect(status.dataset.activityTotal).toBe("43");
  });

  it("dismisses with Escape, restores focus, and supports outside veto/configuration", async () => {
    render(
      <>
        <button data-testid="outside">Outside</button>
        <Launcher />
      </>,
    );
    const trigger = screen.getByRole("button", { name: "Open chat" });
    trigger.focus();
    fireEvent.click(trigger);
    screen.getByRole("button", { name: "Close chat" }).focus();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("region")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(trigger));

    cleanup();
    const onOpenChange = vi.fn();
    const veto = vi.fn((event: PointerEvent) => event.preventDefault());
    const { rerender } = render(
      <>
        <button data-testid="outside">Outside</button>
        <ChatLauncherRoot open onOpenChange={onOpenChange}>
          <ChatLauncherPanel aria-label="Veto panel" onInteractOutside={veto} />
        </ChatLauncherRoot>
      </>,
    );
    fireEvent.pointerDown(screen.getByTestId("outside"));
    expect(veto).toHaveBeenCalledOnce();
    expect(onOpenChange).not.toHaveBeenCalled();

    rerender(
      <>
        <button data-testid="outside">Outside</button>
        <ChatLauncherRoot
          open
          onOpenChange={onOpenChange}
          dismissOnOutsideInteraction={false}
        >
          <ChatLauncherPanel aria-label="Configured panel" />
        </ChatLauncherRoot>
      </>,
    );
    fireEvent.pointerDown(screen.getByTestId("outside"));
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("uses a non-modal region without moving or trapping focus", () => {
    render(
      <>
        <button data-testid="outside">Outside</button>
        <Launcher />
      </>,
    );
    const trigger = screen.getByRole("button", { name: "Open chat" });
    trigger.focus();
    fireEvent.click(trigger);
    const region = screen.getByRole("region", { name: "Customer support" });
    expect(document.activeElement).toBe(trigger);
    expect(region.getAttribute("aria-modal")).toBeNull();
    expect(region.getAttribute("tabindex")).toBeNull();
    const outside = screen.getByTestId("outside");
    outside.focus();
    expect(document.activeElement).toBe(outside);
  });

  it("uses modal dialog semantics, initial focus, and focus containment", async () => {
    function ModalLauncher() {
      const initialRef = useRef<HTMLButtonElement>(null);
      return (
        <>
          <button data-testid="outside">Outside</button>
          <ChatLauncherRoot modal defaultOpen>
            <ChatLauncherPanel initialFocusRef={initialRef}>
              <ChatLauncherTitle>Modal support</ChatLauncherTitle>
              <button>First action</button>
              <button ref={initialRef}>Requested action</button>
            </ChatLauncherPanel>
          </ChatLauncherRoot>
        </>
      );
    }
    render(<ModalLauncher />);
    const dialog = screen.getByRole("dialog", { name: "Modal support" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "Requested action" }),
      ),
    );
    screen.getByTestId("outside").focus();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "First action" }),
    );
  });

  it("keeps externally owned stream state alive while the panel is closed", () => {
    function StreamingLauncher() {
      const [chunks, setChunks] = useState(0);
      return (
        <>
          <button onClick={() => setChunks((value) => value + 1)}>Stream chunk</button>
          <ChatLauncherRoot>
            <ChatLauncherTrigger>Streaming trigger</ChatLauncherTrigger>
            <ChatLauncherPanel aria-label="Streaming panel">
              <output aria-label="Chunks">{chunks}</output>
              <ChatLauncherClose>Close stream</ChatLauncherClose>
            </ChatLauncherPanel>
          </ChatLauncherRoot>
        </>
      );
    }
    render(<StreamingLauncher />);
    fireEvent.click(screen.getByRole("button", { name: "Streaming trigger" }));
    expect(screen.getByLabelText("Chunks").textContent).toBe("0");
    fireEvent.click(screen.getByRole("button", { name: "Close stream" }));
    fireEvent.click(screen.getByRole("button", { name: "Stream chunk" }));
    fireEvent.click(screen.getByRole("button", { name: "Streaming trigger" }));
    expect(screen.getByLabelText("Chunks").textContent).toBe("1");
  });

  it("supports portals and server rendering without default presentation or branding", async () => {
    const portalContainer = document.createElement("section");
    document.body.append(portalContainer);
    render(
      <ChatLauncherRoot defaultOpen>
        <ChatLauncherTrigger>Consumer glyph</ChatLauncherTrigger>
        <ChatLauncherPortal container={portalContainer}>
          <ChatLauncherPanel>
            <ChatLauncherTitle>Consumer title</ChatLauncherTitle>
            <ChatLauncherClose>Dismiss</ChatLauncherClose>
          </ChatLauncherPanel>
        </ChatLauncherPortal>
      </ChatLauncherRoot>,
    );
    await waitFor(() =>
      expect(portalContainer.querySelector("[role='region']")).not.toBeNull(),
    );
    for (const element of Array.from(document.querySelectorAll("button, [role='region'], h2"))) {
      expect(element.getAttribute("class")).toBeNull();
      expect(element.getAttribute("style")).toBeNull();
    }
    expect(document.body.textContent).not.toMatch(/handrail/iu);
    expect(document.querySelector("style, link[rel='stylesheet']")).toBeNull();
    expect(() =>
      renderToString(
        <ChatLauncherRoot defaultOpen>
          <ChatLauncherPortal>
            <ChatLauncherPanel aria-label="Server panel" />
          </ChatLauncherPortal>
        </ChatLauncherRoot>,
      ),
    ).not.toThrow();
    portalContainer.remove();
  });
});
