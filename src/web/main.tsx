import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "./index.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root element not found");
createRoot(root).render(<App />);

// Installability only — sw.js deliberately does no caching. The UI is
// always served fresh from the server (spec #33's version-compatibility
// design: no client-side bundle to go stale), so a service worker that
// cached the app bundle could keep serving stale, API-incompatible code
// after the server moves on. See sw.js for the enforced-empty cache story.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((error) => console.error("Service worker registration failed:", error));
  });
}
