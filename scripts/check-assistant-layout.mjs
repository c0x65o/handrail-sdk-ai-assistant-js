import assert from "node:assert/strict";
import process from "node:process";
import console from "node:console";
import { mkdir } from "node:fs/promises";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { chromium } from "playwright";
import { createInitialConversationState } from "../dist/index.js";
import { ConversationHistoryPanel, StyledChatPreset, StyledChatPresetStyles } from "../dist/react-styled/index.js";

// Synthetic component geometry only. This does not contact an app or a provider.
const descriptors = Array.from({ length: 16 }, (_, index) => ({ conversationId: `conversation-${index}`,
  title: index === 0 ? "Network topology and cloud resources" : `Conversation ${index + 1}`,
  lifecycle: "active", updatedAt: "2026-09-12T00:00:00.000Z" }));
const noop = () => undefined;
const history = { descriptors, visible: descriptors, snapshot: { selectedConversationId: "conversation-0" },
  selected: descriptors[0], activity: [{ conversationId: "conversation-1", turnStatus: "completed", unread: true }],
  loading: false, loadFailed: false, error: null, busyId: null, failedThreads: new Set(),
  view: "active", unreadOnly: false, unreadCount: 1, setView: noop, setUnreadOnly: noop, create: noop, select: noop,
  changeLifecycle: noop, refresh: noop, preview: () => "A bounded preview of the saved conversation.",
  capabilities: { archive: { supported: true }, restore: { supported: true } } };
const composer = { draft: "", setDraft: noop, attachments: [], errors: [], canSend: false, isSending: false,
  submit: noop, stop: noop, acquireSubmissionBlock: () => noop,
  getTextareaProps: () => ({ value: "", onChange: noop }), getFileInputProps: () => ({}), getDropProps: () => ({}) };
const markup = renderToStaticMarkup(h("div", { className: "hr-chat-workspace", "data-layout": "page" },
  h(StyledChatPresetStyles),
  h("aside", { className: "hr-history", "aria-label": "Conversation history" }, h(ConversationHistoryPanel, { controller: history, includeStyles: false })),
  h(StyledChatPreset, { state: createInitialConversationState("conversation-0"), composer, title: "Cents",
    transcription: { transcribe: async () => "unused" }, composerActions: h("small", null, "0 / 2,000 characters"),
    emptyState: "Ask about company resources.", theme: { colors: { accent: "#bd451d" } },
  })));
const browser = await chromium.launch({ headless: true,
  ...(process.env.HANDRAIL_TEST_CHROMIUM ? { executablePath: process.env.HANDRAIL_TEST_CHROMIUM } : {}) });
try {
  const page = await browser.newPage();
  const screenshots = process.env.HANDRAIL_ASSISTANT_SCREENSHOT_DIR;
  if (screenshots) await mkdir(screenshots, { recursive: true });
  for (const width of [320, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    await page.setContent(`<style>html,body{margin:0;width:100%;height:100%;font-family:Arial,sans-serif}*{box-sizing:border-box}</style>${markup}`);
    const geometry = await page.evaluate(() => {
      const rectangle = (selector) => {
        const box = globalThis.document.querySelector(selector).getBoundingClientRect();
        return { x: box.x, y: box.y, width: box.width, height: box.height, right: box.right, bottom: box.bottom };
      };
      return { width: globalThis.innerWidth, height: globalThis.innerHeight, pageWidth: globalThis.document.documentElement.scrollWidth,
        pageHeight: globalThis.document.documentElement.scrollHeight, history: rectangle(".hr-history"),
        composer: rectangle(".hr-composer"), input: rectangle("textarea"), send: rectangle(".hr-composer__send") };
    });
    assert.ok(geometry.pageWidth <= width, JSON.stringify(geometry));
    assert.ok(geometry.pageHeight <= 844, JSON.stringify(geometry));
    assert.ok(geometry.composer.bottom <= 844 && geometry.input.width > 120 && geometry.send.right <= width, JSON.stringify(geometry));
    assert.ok(geometry.history.height > 120, JSON.stringify(geometry));
    assert.equal(await page.getByRole("button", { name: "Start voice input" }).count(), 1);
    assert.equal(await page.getByText("0 / 2,000 characters").count(), 1);
    if (screenshots) await page.screenshot({ path: `${screenshots}/assistant-${width}.png` });
    console.log(`Assistant layout ${width}px: contained history, composer and microphone/counter verified`);
  }
} finally { await browser.close(); }
