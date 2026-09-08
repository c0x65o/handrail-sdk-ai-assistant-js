// @vitest-environment jsdom
import fixtures from "./fixtures/markdown.json" with { type: "json" };
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HandrailMarkdown } from "../src/react-markdown/index.js";

afterEach(cleanup);

describe("shared SDK Markdown contract", () => {
  it.each(fixtures.filter(f => f.headers))("renders $id with semantic, aligned table cells", fixture => {
    const { container } = render(<HandrailMarkdown>{fixture.markdown}</HandrailMarkdown>);
    const table = within(container).getByRole("table");
    const headers = within(table).getAllByRole("columnheader");
    expect(headers.map(node => node.textContent)).toEqual(fixture.headers);
    expect(within(table).getAllByRole("cell").map(node => node.textContent)).toEqual(fixture.cells);
    expect(headers.map(node => node.style.textAlign || "left")).toEqual(fixture.alignments);
    const region = within(container).getByRole("region", { name: "Markdown table" });
    expect(region.style.overflowX).toBe("auto");
    expect(region.tabIndex).toBe(0);
  });

  it("retains nested formatting, lists, quotes, and literal fenced code", () => {
    const { container } = render(<HandrailMarkdown>{fixtures[1]!.markdown}</HandrailMarkdown>);
    expect(container.querySelector("strong em")?.textContent).toBe("italic");
    expect(container.querySelector("ol li ul li")?.textContent).toBe("Nested");
    expect(container.querySelector("blockquote")?.textContent).toContain("Quoted");
    expect(container.querySelector("pre code")?.textContent).toContain("| literal | code |");
    expect(container.querySelector("table")).toBeNull();
  });

  it("accepts every streamed prefix and finishes as a table", () => {
    const text = fixtures[0]!.markdown;
    const view = render(<HandrailMarkdown>{""}</HandrailMarkdown>);
    for (let length = 1; length <= text.length; length++) {
      view.rerender(<HandrailMarkdown>{text.slice(0, length)}</HandrailMarkdown>);
    }
    expect(within(view.container).getAllByRole("cell")).toHaveLength(6);
  });

  it("keeps user input literal and prevents unsafe navigation or raw HTML execution", () => {
    const onLinkClick = vi.fn();
    const view = render(<HandrailMarkdown onLinkClick={onLinkClick}>{fixtures[3]!.markdown}</HandrailMarkdown>);
    expect(view.container.querySelector("img, script")).toBeNull();
    expect(within(view.container).getAllByRole("link")).toHaveLength(1);
    fireEvent.click(within(view.container).getByRole("link", { name: "Safe" }));
    expect(onLinkClick.mock.calls[0]?.[0]).toBe("https://example.com");
    view.rerender(<HandrailMarkdown role="user">{fixtures[0]!.markdown}</HandrailMarkdown>);
    expect(view.container.textContent).toBe(fixtures[0]!.markdown);
    expect(view.container.querySelector("table, strong")).toBeNull();
  });

  it("lets hosts disable links or keep navigation in the same window", () => {
    const view = render(<HandrailMarkdown linkMode="disabled">{"[Details](/records/1)"}</HandrailMarkdown>);
    expect(view.container.querySelector("a")).toBeNull();
    view.rerender(<HandrailMarkdown linkMode="same-window">{"[Details](/records/1)"}</HandrailMarkdown>);
    expect(view.container.querySelector("a")?.getAttribute("href")).toBe("/records/1");
    expect(view.container.querySelector("a")?.getAttribute("target")).toBeNull();
  });
});
