/** @vitest-environment jsdom */
import { StrictMode } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { OutgoingDeliveryStatus } from "../src/react/outgoing-delivery-status.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => { cleanup(); vi.useRealTimers(); });

it("keeps a quick send silent even when its saved history is slow to arrive", () => {
  const scope = {};
  const view = render(<OutgoingDeliveryStatus scope={scope} status="sending"/>);
  act(() => { vi.advanceTimersByTime(1999); });
  expect(view.container.textContent).toBe("");
  view.rerender(<OutgoingDeliveryStatus scope={scope} status="sent"/>);
  act(() => { vi.advanceTimersByTime(10000); });
  expect(view.container.childElementCount).toBe(0);
});

it("shows sending at two seconds and sent only after that delayed send", () => {
  const scope = {};
  const view = render(<StrictMode><OutgoingDeliveryStatus scope={scope} status="sending"/></StrictMode>);
  act(() => { vi.advanceTimersByTime(2000); });
  expect(view.getByRole("status").textContent).toBe("Sending…");
  view.rerender(<StrictMode><OutgoingDeliveryStatus scope={scope} status="sent"/></StrictMode>);
  expect(view.getByRole("status").textContent).toBe("Sent");
  view.unmount();
  expect(vi.getTimerCount()).toBe(0);
});

it("shows uncertainty immediately and gives a retried send its own wait", () => {
  const scope = {};
  const view = render(<OutgoingDeliveryStatus scope={scope} status="sending"/>);
  act(() => { vi.advanceTimersByTime(100); });
  view.rerender(<OutgoingDeliveryStatus scope={scope} status="unconfirmed"/>);
  expect(view.getByRole("status").textContent).toContain("Send unconfirmed");
  view.rerender(<OutgoingDeliveryStatus scope={scope} status="sending"/>);
  act(() => { vi.advanceTimersByTime(1999); });
  expect(view.queryByRole("status")).toBeNull();
  act(() => { vi.advanceTimersByTime(1); });
  expect(view.getByRole("status").textContent).toBe("Sending…");
});

it("resets for another message or account and cancels on unmount", () => {
  const scope = {}, other = {};
  const view = render(<OutgoingDeliveryStatus key="a" scope={scope} status="sending"/>);
  act(() => { vi.advanceTimersByTime(2000); });
  view.rerender(<OutgoingDeliveryStatus key="b" scope={scope} status="sending"/>);
  expect(view.queryByRole("status")).toBeNull();
  act(() => { vi.advanceTimersByTime(2000); });
  view.rerender(<OutgoingDeliveryStatus key="b" scope={other} status="sending"/>);
  expect(view.queryByRole("status")).toBeNull();
  view.unmount();
  expect(vi.getTimerCount()).toBe(0);
});
