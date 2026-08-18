import { createRoot } from "react-dom/client";
import { setNonce } from "get-nonce";
import { App } from "./App.js";
import "./index.css";

/**
 * Hand the server's per-response CSP nonce to Radix before anything mounts
 * (argusde#113).
 *
 * Radix's overlays lock body scroll through `react-remove-scroll`, which
 * injects a `<style>` element at mount time and stamps it with whatever
 * `get-nonce` returns. Without this the element carries no nonce, the app's
 * `style-src` blocks it, and the overlay opens *degraded* — visible, but with
 * the page still scrolling behind it — plus a console violation.
 *
 * Set here, at the entry point, rather than anywhere nearer a component: the
 * value has to be in place before the first overlay renders, and there is no
 * second chance once a style element has been created without it.
 */
const nonce = document.querySelector<HTMLMetaElement>('meta[name="csp-nonce"]')?.content;
if (nonce) setNonce(nonce);

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
