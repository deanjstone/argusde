import path from "node:path";
import { bundledLanguages, createHighlighter, type BundledLanguage, type Highlighter } from "shiki";
import type { SyntaxKind, SyntaxLine } from "../../shared/ws-protocol.js";

/**
 * Syntax highlighting runs on the *server*, and `thread.read-file` ships
 * themed tokens rather than raw text (spec #93 phase 4, decided with the
 * user against a client-side highlighter and against deferring highlighting
 * altogether).
 *
 * The reason is the differentiator this whole spec is justified by: ArgusDE
 * has to be good from a phone over Tailscale. A client-side highlighter puts
 * TextMate grammars on the wire to every device on every load — roughly a
 * 40% bundle increase — for work a Node process can do once, on a machine
 * with no size budget at all.
 *
 * The trade is accepted deliberately: token JSON is bulkier on the wire than
 * the text it describes, which is exactly why tokenising is capped (see
 * TOKENISE_MAX_BYTES in working-tree.ts) rather than applied to any file at
 * any size.
 *
 * **Tokens carry a semantic kind, not a colour.** Not negotiable: the inline
 * style attribute a per-token colour needs is blocked by the UI's CSP (see
 * CONTENT_SECURITY_POLICY in server/http/static-server.ts). It is also what
 * CLAUDE.md asks for — a colour baked into the payload is the same mistake one
 * layer further out — and a short kind costs far less on the wire.
 */

/**
 * shiki needs *a* theme to tokenise against even though only the scopes are
 * kept — the colours it resolves are discarded.
 */
const THEME = "github-dark";

/**
 * Created once and reused. A highlighter loads grammars on demand, so
 * building it eagerly per request would re-pay the setup cost on every file
 * open, while pre-loading all 346 bundled languages at startup would pay for
 * grammars nobody opens.
 *
 * Held as the promise rather than the resolved value so two concurrent first
 * requests share one construction instead of racing to build two.
 */
let highlighterPromise: Promise<Highlighter> | undefined;

function getHighlighter(): Promise<Highlighter> {
  highlighterPromise ??= createHighlighter({ themes: [THEME], langs: [] });
  return highlighterPromise;
}

/**
 * Maps a filename to a shiki language id, or null when there isn't one.
 *
 * Extension first, then whole-filename for the extensionless files a repo is
 * full of. Returning null rather than guessing matters: shiki **throws** on
 * an unrecognised language rather than falling back to plaintext (verified
 * against 4.4.3), so a wrong guess is an error, not a cosmetic miss.
 */
export function languageFor(filePath: string): string | null {
  const name = path.basename(filePath).toLowerCase();
  const byName = FILENAME_LANGUAGES[name];
  if (byName) return byName;

  const extension = path.extname(name).replace(/^\./, "");
  if (!extension) return null;
  const candidate = EXTENSION_LANGUAGES[extension] ?? extension;
  return candidate in bundledLanguages ? candidate : null;
}

/**
 * Extensions whose language id isn't just the extension itself. Everything
 * else falls through to "the extension is the language id", which shiki
 * already gets right for the long tail (ts, tsx, css, json, rs, go, py…) and
 * which is checked against `bundledLanguages` before use.
 */
const EXTENSION_LANGUAGES: Record<string, string> = {
  // shiki accepts "ts"/"js"/"py" as aliases, but the resolved name is shown
  // to the user, so the canonical one is the useful one.
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  py: "python",
  mjs: "javascript",
  cjs: "javascript",
  mts: "typescript",
  cts: "typescript",
  h: "c",
  hpp: "cpp",
  cc: "cpp",
  htm: "html",
  md: "markdown",
  mdx: "mdx",
  yml: "yaml",
  sh: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",
  fish: "fish",
  ps1: "powershell",
  rb: "ruby",
  kt: "kotlin",
  rs: "rust",
  txt: "plaintext",
};

/** Extensionless files common enough in a repository to be worth naming. */
const FILENAME_LANGUAGES: Record<string, string> = {
  dockerfile: "dockerfile",
  makefile: "make",
  ".gitignore": "ini",
  ".gitattributes": "ini",
  ".env": "ini",
  ".env.example": "ini",
  ".npmrc": "ini",
  ".editorconfig": "ini",
};

/**
 * Buckets a TextMate scope into one of the kinds the UI styles.
 *
 * Scope names follow a documented convention (`comment.line.double-slash.ts`,
 * `keyword.control.flow.ts`), so prefix matching on the *most specific* scope
 * is enough — no per-language special-casing. Ordered most specific first:
 * `constant.numeric` has to beat `constant`.
 */
function kindForScope(scope: string): SyntaxKind {
  if (scope.startsWith("comment")) return "comment";
  if (scope.startsWith("string")) return "string";
  if (scope.startsWith("constant.numeric")) return "number";
  if (scope.startsWith("constant")) return "constant";
  if (scope.startsWith("keyword") || scope.startsWith("storage")) return "keyword";
  if (scope.startsWith("entity.name.function") || scope.startsWith("support.function")) return "function";
  if (scope.startsWith("entity.name") || scope.startsWith("support.type") || scope.startsWith("support.class")) return "type";
  if (scope.startsWith("variable")) return "variable";
  if (scope.startsWith("punctuation")) return "punctuation";
  return "plain";
}

/**
 * Tokenises source text into lines of semantically-kinded tokens.
 *
 * A language that fails to load degrades to untokenised lines rather than
 * failing the read — a preview without colour is useful, and a grammar
 * problem in one of 346 languages must not turn "open this file" into an
 * error. The fallback is the handling, and it is not silent: the failure is
 * logged, and the caller can tell because it gets null back.
 */
export async function tokenise(source: string, language: string): Promise<SyntaxLine[] | null> {
  const highlighter = await getHighlighter();
  try {
    if (!highlighter.getLoadedLanguages().includes(language)) {
      await highlighter.loadLanguage(language as BundledLanguage);
    }
    const { tokens } = highlighter.codeToTokens(source, {
      lang: language as BundledLanguage,
      theme: THEME,
      // Scopes are the payload; the resolved colours are discarded.
      includeExplanation: "scopeName",
    });

    return tokens.map((line) =>
      line.map((token) => {
        // The last scope is the most specific one the grammar matched.
        const scopes = token.explanation?.flatMap((part) => part.scopes.map((scope) => scope.scopeName)) ?? [];
        const mostSpecific = scopes[scopes.length - 1] ?? "";
        return { content: token.content, kind: kindForScope(mostSpecific) };
      }),
    );
  } catch (error) {
    // Logged rather than swallowed: the null return is a deliberate,
    // user-visible fallback (the file still opens, badged "not highlighted"),
    // but a grammar that consistently fails is a real problem in one of 346
    // languages and would otherwise be invisible to whoever runs the server.
    console.warn(`argusde: could not highlight as ${language}:`, error instanceof Error ? error.message : error);
    return null;
  }
}

/** Releases the shared highlighter — only needed so a test process can exit promptly. */
export async function disposeHighlighter(): Promise<void> {
  if (!highlighterPromise) return;
  const highlighter = await highlighterPromise;
  highlighter.dispose();
  highlighterPromise = undefined;
}
