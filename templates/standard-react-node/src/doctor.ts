import { readConfig } from "./config.js";
try {
  readConfig();
  console.log("Server configuration is present. This check makes no database or provider requests.");
  console.log("Connect and test host identity/CSRF, run the authorized SDK migration, then verify authenticated /api/assistant/capabilities and new history/reload.");
} catch (error) {
  console.error(error instanceof Error ? error.message : "Server configuration is invalid.");
  process.exitCode = 1;
}
