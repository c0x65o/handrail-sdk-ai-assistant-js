import express from "express";
import { resolve } from "node:path";
import { createAiDiagnosticLoggerSink } from "@handrail/ai-assistant";
import { openaiResponses } from "@handrail/ai-assistant/server/assistant";
import { createDatabase } from "./assistant/host/database.js";
import { createApplicationAssistant, stopAssistant } from "./assistant/server.js";
import { readConfig } from "./config.js";

const config = readConfig();
const database = createDatabase(config.connectionString);
const assistant = await createApplicationAssistant({ persistence: database.persistence,
  diagnostics: createAiDiagnosticLoggerSink(console),
  provider: openaiResponses({ apiKey: config.apiKey, model: config.model }) })
  .catch(async (error: unknown) => { await database.pool.end(); throw error; });
const app = express();
app.disable("x-powered-by");
// Mount before JSON/body parsers so SDK multipart/audio/file intake stays intact.
app.use("/api/assistant", assistant.express({ origin: config.origin }));
app.use(express.static(resolve("dist/client")));
app.use((request, response) => request.method === "GET"
  ? response.sendFile(resolve("dist/client/index.html")) : response.sendStatus(404));
const server = app.listen(config.port, () => console.log(`Assistant application listening on port ${config.port}.`));
let stopping = false;
async function shutdown() {
  if (stopping) return; stopping = true;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  try { await stopAssistant(assistant); } finally { await database.pool.end(); }
}
function requestShutdown() {
  void shutdown().catch(() => { console.error("Assistant shutdown failed; inspect server diagnostics."); process.exitCode = 1; });
}
process.once("SIGINT", requestShutdown);
process.once("SIGTERM", requestShutdown);
