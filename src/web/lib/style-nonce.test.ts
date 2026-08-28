// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { documentStyleNonce, withStyleNonce } from "./style-nonce.js";

afterEach(() => {
  document.head.innerHTML = "";
});

describe("documentStyleNonce", () => {
  it("reads the per-response nonce the server wrote into the document", () => {
    const meta = document.createElement("meta");
    meta.name = "csp-nonce";
    meta.content = "server-nonce-abc";
    document.head.appendChild(meta);

    expect(documentStyleNonce()).toBe("server-nonce-abc");
  });

  it("ignores the build-time placeholder, which means the document was never served by our own server", () => {
    const meta = document.createElement("meta");
    meta.name = "csp-nonce";
    meta.content = "__CSP_NONCE__";
    document.head.appendChild(meta);

    expect(documentStyleNonce()).toBeNull();
  });

  it("falls back to reading it off an element that already carries one", () => {
    const style = document.createElement("style");
    style.nonce = "from-an-element";
    document.head.appendChild(style);

    expect(documentStyleNonce()).toBe("from-an-element");
  });

  it("returns null when the page has no nonce at all", () => {
    expect(documentStyleNonce()).toBeNull();
  });
});

describe("withStyleNonce", () => {
  it("stamps the nonce on style elements created inside the callback", () => {
    // xterm creates these itself, sets their textContent, and offers no
    // nonce option — so this is the only seam between it and a CSP with no
    // 'unsafe-inline'. Verified against a real browser: without it,
    // Chromium raises ten style-src-elem violations and applies none of
    // xterm's rules.
    const created = withStyleNonce("abc123", () => {
      const style = document.createElement("style");
      style.textContent = ".x { color: red }";
      return style;
    });

    expect(created.nonce).toBe("abc123");
  });

  it("leaves everything that is not a style element alone", () => {
    const div = withStyleNonce("abc123", () => document.createElement("div"));

    expect(div.getAttribute("nonce")).toBeNull();
  });

  it("restores document.createElement afterwards, including when the callback throws", () => {
    const original = document.createElement;

    withStyleNonce("abc123", () => document.createElement("style"));
    expect(document.createElement).toBe(original);

    expect(() =>
      withStyleNonce("abc123", () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    // A patched global left behind would stamp a nonce on every style
    // element the app ever creates — the patch has to be as short-lived as
    // the call that needs it.
    expect(document.createElement).toBe(original);

    const after = document.createElement("style");
    expect(after.nonce).toBe("");
  });

  it("does nothing at all when there is no nonce to stamp", () => {
    const original = document.createElement;

    const style = withStyleNonce(null, () => document.createElement("style"));

    expect(style.nonce).toBe("");
    expect(document.createElement).toBe(original);
  });
});
