// CineOps Guardian — UI bootstrap (DP-UI WU-UI-07).
import { createRoot } from "react-dom/client";
import { setTheme } from "src/platform/ui/index.js";
import { App } from "./App.js";

setTheme("operator");

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(<App />);
