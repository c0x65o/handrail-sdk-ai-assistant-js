import assert from "node:assert/strict";
import process from "node:process";
import console from "node:console";
import { mkdir } from "node:fs/promises";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { chromium } from "playwright";
import { createInitialConversationState, parseConversationEvent, reduceConversationEvent } from "../dist/index.js";
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
const state = reduceConversationEvent(createInitialConversationState("conversation-0"), parseConversationEvent({
  version: 1, event_id: "compact-message", conversation_id: "conversation-0", revision: 1,
  occurred_at: "2026-09-13T00:00:00.000Z", actor: { type: "assistant" }, source: { type: "import" },
  payload: { type: "message.created", message_id: "compact-message", role: "assistant",
    content: [{ type: "text", text: "Here are the saved details. The shared assistant keeps messages readable while leaving room for the composer." }] },
}));
const compact = renderToStaticMarkup(h(StyledChatPreset, { state, composer,
  title: "A long conversation title that must leave room for the Threads menu",
  layout: "page", theme: { fontFamily: "inherit" },
  conversationPicker: h("details", { className: "hr-history", "data-presentation": "compact" },
    h("summary", null, "Threads"), h("div", { className: "hr-history__panel" },
      h(ConversationHistoryPanel, { controller: history, includeStyles: false }))),
}));
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
  // A wide host viewport must not force a sidebar or viewport-sized controls into
  // a narrow embedded panel. "inherit" must preserve family without dropping size.
  for (const [width, height, touch] of [[300, 520, true], [390, 700, true], [560, 600, false], [760, 640, false], [980, 800, false]]) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, hasTouch: touch });
    const embedded = await context.newPage();
    await embedded.setContent(`<style>html,body{margin:0;font:22px Georgia,serif}*{box-sizing:border-box}.host{margin:16px;width:${width}px;height:${height}px}</style>${renderToStaticMarkup(h(StyledChatPresetStyles))}<div class="host">${compact}</div>`);
    const geometry = await embedded.evaluate(() => {
      const node = (selector) => globalThis.document.querySelector(selector);
      const box = (selector) => { const r = node(selector).getBoundingClientRect(); return { x: r.x, right: r.right, bottom: r.bottom, width: r.width }; };
      return { host: box(".host"), chat: box(".hr-chat"), composer: box(".hr-composer"), send: box(".hr-composer__send"),
        chatSize: globalThis.getComputedStyle(node(".hr-chat")).fontSize, family: globalThis.getComputedStyle(node(".hr-chat")).fontFamily,
        historyFamily: globalThis.getComputedStyle(node(".hr-history")).fontFamily, composerFamily: globalThis.getComputedStyle(node(".hr-composer")).fontFamily, historySize: globalThis.getComputedStyle(node(".hr-history")).fontSize, draftSize: globalThis.getComputedStyle(node("textarea")).fontSize,
        sendHeight: node(".hr-composer__send").getBoundingClientRect().height };
    });
    assert.equal(geometry.chatSize, "13px", JSON.stringify(geometry));
    assert.equal(geometry.historySize, "12px", JSON.stringify(geometry));
    assert.match(geometry.family, /Georgia/u);
    assert.match(geometry.historyFamily, /Georgia/u);
    assert.match(geometry.composerFamily, /Georgia/u);
    assert.equal(geometry.draftSize, touch ? "16px" : "14px");
    if (touch) assert.ok(geometry.sendHeight >= 44);
    assert.ok(geometry.chat.width <= width && geometry.composer.bottom <= geometry.host.bottom && geometry.send.right <= geometry.host.right, JSON.stringify(geometry));
    assert.equal(await embedded.getByRole("button", { name: "New", exact: true }).isVisible(), false);
    await embedded.getByText("Threads", { exact: true }).click();
    const menu = await embedded.locator(".hr-history__panel").boundingBox();
    assert.ok(menu.x >= geometry.host.x && menu.x + menu.width <= geometry.host.right && menu.y + menu.height <= geometry.host.bottom, JSON.stringify({ menu, geometry }));
    assert.ok(await embedded.getByRole("button", { name: "New", exact: true }).isVisible());
    assert.ok(await embedded.getByRole("button", { name: "Archived", exact: true }).isVisible());
    if (screenshots) await embedded.screenshot({ path: `${screenshots}/compact-${width}.png` });
    await context.close();
    console.log(`Compact embedded layout ${width}px: inherited family, compact fonts, contained menu and touch controls verified`);
  }
} finally { await browser.close(); }
