// PROTOTYPE — throwaway (argusde#90). Dev-only entry, never built by build:web.
import { createRoot } from "react-dom/client";
import { PrototypeApp } from "./prototype-app.js";
import "../../index.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root element not found");
createRoot(root).render(<PrototypeApp />);
