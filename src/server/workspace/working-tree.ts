import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { FilePreview, SearchResults, WorkingTreeListing } from "../../shared/ws-protocol.js";
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

/**
 * Bounds on what one search can return, each reported to the client when it
 * bites (spec #93: "Results are capped and the cap is reported"). A silently
 * truncated result set reads as a complete one, which is worse than a slow
 * search.
 */
export const SEARCH_LIMITS = {
  /** A file with 400 hits tells you nothing a file with 20 doesn't. */
  matchesPerFile: 20,
  /** Enough to judge relevance, bounded for a phone. */
  files: 100,
  /** A minified file's single line can be megabytes; the payload bound that actually matters. */
  lineChars: 300,
  /** git grep over a huge tree is unbounded work, and a client can ask for it. */
  timeoutMs: 10_000,
} as const;

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
const HIDDEN_ENTRY = ".git";

/**
 * True for anything at or under `.git`.
 *
 * Hiding `.git` from listings but still serving reads inside it was
 * incoherent — either it's part of the browsable tree or it isn't — and the
 * incoherence had teeth: `.git/config` routinely holds a remote URL with a
 * credential in it. Refused outright now.
 *
 * Other dotfiles stay readable on purpose. `.env` included: it is the user's
 * own file in their own repository, this is a single-user app, and the client
 * is that same user. `.git` is different because it is machinery rather than
 * content.
 */
function isGitInternal(relativePath: string): boolean {
  return relativePath === HIDDEN_ENTRY || relativePath.startsWith(`${HIDDEN_ENTRY}/`);
}

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
  if (isGitInternal(relativePath.split(path.sep).join("/"))) {
    throw new Error(`Path is outside this Thread's working tree: ${relativePath}`);
  }
  const realRoot = fsSync.realpathSync(root);
  // path.resolve on the joined path collapses "..", and an absolute
  // relativePath would override the root entirely — which is why the
  // containment check below is what decides, not this line.
  const target = path.resolve(realRoot, relativePath);

  // realpath needs the path to exist. When it doesn't, resolve the nearest
  // ancestor that does and re-attach the missing tail: a symlink can only
  // redirect a segment that is actually there, so this still catches escape
  // via link while letting a plain "no such file" surface from the read.
  const resolved = resolveExistingPrefix(target);

  if (!isInside(realRoot, resolved)) {
    throw new Error(`Path is outside this Thread's working tree: ${relativePath}`);
  }

  // The *resolved* path is returned, not the lexical one. Handing back the
  // lexical path meant the caller opened something the check had never
  // actually validated: swap a symlink between the two and the read follows
  // the new target. The window is microseconds, but the agent is a concurrent
  // writer in this very tree, so it is not hypothetical. This does not make
  // the sequence atomic — only openat/O_NOFOLLOW would — but it removes the
  // check-one-path-then-read-another gap entirely.
  return resolved;
}

/**
 * Realpaths as much of `target` as exists and re-attaches the rest verbatim.
 *
 * Resolving only the existing ancestor and *discarding* the tail would let a
 * path escape by pointing at a link that doesn't exist yet, since the
 * containment check would then be judging the ancestor rather than the path
 * actually asked for.
 */
function resolveExistingPrefix(target: string): string {
  const missing: string[] = [];
  let candidate = target;
  for (;;) {
    try {
      return path.join(fsSync.realpathSync(candidate), ...missing.reverse());
    } catch {
      const parent = path.dirname(candidate);
      // At the filesystem root nothing further can be resolved; hand back
      // what we have and let the containment check reject it.
      if (parent === candidate) return target;
      missing.push(path.basename(candidate));
      candidate = parent;
    }
  }
}

