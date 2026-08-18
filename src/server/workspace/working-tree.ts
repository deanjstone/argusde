import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type {
  ChangedFile,
  DiffLine,
  FileDiff,
  FilePreview,
  SearchResults,
  WorkingTreeBranch,
  WorkingTreeListing,
} from "../../shared/ws-protocol.js";
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
  /**
   * The payload bound across the whole result set. files × matchesPerFile
   * would otherwise allow 2000 matches, which at the line bound below is
   * ~600KB aimed at a phone.
   */
  totalMatches: 500,
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
    truncated: { files: false, matches: false, output: false, timedOut: false },
  };
  // `git grep -e` splits its pattern on newlines into an OR of several
  // patterns, and an empty one among them matches *every line of every file* —
  // verified: a query of a single newline returned all 4 lines of a 4-line
  // repository. Trimming in the UI masked it, but the command is reachable
  // directly over the WebSocket, so the guard belongs here.
  //
  // Rejected rather than silently searching for part of what was asked:
  // `git grep` cannot express a multi-line literal at all, so quietly
  // searching only the first line would answer a different question.
  if (/[\r\n]/.test(query)) {
    throw new Error("Search terms cannot span multiple lines");
  }
  if (query.trim() === "") return empty;

  let stdout: string;
  try {
    ({ stdout } = await promisify(execFile)(
      "git",
      ["grep", "--line-number", "--fixed-strings", "--ignore-case", "-I", "--untracked", "--null", "-e", query],
      { cwd: realRoot, timeout: SEARCH_LIMITS.timeoutMs, maxBuffer: 32 * 1024 * 1024 },
    ));
  } catch (error) {
    // Three distinct shapes, verified against Node rather than guessed at:
    //   exit 1                             -> code: 1        (numeric)
    //   timeout                            -> killed: true, signal: SIGTERM, code: null
    //   output over maxBuffer              -> code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", killed: undefined
    // All three carry whatever git had already written on `stdout`.
    const failure = error as { code?: number | string; killed?: boolean; stdout?: string };

    // Exit 1 is git grep's "no matches" — not a failure, and the single most
    // important thing to get right here (story 21). Anything ≥2 is real. The
    // strict compare matters: the maxBuffer code is a string, not a number.
    if (failure.code === 1) return empty;

    // Both the timeout and the maxBuffer overflow cut git off mid-stream, and
    // both leave real results behind. Returning those flagged beats discarding
    // them — a partial answer to "where is this string" is still an answer,
    // whereas "Search failed" tells the user nothing they can act on.
    const cutShort = failure.killed === true || failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
    if (cutShort) {
      const partial = parseGrepOutput(failure.stdout ?? "");
      return {
        ...partial,
        query,
        truncated: {
          // `files` and `matches` stay exactly as the parser found them. An
          // earlier version forced `files: true` here on the reasoning that a
          // cut-off stream means more was out there — true, but the flag says
          // "more *files* matched", and in a one-file repository that is
          // simply false. `output` is the honest claim: git was cut off, so
          // this is partial.
          ...partial.truncated,
          output: true,
          timedOut: failure.killed === true,
        },
      };
    }

    throw new Error(`Search failed in this Thread's working tree`);
  }

  return { ...parseGrepOutput(stdout), query };
}

/**
 * Parses git grep's `path\0line\0content\n` records into per-file groups,
 * applying the caps as it goes rather than after — the point of a cap is not
 * to hold the whole result set in memory first.
 *
 * Scans forward rather than splitting on newlines. Splitting first looks
 * simpler and corrupts any path containing a newline: `we\nird.ts` came back
 * as `ird.ts`, a path that does not exist and cannot be opened, with the real
 * hit lost. Locating each field by its own delimiter avoids that — the path
 * runs to the first NUL whatever it contains, and only the *content* field is
 * newline-terminated, which is safe because content is always a single line.
 */
