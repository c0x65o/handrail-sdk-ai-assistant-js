// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { StructuredDetails, StructuredDetailsDisclosure, shouldCollapseStructuredDetails, ToolResult } from "../src/react/index.js";
import type { ConversationToolResultRecord } from "../src/conversation/state.js";

afterEach(cleanup);

it("presents every reviewed field, nested list and exact value without interpreting markup or money", () => {
  const description = "Check backup verification and switch configuration. ".repeat(30);
  const { container } = render(<StructuredDetails value={{
    title: "Compose tech-to-resource control", description,
    paymentDetails: { amount: "0012.3400", currency: "USD", approved: false, retry_count: 0 },
    resources: [{ host_name: "hc-220-private-dc", enabled: true }, "https://example.test/", null],
    optional_value: null, empty_list: [], empty_object: {}, note: "",
    unsafe_text: '<img src=x onerror="alert(1)">',
  }}/>);
  expect(screen.getByText("Payment Details")).toBeTruthy();
  expect(screen.getByText("Retry count")).toBeTruthy();
  for (const value of [description.trim(), "0012.3400", "USD", "0", "No", "Yes", "hc-220-private-dc",
    "No items", "No fields", "Empty text", '<img src=x onerror="alert(1)">']) {
    expect(screen.getByText(value)).toBeTruthy();
  }
  expect(screen.getAllByText("Not set")).toHaveLength(2);
  expect(screen.getByRole("list").children).toHaveLength(3);
  expect(container.querySelectorAll("dt")).toHaveLength(15);
  expect(container.querySelector("pre, code, img, a")).toBeNull();
});

it("formats typed JSON tool results and preserves ordinary text and custom business renderers", () => {
  const result: ConversationToolResultRecord = { is_error: false, recorded_at: "2026-09-14T12:00:00.000Z" as never,
    attribution: { actor: { type: "tool" }, source: { type: "runtime" } },
    content: [{ type: "text", text: "Saved successfully." },
    { type: "json", value: { task_title: "Verify backups", status: "todo" } }],
  };
  const view = render(<ToolResult result={result}/>);
  expect(screen.getByText("Saved successfully.")).toBeTruthy();
  expect(screen.getByText("Task title").tagName).toBe("DT");
  expect(screen.getByText("Verify backups")).toBeTruthy();
  expect(screen.getByText("todo")).toBeTruthy();
  expect(view.container.querySelector("pre")).toBeNull();
  view.rerender(<ToolResult result={result}><p>Business review card</p></ToolResult>);
  expect(screen.getByText("Business review card")).toBeTruthy();
  expect(screen.queryByText("Verify backups")).toBeNull();
});

const largeReview = { fields: Array.from({ length: 12 }, (_, index) => ({
  label: `Field ${index + 1}`, value: `Exact value ${index + 1}`, amount: "0012.3400",
})) };

it("starts large details closed and preserves the chosen state across refreshed values", async () => {
  const view = render(<StructuredDetailsDisclosure value={largeReview} summary="Saved details"/>);
  const details = view.container.querySelector("details")!;
  expect(details.open).toBe(false);
  fireEvent.click(screen.getByText("Saved details"));
  await waitFor(() => expect(details.open).toBe(true));
  expect(screen.getByText("Exact value 12")).toBeTruthy();
  expect(screen.getAllByText("0012.3400")).toHaveLength(12);
  view.rerender(<StructuredDetailsDisclosure value={structuredClone(largeReview)} summary="Saved details"/>);
  expect(details.open).toBe(true);
  fireEvent.click(screen.getByText("Saved details"));
  await waitFor(() => expect(details.open).toBe(false));
  view.rerender(<StructuredDetailsDisclosure value={structuredClone(largeReview)} summary="Saved details"/>);
  expect(details.open).toBe(false);
});

it("keeps short results readable and collapses long, multiline, nested and many-field data", () => {
  const short = { payee: "Vendor", amount: "0012.3400" };
  expect(shouldCollapseStructuredDetails(short)).toBe(false);
  const view = render(<StructuredDetailsDisclosure value={short}/>);
  expect(view.container.querySelector("details")).toBeNull();
  for (const value of [largeReview, "x".repeat(801), "line\n".repeat(9), { a: { b: { c: { d: { e: 0 } } } } }]) {
    expect(shouldCollapseStructuredDetails(value)).toBe(true);
  }
});

it("collapses large typed tool results without hiding their completion text", () => {
  const result: ConversationToolResultRecord = { is_error: false, recorded_at: "2026-09-14T12:00:00.000Z" as never,
    attribution: { actor: { type: "tool" }, source: { type: "runtime" } },
    content: [{ type: "text", text: "Saved successfully." }, { type: "json", value: largeReview }],
  };
  const { container } = render(<ToolResult result={result}/>);
  expect(screen.getByText("Saved successfully.")).toBeTruthy();
  expect(container.querySelector("details")?.open).toBe(false);
  expect(screen.getByText("Exact value 12")).toBeTruthy();
});
