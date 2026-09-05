// CineOps Guardian — UI bootstrap (DP-UI WU-UI-07 + visual identity §11).
import { createRoot } from "react-dom/client";
import { setTheme } from "src/platform/ui/index.js";
import { App } from "./App.js";
import "./visual-identity.css";
import { applyTheme, getInitialTheme } from "./ThemeToggle.js";

setTheme("operator");
applyTheme(getInitialTheme());

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(<App />);
