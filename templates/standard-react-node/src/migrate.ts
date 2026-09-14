import { createDatabase } from "./assistant/host/database.js";
import { required } from "./config.js";

// Invoke only through the host's authorized migration workflow. The web server
// never runs migration or a historical data purge on startup.
const database = createDatabase(required("DATABASE_URL"));
try { await database.persistence.persistence.migrate(); console.log("SDK persistence migrations applied."); }
finally { await database.pool.end(); }
