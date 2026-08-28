/**
 * The one concession this app makes to xterm.js's CSP behaviour (spec #128
 * phase 2).
 *
 * `@xterm/xterm` v6 builds three `<style>` elements — the scrollable
 * element's colours, the DOM renderer's cell-dimension rule, and the theme
 * block — and sets their `textContent`. Under this app's policy
 * (`style-src 'self' 'nonce-…'`, no `unsafe-inline` since #121) Chromium
 * raises ten `style-src-elem` violations and applies **none** of those
 * rules: no colour, no cell metrics.
 *
 * Every mitigation #128 originally listed fails. xterm has no nonce option
 * (the word does not appear in its source or its typings); a renderer addon
 * does not help, because one of the injection sites is in the core
 * scrollable element rather than the DOM renderer; and the content is
 * dynamic, so no fixed hash covers it. `'unsafe-inline'` is not on the
 * table and would be ignored anyway while a nonce is present.
 *
 * So the nonce is handed over the only way available: by stamping it on
 * the elements xterm creates, for exactly as long as it takes xterm to
 * create them. Verified in a real browser — zero violations, all three
 * sheets applied.
 */

/**
 * The nonce the server stamped on this page.
 *
 * Read from the DOM rather than compiled in, because it is per-response
 * (see contentSecurityPolicy in server/http/static-server.ts): a
 * build-time value would be wrong on every request.
 */
export function documentStyleNonce(): string | null {
  // The same source main.tsx hands to Radix (argusde#113) — the server
  // writes the per-response value into this meta tag when it serves the
  // document. One mechanism, not two.
  const meta = document.querySelector<HTMLMetaElement>('meta[name="csp-nonce"]');
  if (meta?.content && meta.content !== "__CSP_NONCE__") return meta.content;
  // Fallback for a document served some other way: read it back off an
  // element that already carries one. The content attribute is hidden from
  // getAttribute by browsers' nonce-hiding, but the IDL property is
  // readable from script on the same page.
  const nonced = document.querySelector<HTMLElement>("style[nonce], link[nonce], script[nonce]");
  return nonced?.nonce || null;
}

/**
 * Runs `create` with `document.createElement` patched so every `<style>`
 * element it produces carries `nonce`.
 *
 * Deliberately scoped to one call rather than installed once at startup: a
 * permanent patch would silently nonce every style element the app ever
 * creates, which is precisely the blanket exemption the CSP exists to
 * withhold. Restored in a `finally`, so a throw inside xterm cannot leave
 * the global patched.
 */
export function withStyleNonce<T>(nonce: string | null, create: () => T): T {
  if (!nonce) return create();

  const original = document.createElement;
  document.createElement = function patchedCreateElement(this: Document, ...args: Parameters<Document["createElement"]>) {
    const element = original.apply(this, args) as HTMLElement;
    if (String(args[0]).toLowerCase() === "style") element.nonce = nonce;
    return element;
  } as Document["createElement"];

  try {
    return create();
  } finally {
    document.createElement = original;
  }
}
