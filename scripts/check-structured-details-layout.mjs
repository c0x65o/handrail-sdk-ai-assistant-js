import assert from "node:assert/strict";
import console from "node:console";
import process from "node:process";
import { mkdir, writeFile } from "node:fs/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { chromium } from "playwright";
import { createInitialConversationState } from "../dist/conversation/state.js";
import { StandardApprovalCard, handrailChatPresetCss } from "../dist/react-styled/index.js";

// Synthetic component qualification, with no account, provider or business action.
const arguments_ = {
  title: "Enhancement: all-in-one Compose tech-to-resource control",
  status: "todo", priority: "normal",
  description: "Build a unified Compose tech-to-resource control covering backup verification, nightly configuration comparisons, SSH discovery, and verified port-to-server mapping.",
  resources: [{ host_name: "hc-220-private-dc", verify_backups: true }],
};
const proposal = { proposal_id: "layout", tool_name: "tasks_create", status: "pending",
  expires_at: "2099-01-01T00:00:00.000Z", reviewed_arguments: { type: "redacted_json", value: arguments_ } };
const browser = await chromium.launch({ headless: true,
  ...(process.env.HANDRAIL_TEST_CHROMIUM ? { executablePath: process.env.HANDRAIL_TEST_CHROMIUM } : {}),
});
const output = process.env.HANDRAIL_DETAILS_SCREENSHOT_DIR;
if (output) await mkdir(output, { recursive: true });
const report = [];
try {
  const page = await browser.newPage();
  await page.route("**/*", route => route.abort());
  for (const width of [320, 390, 1280]) for (const theme of ["light", "dark"]) {
    await page.setViewportSize({ width, height: 1000 });
    const markup = renderToStaticMarkup(createElement(StandardApprovalCard, { proposal,
      context: { state: createInitialConversationState(null), busy: false, readOnly: false, decide: async () => {} },
    }));
    await page.setContent(`<style>body{margin:0;padding:12px;box-sizing:border-box;background:${theme === "dark" ? "#11131c" : "#f6f7fb"}}${handrailChatPresetCss}.hr-chat{height:auto;max-width:780px;margin:auto;padding:12px;box-sizing:border-box}.hr-chat .hr-chat__approval{max-inline-size:none}</style><main class="hr-chat" data-theme="${theme}">${markup}</main>`);
    assert.equal(await page.locator("pre,code").count(), 0);
    assert.equal(await page.getByRole("button", { name: "Confirm" }).isEnabled(), true);
    assert.equal(await page.getByRole("button", { name: "Reject" }).isEnabled(), true);
    await page.keyboard.press("Tab");
    assert.equal(await page.locator("summary").evaluate(node => node.matches(":focus-visible")), true);
    await page.keyboard.press("Enter");
    assert.equal(await page.locator("details").evaluate(node => node.open), false);
    await page.keyboard.press("Enter");
    assert.equal(await page.locator("details").evaluate(node => node.open), true);
    const measure = async () => page.evaluate(() => ({
      viewport: globalThis.innerWidth, page: document.documentElement.scrollWidth,
      overflowing: Array.from(document.querySelectorAll(".hr-details, .hr-details dd, article"))
        .filter(node => node.scrollWidth > node.clientWidth + 1).length,
    }));
    const geometry = await measure();
    assert.ok(geometry.page <= width && geometry.overflowing === 0, JSON.stringify(geometry));
    if (output) await page.screenshot({ path: `${output}/${theme}-${width}.png`, fullPage: true });
    // A long unbroken identifier and larger text must remain readable, not clipped.
    await page.locator(".hr-details__value").first().evaluate(node => { node.textContent = "x".repeat(400); });
    await page.locator(".hr-chat").evaluate(node => { node.style.fontSize = "26px"; });
    const large = await measure();
    assert.ok(large.page <= width && large.overflowing === 0, JSON.stringify(large));
    report.push({ width, theme, geometry, large, keyboard: "passed" });
  }
  if (output) await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2));
  console.log("Approval details: 6 light/dark desktop/mobile layouts, long values, larger text and keyboard checks passed.");
} finally {
  await browser.close();
}
