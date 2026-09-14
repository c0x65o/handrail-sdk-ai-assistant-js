import { createRoot } from "react-dom/client";
import { AssistantLauncher } from "./assistant/client.js";

const root = document.getElementById("root");
if (!root) throw new Error("The application root is missing.");
createRoot(root).render(<main><h1>Assistant</h1><AssistantLauncher /></main>);
