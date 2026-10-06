/** Synthetic successful read path: no provider, credentials or database. */
export function pollingGateway() {
  const reads: { operation: string; at: number }[] = [];
  let running = false;
  const throttle = new Set<string>();
  const admissions: unknown[] = [];
  const disabled = { supported: false, reason: "not_implemented" };
  const descriptor = { conversationId: "chat", title: "Saved chat", lifecycle: "active", archivedAt: null,
    createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", version: 1, metadata: {} };
  const fetcher: typeof fetch = async (url, init) => {
    const path = String(url), body = init?.body ? JSON.parse(String(init.body)) : {};
    const input = body.input ?? body;
    const operation = path.endsWith("/activity") ? (init?.method === "GET" ? "activity_live" : "activity") : body.operation ?? path.split("/").at(-1)!;
    reads.push({ operation, at: Date.now() });
    if (throttle.delete(operation)) return new Response("Throttled", { status: 429, headers: { "Retry-After": "20" } });
    let value: unknown;
    if (path.endsWith("/capabilities")) value = { protocolVersion: "handrail.application-gateway.v1",
      authoritativeCancellation: false, attachments: false, documentInput: false, presence: false, activity: true, synchronization: false,
      resources: { conversations: { rename: disabled, clear: disabled, archive: disabled, restore: disabled, permanentDelete: disabled },
        approvals: false, titleGeneration: false },
      displayHistory: { version: 1, maximumPageSize: 50, maximumPageBytes: 262144, control: true } };
    else if (operation === "activity_live") return new Response("", { headers: { "Content-Type": "text/event-stream" } });
    else if (path.endsWith("/activity")) value = [];
    else if (path.endsWith("/conversations/list")) value = { items: [descriptor], order: input.order, hasMore: false, nextCursor: null };
    else if (path.endsWith("/conversations/get")) value = { operation: "get", status: "found", descriptor };
    else if (operation === "append_mutations") {
      admissions.push(input);
      return Response.json({ ok: false, error: { code: "unavailable", message: "Synthetic uncertain admission", retryable: true } });
    } else if (path.endsWith("/conversations/history")) {
      const header = { schemaVersion: 1, status: "ready", conversationId: "chat", generation: 0, revision: 1, canonicalRevision: 1,
        activeTurnId: running ? "running" : null };
      const turn = { turnId: "running", revision: 1, status: "running", remoteMayStillBeRunning: true, error: null };
      if (operation === "control") value = { ...header, activeTurn: running ? turn : null, latestTurn: running ? turn : null, requestedTurn: null };
      else if (operation === "changes") value = { ...header, records: [], nextCursor: null, throughRevision: 1 };
      else if (operation === "page") value = { ...header, nextCursor: null, records: body.input.view ? [] : [
        { kind: "message", id: "saved", turnId: null, revision: 1, bytes: 200, deferred: false,
          value: { message_id: "saved", role: "assistant", content: [{ type: "text", text: "Saved reply" }],
            attachments: [], attribution: null, created_at: null } },
      ] };
      else throw new Error(`Unexpected history operation: ${operation}`);
    } else throw new Error(`Unexpected request: ${path}`);
    return Response.json({ ok: true, value });
  };
  return { fetch: fetcher, reads, throttle, admissions, setRunning: (value: boolean) => { running = value; },
    count: (operation: string) => reads.filter(read => read.operation === operation).length };
}
