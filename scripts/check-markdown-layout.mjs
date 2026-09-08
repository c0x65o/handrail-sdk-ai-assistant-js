import process from "node:process";
import console from "node:console";
import { URL } from "node:url";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { chromium } from "playwright";
import { HandrailMarkdown } from "../dist/react-markdown/index.js";

// A component layout test with synthetic data, not an application/preview session.
const fixtures = JSON.parse(await readFile(new URL("../test/fixtures/markdown.json", import.meta.url), "utf8"));
const wide = "| Asset | Owner | Value | Notes |\n| :--- | :---: | ---: | --- |\n" +
  "| **Cash** | Family office treasury | $100 | " + "long-unbroken-value-".repeat(16) + " |";
const browser = await chromium.launch({
  headless: true,
  ...(process.env.HANDRAIL_TEST_CHROMIUM ? { executablePath: process.env.HANDRAIL_TEST_CHROMIUM } : {}),
});
try {
  const page = await browser.newPage();
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    const markup = renderToStaticMarkup(createElement(HandrailMarkdown, { children: wide }));
    await page.setContent(`<style>body{margin:0;padding:12px;box-sizing:border-box}main{display:flex;min-width:0}article{min-width:0;max-width:100%}</style><main><article>${markup}</article></main>`);
    const geometry = await page.evaluate(() => {
      const region = globalThis.document.querySelector('[role="region"]');
      region.scrollLeft = 100;
      return { pageWidth: globalThis.document.documentElement.scrollWidth, viewport: globalThis.innerWidth,
        client: region.clientWidth, content: region.scrollWidth, scrollLeft: region.scrollLeft };
    });
    assert.ok(geometry.pageWidth <= geometry.viewport, JSON.stringify(geometry));
    assert.ok(geometry.content > geometry.client, JSON.stringify(geometry));
    assert.ok(geometry.scrollLeft > 0, JSON.stringify(geometry));
    await page.getByRole("region", { name: "Markdown table" }).focus();
    await page.getByRole("region", { name: "Markdown table" }).evaluate(node => { node.scrollLeft = 0; });
    await page.keyboard.press("ArrowRight");
    await page.waitForFunction(() => globalThis.document.querySelector('[role="region"]').scrollLeft > 0);
    if (process.env.HANDRAIL_MARKDOWN_SCREENSHOT_DIR) {
      await page.screenshot({ path: `${process.env.HANDRAIL_MARKDOWN_SCREENSHOT_DIR}/markdown-${width}.png` });
    }
    console.log(`Markdown layout ${width}px: contained table, horizontal scrolling verified`);
  }
  // Complete fixtures and truncated streaming tails must not widen the page.
  await page.setViewportSize({ width: 320, height: 844 });
  for (const fixture of fixtures) {
    for (const length of [Math.floor(fixture.markdown.length / 2), fixture.markdown.length]) {
      await page.setContent(renderToStaticMarkup(createElement(HandrailMarkdown,
        { children: fixture.markdown.slice(0, length) })));
      assert.ok(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth));
    }
  }
} finally {
  await browser.close();
}
