import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import type { FilePreview, WorkingTreeListing } from "../../shared/ws-protocol.js";
import { languageFor, tokenise } from "./highlight.js";

/**
 * Reads from one Thread's working tree — the Worktree when the Thread has
 * been promoted, the Project's workspace root otherwise (spec #93 story 11).
 *
 * Spec #93: "One server-side module owns 'resolve this Thread's working tree
 * and read from it', and every new read command goes through it. Path
 * containment is enforced there, once, rather than per command handler."
 *
 * So containment lives in `resolveWithin` and every operation here goes
 * through it. Phases 5 (search) and 6 (changed files, per-file diffs) add
 * their operations to this module rather than to their command handlers.
 */

/**
 * Tokenised above this and the payload stays a sane thing to send a phone.
 * Token JSON is several times bulkier than the text it describes, which is
 * the whole cost of tokenising server-side.
 */
const TOKENISE_MAX_BYTES = 64 * 1024;

/**
 * Above this a file isn't previewed at all. Story 13: opening a build
 * artefact by accident has to be recoverable, not a hang. Between the two
 * bounds a file is still perfectly readable — just uncoloured — so refusing
 * there would be worse than useless.
 */
const PREVIEW_MAX_BYTES = 256 * 1024;

/** git's own heuristic: a NUL in the first few KiB means binary. Cheap, and wrong rarely enough that git ships it. */
const BINARY_SNIFF_BYTES = 8 * 1024;

/**
 * The one name hidden from the browser.
 *
 * Dotfiles are deliberately shown — `.github/`, `.gitignore`, `.env.example`
 * are all things you open when reviewing what the agent did. `.git` is the
 * exception because it isn't content: it's the repository's internals plus
 * ArgusDE's own checkpoint refs, and listing it first (which alphabetically
 * it is) invites browsing thousands of loose objects to no purpose.
 */
const HIDDEN_ENTRIES = new Set([".git"]);

/**
 * Resolves a client-supplied relative path against the working tree, or
 * throws if it lands outside.
 *
 * This is the security boundary for every working-tree read, and it has to
 * survive more than `..`:
 *
 * - **Separator-aware containment.** A plain `resolved.startsWith(root)`
 *   accepts `/repo-evil` as inside `/repo`. The check compares path
 *   segments, not string prefixes.
 * - **Symlinks, which a lexical check waves straight through.** A link
 *   inside the repository pointing at `/etc` involves no `..` and no segment
 *   outside the root, so both the root *and* the resolved target are
 *   realpathed before comparison. The root is realpathed too because it may
 *   itself sit under a symlinked path (`/tmp` on macOS, for one).
 * - **No path disclosure on refusal.** The error names neither the resolved
 *   path nor what was found there, so a refused read can't be used to probe
 *   what exists outside the tree.
 */
export function resolveWithin(root: string, relativePath: string): string {
  const realRoot = fsSync.realpathSync(root);
  // path.resolve on the joined path collapses "..", and an absolute
  // relativePath would override the root entirely — which is why the
  // containment check below is what decides, not this line.
  const target = path.resolve(realRoot, relativePath);

  // realpath needs the path to exist. When it doesn't, fall back to checking
  // the nearest ancestor that does: a symlink can only redirect a segment
  // that is actually there, so this still catches escape via link while
  // letting a plain "no such file" surface from the caller's own read.
  const resolved = realpathOfNearestExisting(target);

  if (!isInside(realRoot, resolved)) {
    throw new Error(`Path is outside this Thread's working tree: ${relativePath}`);
  }
  return target;
}

function realpathOfNearestExisting(target: string): string {
  let candidate = target;
  for (;;) {
    try {
      return fsSync.realpathSync(candidate);
    } catch {
      const parent = path.dirname(candidate);
      // At the filesystem root nothing further can be resolved; hand back
      // what we have and let the containment check reject it.
      if (parent === candidate) return target;
      candidate = parent;
    }
  }
}

function isInside(root: string, candidate: string): boolean {
  if (candidate === root) return true;
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/** Root-relative, so nothing outside the tree is ever named on the wire. Empty string is the root itself. */
function toRelative(root: string, absolute: string): string {
  return path.relative(root, absolute).split(path.sep).join("/");
}

export async function listDirectory(root: string, relativePath: string): Promise<WorkingTreeListing> {
  const absolute = resolveWithin(root, relativePath);
  const dirents = await fs.readdir(absolute, { withFileTypes: true });

  // Directories first, then files, alphabetical within each — the ordering
  // that makes a tree scannable. Dotfiles are included, unlike the
  // project-root picker: .github/, .gitignore and .env.example are all
  // things you open when reviewing what the agent did.
  const entries = dirents
    .filter((dirent) => !HIDDEN_ENTRIES.has(dirent.name))
    .map((dirent) => ({
      name: dirent.name,
      path: toRelative(root, path.join(absolute, dirent.name)),
      kind: dirent.isDirectory() ? ("directory" as const) : ("file" as const),
    }))
    .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "directory" ? -1 : 1));

  const here = toRelative(root, absolute);
  return {
    path: here,
    // null at the root, so browsing can never walk out of the tree — the
    // client has no "up" to offer there.
    parentPath: here === "" ? null : toRelative(root, path.dirname(absolute)),
    entries,
  };
}

export async function readFile(root: string, relativePath: string): Promise<FilePreview> {
  const absolute = resolveWithin(root, relativePath);
  const { size } = await fs.stat(absolute);
  const here = toRelative(root, absolute);

  // Binary is checked before size, so a 300 MiB archive reads as "binary"
  // rather than the less useful "too large" — the user learns what it is,
  // not just that it didn't fit.
  if (await looksBinary(absolute)) {
    return { path: here, kind: "binary", byteLength: size, language: null, lines: null, plainLines: null };
  }

  if (size > PREVIEW_MAX_BYTES) {
    return { path: here, kind: "too-large", byteLength: size, language: null, lines: null, plainLines: null };
  }

  const source = await fs.readFile(absolute, "utf8");
  const language = languageFor(here);

  if (size > TOKENISE_MAX_BYTES || language === null) {
    return { path: here, kind: "text", byteLength: size, language, lines: null, plainLines: source.split("\n") };
  }

  const lines = await tokenise(source, language);
  return lines === null
    ? { path: here, kind: "text", byteLength: size, language: null, lines: null, plainLines: source.split("\n") }
    : { path: here, kind: "text", byteLength: size, language, lines, plainLines: null };
}

async function looksBinary(absolute: string): Promise<boolean> {
  const handle = await fs.open(absolute, "r");
  try {
    const buffer = Buffer.alloc(BINARY_SNIFF_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, BINARY_SNIFF_BYTES, 0);
    return buffer.subarray(0, bytesRead).includes(0);
  } finally {
    await handle.close();
  }
}