function isInside(root: string, candidate: string): boolean {
  if (candidate === root) return true;
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/**
 * Root-relative, so nothing outside the tree is ever named on the wire. Empty
 * string is the root itself.
 *
 * Takes the *real* root deliberately. Measured against the presented root, a
 * symlinked workspace path (`/tmp` is one on macOS) made every emitted path
 * `..`-prefixed and `parentPath` at the root `".."` instead of null — so the
 * module broke its own promise, disclosed the real directory name, and handed
 * clients paths its own containment check would then refuse.
 */
function toRelative(root: string, absolute: string): string {
  return path.relative(fsSync.realpathSync(root), absolute).split(path.sep).join("/");
}

/**
 * Node's fs errors carry the absolute path they failed on, and ws-server
 * relays `error.message` to the client verbatim — which would hand back the
 * server's filesystem layout via a simple ENOENT. Restated with only the
 * relative path the client already sent.
 */
async function statOrFail(absolute: string, relativePath: string) {
  try {
    return await fs.stat(absolute);
  } catch {
    throw new Error(`No such file in this Thread's working tree: ${relativePath}`);
  }
}

export async function listDirectory(root: string, relativePath: string): Promise<WorkingTreeListing> {
  const absolute = resolveWithin(root, relativePath);
  let dirents;
  try {
    dirents = await fs.readdir(absolute, { withFileTypes: true });
  } catch {
    // Same reasoning as statOrFail: no absolute path escapes to the client.
    throw new Error(`Cannot list that path in this Thread's working tree: ${relativePath}`);
  }

  // Directories first, then files, alphabetical within each — the ordering
  // that makes a tree scannable. Dotfiles are included, unlike the
  // project-root picker: .github/, .gitignore and .env.example are all
  // things you open when reviewing what the agent did.
  const entries = dirents
    .filter((dirent) => dirent.name !== HIDDEN_ENTRY)
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
  const stats = await statOrFail(absolute, relativePath);
  const here = toRelative(root, absolute);

  // Regular files only, and checked *before* anything opens the path. A FIFO
  // in the working tree parks a libuv threadpool thread forever on open() —
  // four such requests starve every filesystem operation the server can make.
  // Directories and devices land here too, which is the right answer for them.
  if (!stats.isFile()) {
    throw new Error(`Not a regular file: ${relativePath}`);
  }

  const { size } = stats;

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
  // The language stays reported even when tokenising failed: it *was*
  // resolved, and blanking it would tell the UI "unknown language" when the
  // truth is "known language, grammar didn't load". The client distinguishes
  // the two by `lines` being null, and says "not highlighted" on its own.
  return lines === null
    ? { path: here, kind: "text", byteLength: size, language, lines: null, plainLines: source.split("\n") }
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

/**
 * Searches the Thread's working tree for a literal string.
 *
 * Shells out to **`git grep`** rather than adding a dependency or walking the
 * tree by hand — spec #93's "the repository's own tooling so ignore rules come
 * for free". git specifically, not ripgrep: git is already a hard requirement
 * of this app (worktrees, checkpoint refs, revert), whereas ripgrep is a
 * separate binary with no guarantee of being on *the server*, which is the
 * machine that matters.
 *
 * Every flag here was verified against real repositories, and three of them
 * are load-bearing rather than tidy:
 *
 * - **`--untracked`**: `git grep` searches *tracked files only* by default, so
 *   a file the agent just created and hasn't committed would be invisible —
 *   precisely the file you search for when reviewing its work. Ignore rules
 *   still apply, so `node_modules/` stays out either way.
 * - **`--null`**: the default `path:line:content` is genuinely ambiguous for a
 *   filename containing a colon. This yields `path\0line\0content`.
 * - **`-I`**: without it a binary file yields `Binary file x.bin matches` — no
 *   line number, nothing the parser can do with it.
 *
 * `-F -i` make matching literal and case-insensitive: story 17 asks to search
 * "for a string", so a regex is a different feature, and case-insensitive is
 * the more useful default for finding code the agent mentioned. `-e` carries
 * the query so one beginning with `-` is a query and not a flag.
 */
export async function search(root: string, query: string): Promise<SearchResults> {
  const realRoot = fsSync.realpathSync(root);
  const empty: SearchResults = {
    query,
    files: [],
    totalMatches: 0,
    truncated: { files: false, matches: false, timedOut: false },
  };
  if (query === "") return empty;

  let stdout: string;
  try {
    ({ stdout } = await promisify(execFile)(
      "git",
      ["grep", "--line-number", "--fixed-strings", "--ignore-case", "-I", "--untracked", "--null", "-e", query],
      { cwd: realRoot, timeout: SEARCH_LIMITS.timeoutMs, maxBuffer: 32 * 1024 * 1024 },
    ));
  } catch (error) {
    const failure = error as { code?: number; killed?: boolean; stdout?: string };
    // Exit 1 is git grep's "no matches" — not a failure, and the single most
    // important thing to get right here (story 21). Anything ≥2 is real.
    if (failure.code === 1) return empty;
    // A timeout kills the process, so whatever it had already written is still
    // a useful partial answer — returned flagged rather than thrown away.
    if (failure.killed) {
      return { ...parseGrepOutput(failure.stdout ?? ""), query, truncated: { ...parseGrepOutput(failure.stdout ?? "").truncated, timedOut: true } };
    }
    throw new Error(`Search failed in this Thread's working tree`);
  }

  return { ...parseGrepOutput(stdout), query };
}

/**
 * Parses `path\0line\0content` records into per-file groups, applying the
 * caps as it goes rather than after — the point of a cap is not to hold the
 * whole result set in memory first.
 */
function parseGrepOutput(stdout: string): Omit<SearchResults, "query"> {
  const files: SearchResults["files"] = [];
  const byPath = new Map<string, SearchResults["files"][number]>();
  const truncated = { files: false, matches: false, timedOut: false };
  let totalMatches = 0;

  for (const record of stdout.split("\n")) {
    if (record === "") continue;
    // Only the first two separators are structural; content may contain NULs
    // in principle, and a path may contain anything but NUL.
    const firstNul = record.indexOf("\0");
    const secondNul = record.indexOf("\0", firstNul + 1);
    if (firstNul === -1 || secondNul === -1) continue;

    const filePath = record.slice(0, firstNul);
    const line = Number.parseInt(record.slice(firstNul + 1, secondNul), 10);
    if (!Number.isFinite(line)) continue;
    const text = record.slice(secondNul + 1);

    let entry = byPath.get(filePath);
    if (!entry) {
      if (files.length >= SEARCH_LIMITS.files) {
        truncated.files = true;
        continue;
      }
      entry = { path: filePath, matches: [], matchesTruncated: false };
      byPath.set(filePath, entry);
      files.push(entry);
    }

    if (entry.matches.length >= SEARCH_LIMITS.matchesPerFile) {
      entry.matchesTruncated = true;
      truncated.matches = true;
      continue;
    }

    entry.matches.push({
      line,
      // A single minified line can be megabytes — bounded here, since the
      // whole point of searching from a phone is that the payload is small.
      text: text.length > SEARCH_LIMITS.lineChars ? text.slice(0, SEARCH_LIMITS.lineChars) : text,
    });
    totalMatches++;
  }

  return { files, totalMatches, truncated };
}
