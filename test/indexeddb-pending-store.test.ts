import { IDBFactory } from "fake-indexeddb";
import { expect, it } from "vitest";
import { IndexedDBApplicationConversationPendingStore } from "../src/browser/indexeddb-pending-store.js";
import { prepareApplicationConversationSubmission } from "../src/client/session-submission.js";

const submission = (conversation = "chat", operation = "one") => prepareApplicationConversationSubmission({
  conversationId: conversation as never, clientId: "client" as never, revision: 0, operationId: operation,
  now: "2026-09-16T12:00:00.000Z", input: { content: "Saved question", request: { text: "Saved question" } } });

it("upgrades the original pending journal without losing an unconfirmed send", async () => {
  const indexedDB = new IDBFactory(), value = submission(), json = JSON.stringify(value);
  const original = await new Promise<IDBDatabase>((resolve, reject) => {
    const opening = indexedDB.open("handrail-ai-pending-v1", 1);
    opening.onupgradeneeded = () => {
      const store = opening.result.createObjectStore("pending", { keyPath: ["scope", "conversation"] }); store.createIndex("scope", "scope");
    };
    opening.onerror = () => reject(opening.error); opening.onsuccess = () => resolve(opening.result);
  });
  await new Promise<void>((resolve, reject) => {
    const tx = original.transaction("pending", "readwrite");
    tx.objectStore("pending").put({ scope: "account:api", conversation: "chat", json, bytes: new TextEncoder().encode(json).byteLength });
    tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
  });
  original.close();
  const upgraded = new IndexedDBApplicationConversationPendingStore({ indexedDB, scope: "account:api" });
  try {
    expect(await upgraded.load("chat")).toEqual(value);
    await upgraded.writeDraft("chat", "separate unsent text", null);
    expect((await upgraded.readDraft("chat"))?.text).toBe("separate unsent text");
    expect(await upgraded.load("chat")).toEqual(value);
  } finally { upgraded.close(); }
});

it("persists exact retry intent across adapters, isolates accounts/APIs, and acknowledges only the matching send", async () => {
  const indexedDB = new IDBFactory(), options = { indexedDB, scope: "account-a:api-one" };
  const first = new IndexedDBApplicationConversationPendingStore(options), value = submission();
  await first.retain(value); first.close();
  const reopened = new IndexedDBApplicationConversationPendingStore(options);
  const other = new IndexedDBApplicationConversationPendingStore({ indexedDB, scope: "account-b:api-one" });
  const otherApi = new IndexedDBApplicationConversationPendingStore({ indexedDB, scope: "account-a:api-two" });
  try {
    expect(await reopened.load("chat")).toEqual(value); expect(await other.load("chat")).toBeNull(); expect(await otherApi.load("chat")).toBeNull();
    await reopened.acknowledge(submission("chat", "different")); expect(await reopened.load("chat")).toEqual(value);
    await reopened.acknowledge(value); expect(await reopened.load("chat")).toBeNull();
    await expect(first.load("chat")).rejects.toThrow("closed");
  } finally { reopened.close(); other.close(); otherApi.close(); }
});

it("arbitrates concurrent tabs transactionally without overwriting an uncertain message", async () => {
  const options = { indexedDB: new IDBFactory(), scope: "account:api" };
  const a = new IndexedDBApplicationConversationPendingStore(options), b = new IndexedDBApplicationConversationPendingStore(options);
  try {
    const values = [submission(), submission("chat", "two")];
    const results = await Promise.allSettled([a.retain(values[0]!), b.retain(values[1]!)]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const saved = await a.load("chat"); expect(values).toContainEqual(saved);
    await expect(b.retain(saved!)).resolves.toBeUndefined(); expect(await b.load("chat")).toEqual(saved);
  } finally { a.close(); b.close(); }
});

it("bounds pending intents without evicting them and erases only the selected account", async () => {
  const indexedDB = new IDBFactory(), a = new IndexedDBApplicationConversationPendingStore({ indexedDB, scope: "a" });
  const b = new IndexedDBApplicationConversationPendingStore({ indexedDB, scope: "b" });
  try {
    for (let i = 0; i < 32; i++) await a.retain(submission(`chat${i}`));
    await expect(a.retain(submission("overflow"))).rejects.toThrow("full");
    await b.retain(submission("chat0")); await a.eraseAccount();
    expect(await a.load("chat0")).toBeNull(); expect(await a.load("chat31")).toBeNull(); expect(await b.load("chat0")).not.toBeNull();
  } finally { a.close(); b.close(); }
});

it("requires an explicit storage partition and refuses malformed journal data", async () => {
  expect(() => new IndexedDBApplicationConversationPendingStore({ scope: "" })).toThrow("scope");
  const store = new IndexedDBApplicationConversationPendingStore({ indexedDB: new IDBFactory(), scope: "account:api" });
  try { await expect(store.retain({ ...submission(), messageId: "wrong" as never })).rejects.toThrow();
    expect(await store.load("chat")).toBeNull(); } finally { store.close(); }
});