function parseGrepOutput(stdout: string): Omit<SearchResults, "query"> {
  const files: SearchResults["files"] = [];
  const byPath = new Map<string, SearchResults["files"][number]>();
  const truncated = { files: false, matches: false, output: false, timedOut: false };
  let totalMatches = 0;

  let cursor = 0;
  while (cursor < stdout.length) {
    const firstNul = stdout.indexOf("\0", cursor);
    if (firstNul === -1) break;
    const secondNul = stdout.indexOf("\0", firstNul + 1);
    if (secondNul === -1) break;

    // Content is one line by definition, so its terminator is the record's.
    let recordEnd = stdout.indexOf("\n", secondNul + 1);
    if (recordEnd === -1) recordEnd = stdout.length;

    const filePath = stdout.slice(cursor, firstNul);
    const line = Number.parseInt(stdout.slice(firstNul + 1, secondNul), 10);
    const text = stdout.slice(secondNul + 1, recordEnd);
    cursor = recordEnd + 1;

    if (!Number.isInteger(line)) continue;

    if (totalMatches >= SEARCH_LIMITS.totalMatches) {
      truncated.matches = true;
      break;
    }

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

/** Shared runner for the read-only git commands this module shells out to. */
async function git(realRoot: string, args: string[]): Promise<string> {
  const { stdout } = await promisify(execFile)("git", args, {
    cwd: realRoot,
    maxBuffer: 32 * 1024 * 1024,
    timeout: SEARCH_LIMITS.timeoutMs,
  });
  return stdout;
}

/**
 * What is changed in the Thread's working tree *right now* — spec #93 story
 * 22, and a different question from Checkpoint diffing, which this deliberately
 * does not touch.
 *
 * Uses `--porcelain=v2 -z`, not v1. v1 renders a rename as `R  old -> new` and
 * *quotes* any path containing a space or special character, so it is ambiguous
 * for exactly the paths that break parsers. v2 with `-z` never quotes and
 * delimits every field with NUL.
 *
 * `--untracked-files=all` for the same reason phase 5 needed `git grep
 * --untracked`: a file the agent has just created is the one you most want to
 * see, and it is not tracked yet.
 */
export async function changedFiles(root: string): Promise<ChangedFile[]> {
  const realRoot = fsSync.realpathSync(root);
  const stdout = await git(realRoot, ["status", "--porcelain=v2", "-z", "--untracked-files=all", "--renames"]);
  return parseStatus(stdout);
}

/**
 * Parses porcelain v2's NUL-delimited records.
 *
 * Record shapes, which is the whole reason this is a scanner and not a split:
 *   `1 <XY> …  <path>`                    ordinary change      — one path
 *   `2 <XY> … <score> <path>\0<origPath>` rename or copy       — **two** paths
 *   `? <path>` / `! <path>`               untracked / ignored  — one path
 *
 * A rename carrying a second NUL-terminated field is what makes "split on NUL
 * and take each field as a record" wrong: it silently consumes the *next*
 * entry as the rename's origin. Verified against real porcelain output.
 */
function parseStatus(stdout: string): ChangedFile[] {
  const changes: ChangedFile[] = [];
  const records = stdout.split("\0");

  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record) continue;

    if (record.startsWith("? ")) {
      changes.push({ path: record.slice(2), kind: "untracked" });
      continue;
    }
    // Ignored entries are not requested, but a future flag change shouldn't
    // silently reclassify them as something else.
    if (record.startsWith("! ")) continue;

    if (record.startsWith("1 ") || record.startsWith("2 ")) {
      const isRename = record.startsWith("2 ");
      const xy = record.split(" ")[1] ?? "..";
      // The prefix is a fixed number of space-separated fields, so the path is
      // everything after the Nth space — taken that way rather than as the last
      // field, because a path may itself contain spaces:
      //   1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>          -> 8 fields
      //   2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <score> <path>  -> 9 fields
      const filePath = record.slice(indexOfNthSpace(record, isRename ? 9 : 8) + 1);

      const change: ChangedFile = { path: filePath, kind: kindFor(xy) };
      if (isRename) {
        // The origin is the *next* NUL-terminated field, consumed here so the
        // loop doesn't mistake it for a record of its own.
        change.previousPath = records[++i] ?? undefined;
      }
      changes.push(change);
    }
  }

  return changes;
}

/** Index of the nth space in a record, used to find where the fixed-field prefix ends. */
function indexOfNthSpace(record: string, n: number): number {
  let index = -1;
  for (let seen = 0; seen < n; seen++) {
    index = record.indexOf(" ", index + 1);
    if (index === -1) return record.length;
  }
  return index;
}

/** porcelain v2's XY code: X is the index, Y the working tree. */
function kindFor(xy: string): ChangedFile["kind"] {
  if (xy.startsWith("R") || xy[1] === "R") return "renamed";
  if (xy.startsWith("A")) return "added";
  if (xy.includes("D")) return "deleted";
  return "modified";
}

/**
 * One file's diff against the live working tree.
 *
 * Two commands rather than one, because **`git diff HEAD` returns nothing at
 * all for an untracked file** — verified — and a newly created file is the most
 * common thing an agent produces. Listing it as changed and then showing an
 * empty diff would be worse than not listing it.
 */
export async function fileDiff(root: string, relativePath: string): Promise<FileDiff> {
  const absolute = resolveWithin(root, relativePath);
  const realRoot = fsSync.realpathSync(root);
  const here = toRelative(root, absolute);

  const tracked = (await git(realRoot, ["ls-files", "--error-unmatch", "--", here]).catch(() => "")) !== "";
  const raw = tracked
    ? await git(realRoot, ["diff", "HEAD", "--", here])
    : await git(realRoot, ["diff", "--no-index", "--", "/dev/null", here]).catch((error: { stdout?: string }) => error.stdout ?? "");

  if (/^Binary files? /m.test(raw)) return { path: here, kind: "binary", lines: [] };

  return { path: here, kind: "text", lines: raw.split("\n").filter((line, i, all) => line !== "" || i < all.length - 1).map(toDiffLine) };
}

/**
 * Classifies a patch line so the client colours it from theme tokens rather
 * than re-parsing a patch it was just handed. `---`/`+++` are checked before
 * the bare `-`/`+` cases, since they start with the same characters.
 */
function toDiffLine(text: string): DiffLine {
  if (text.startsWith("@@")) return { kind: "hunk", text };
  if (text.startsWith("+++") || text.startsWith("---") || text.startsWith("diff ") || text.startsWith("index ")) {
    return { kind: "meta", text };
  }
  if (text.startsWith("+")) return { kind: "added", text };
  if (text.startsWith("-")) return { kind: "removed", text };
  if (text.startsWith("new file") || text.startsWith("deleted file") || text.startsWith("similarity")) {
    return { kind: "meta", text };
  }
  return { kind: "context", text };
}

/**
 * What the working tree is checked out on (story 28).
 *
 * Read from git, never derived from the Thread id — phase 3's explicit
 * warning, because a Worktree promoted before branch backing has no branch at
 * all. `--abbrev-ref` returns the literal string `HEAD` when detached, which
 * has to be reported as detached rather than shown as a branch by that name.
 */
export async function currentBranch(root: string): Promise<WorkingTreeBranch> {
  const realRoot = fsSync.realpathSync(root);
  const name = (await git(realRoot, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "")).trim();
  if (name === "" || name === "HEAD") return { branch: null, detached: true };
  return { branch: name, detached: false };
}
