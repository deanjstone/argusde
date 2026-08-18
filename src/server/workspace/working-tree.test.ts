import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { changedFiles, currentBranch, fileDiff, listDirectory, readFile, resolveWithin, search, SEARCH_LIMITS } from "./working-tree.js";

let root: string;
let outside: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "argusde-wt-root-")));
  // A real repository, because every working tree that reaches these functions
  // is one: Thread creation captures a baseline checkpoint and fails with "not
  // a git repository" otherwise, so a non-git Project root cannot exist. search
  // relies on that (it shells out to git grep).
  execFileSync("git", ["init", "-q", "--initial-branch=main"], { cwd: root });
  outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "argusde-wt-outside-")));
  fs.writeFileSync(path.join(outside, "secret.txt"), "not yours\n");
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "index.ts"), "const x = 1;\n");
  fs.writeFileSync(path.join(root, "README.md"), "# hi\n");
  fs.writeFileSync(path.join(root, ".gitignore"), "node_modules\n");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
  fs.rmSync(`${root}-evil`, { recursive: true, force: true });
});

describe("resolveWithin", () => {
  it("resolves a plain relative path inside the root", () => {
    expect(resolveWithin(root, "src/index.ts")).toBe(path.join(root, "src", "index.ts"));
  });

  it("treats an empty path as the root itself", () => {
    expect(resolveWithin(root, "")).toBe(root);
  });

  describe("refuses to escape", () => {
    it("rejects a parent-directory traversal", () => {
      expect(() => resolveWithin(root, "../secret.txt")).toThrow(/outside/i);
    });

    it("rejects a traversal buried mid-path, not just at the start", () => {
      expect(() => resolveWithin(root, "src/../../secret.txt")).toThrow(/outside/i);
    });

    it("rejects a deep traversal that lands at the filesystem root", () => {
      expect(() => resolveWithin(root, "../".repeat(20) + "etc/passwd")).toThrow(/outside/i);
    });

    it("rejects an absolute path where a relative one was expected", () => {
      expect(() => resolveWithin(root, path.join(outside, "secret.txt"))).toThrow(/outside/i);
    });

    it("rejects a sibling directory whose name merely shares the root's prefix", () => {
      // A naive `resolved.startsWith(root)` check passes this: "/x-evil"
      // starts with "/x". The check has to be separator-aware.
      fs.mkdirSync(`${root}-evil`, { recursive: true });
      fs.writeFileSync(path.join(`${root}-evil`, "gotcha.txt"), "nope\n");
      expect(() => resolveWithin(root, `../${path.basename(root)}-evil/gotcha.txt`)).toThrow(/outside/i);
    });

    it("rejects a symlink that points outside the tree", () => {
      // The case a purely lexical check waves through: the path never
      // mentions "..", and every segment is inside the root.
      fs.symlinkSync(outside, path.join(root, "escape-hatch"));
      expect(() => resolveWithin(root, "escape-hatch/secret.txt")).toThrow(/outside/i);
    });

    it("rejects a symlinked file, not just a symlinked directory", () => {
      fs.symlinkSync(path.join(outside, "secret.txt"), path.join(root, "innocent.txt"));
      expect(() => resolveWithin(root, "innocent.txt")).toThrow(/outside/i);
    });

    it("allows a symlink that stays inside the tree", () => {
      fs.symlinkSync(path.join(root, "src"), path.join(root, "src-link"));

      // The path the user navigated is what comes back, not its
      // canonicalisation — containment is decided on the realpath, but a
      // reader shouldn't have their path silently rewritten. What matters is
      // that it resolves and reads the intended file.
      const resolved = resolveWithin(root, "src-link/index.ts");
      expect(fs.readFileSync(resolved, "utf8")).toBe("const x = 1;\n");
    });

    it("never discloses a server-side absolute path in the refusal", () => {
      // The client only ever sees paths *relative* to the working tree, so it
      // has no idea where that tree lives on the server. A refusal must not
      // teach it — otherwise a rejected read becomes a probe for the server's
      // filesystem layout. Echoing the client's own input back is fine: it
      // learns nothing it didn't send.
      let message = "";
      try {
        resolveWithin(root, "../../etc/passwd");
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }

      expect(message).toMatch(/outside/i);
      expect(message).not.toContain(root);
      expect(message).not.toMatch(/(^|[\s"'])\//);
    });
  });
});

describe("listDirectory", () => {
  it("lists files and directories, directories first then alphabetical", async () => {
    const listing = await listDirectory(root, "");

    expect(listing.path).toBe("");
    expect(listing.parentPath).toBeNull();
    expect(listing.entries).toEqual([
      { name: "src", path: "src", kind: "directory" },
      { name: ".gitignore", path: ".gitignore", kind: "file" },
      { name: "README.md", path: "README.md", kind: "file" },
    ]);
  });

  it("includes dotfiles — unlike the project-root picker, these are things you want to read", async () => {
    expect((await listDirectory(root, "")).entries.map((e) => e.name)).toContain(".gitignore");
  });

  it("hides .git, the one dotfile that is machinery rather than content", async () => {
    // Alphabetically it lists first, so without this the browser opens on
    // an invitation to page through loose objects and checkpoint refs. The
    // setup's `git init` already created it — no need to fake one.
    expect(fs.existsSync(path.join(root, ".git"))).toBe(true);
    expect((await listDirectory(root, "")).entries.map((e) => e.name)).not.toContain(".git");
  });

  it("reports a parent for a nested directory, so the browser can navigate back up", async () => {
    fs.mkdirSync(path.join(root, "src", "web"), { recursive: true });
    const listing = await listDirectory(root, "src/web");

    expect(listing.path).toBe("src/web");
    expect(listing.parentPath).toBe("src");
  });

  it("reports the root's own parent as null, so navigation cannot walk out of the tree", async () => {
    expect((await listDirectory(root, "src")).parentPath).toBe("");
    expect((await listDirectory(root, "")).parentPath).toBeNull();
  });

  it("refuses to list outside the tree", async () => {
    await expect(listDirectory(root, "..")).rejects.toThrow(/outside/i);
  });
});

describe("readFile", () => {
  it("returns a text file's contents tokenised, with a resolved language", async () => {
    const preview = await readFile(root, "src/index.ts");

    expect(preview.kind).toBe("text");
    expect(preview.language).toBe("typescript");
    expect(preview.lines).not.toBeNull();
    // Tokens carry the text, so the file is reconstructible from them.
    expect(preview.lines?.[0]?.map((t) => t.content).join("")).toBe("const x = 1;");
    // Kinds, not colours — the client maps these onto theme tokens, because
    // the UI's `style-src 'self'` CSP blocks the inline styles a per-token
    // colour would need.
    expect(preview.lines?.[0]?.map((t) => t.kind)).toContain("keyword");
  });

  it("refuses to read outside the tree", async () => {
    await expect(readFile(root, "../secret.txt")).rejects.toThrow(/outside/i);
  });
  describe("size and kind bands", () => {
    it("reports a file with a NUL byte as binary rather than rendering noise", async () => {
      fs.writeFileSync(path.join(root, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]));
      const preview = await readFile(root, "logo.png");

      expect(preview.kind).toBe("binary");
      expect(preview.lines).toBeNull();
      expect(preview.plainLines).toBeNull();
    });

    it("calls a huge binary binary, not merely too-large — the user learns what it is", async () => {
      // Binary is sniffed before the size band on purpose: "too large"
      // answers the wrong question about an archive.
      const huge = Buffer.alloc(400 * 1024);
      huge.write("PK\u0003\u0004");
      fs.writeFileSync(path.join(root, "bundle.zip"), huge);

      expect((await readFile(root, "bundle.zip")).kind).toBe("binary");
    });

    it("refuses a text file past the preview cap rather than hanging on it", async () => {
      fs.writeFileSync(path.join(root, "generated.ts"), `const x = "${"y".repeat(300 * 1024)}";\n`);
      const preview = await readFile(root, "generated.ts");

      expect(preview.kind).toBe("too-large");
      expect(preview.lines).toBeNull();
      expect(preview.plainLines).toBeNull();
      expect(preview.byteLength).toBeGreaterThan(256 * 1024);
    });

    it("returns a mid-band file as plain lines rather than refusing it — readable without colour beats not readable", async () => {
      const lines = Array.from({ length: 4000 }, (_, i) => `const value${i} = ${i};`);
      fs.writeFileSync(path.join(root, "big.ts"), lines.join("\n"));
      const preview = await readFile(root, "big.ts");

      expect(preview.kind).toBe("text");
      expect(preview.byteLength).toBeGreaterThan(64 * 1024);
      expect(preview.byteLength).toBeLessThan(256 * 1024);
      expect(preview.lines).toBeNull();
      expect(preview.plainLines).toHaveLength(4000);
    });

    it("falls back to plain lines for an unknown extension instead of throwing", async () => {
      // shiki throws on an unrecognised language rather than defaulting, so
      // an unresolved language has to be caught before it reaches shiki.
      fs.writeFileSync(path.join(root, "notes.wibble"), "just some text\n");
      const preview = await readFile(root, "notes.wibble");

      expect(preview.kind).toBe("text");
      expect(preview.language).toBeNull();
      expect(preview.plainLines).toEqual(["just some text", ""]);
    });

    it("resolves a language for an extensionless file a repo actually contains", async () => {
      fs.writeFileSync(path.join(root, "Dockerfile"), "FROM node:22\n");
      expect((await readFile(root, "Dockerfile")).language).toBe("dockerfile");
    });

    it("names the canonical language, not the extension's alias", async () => {
      // "ts" is a valid shiki alias, but the resolved name is shown to the
      // user, so it should read as a language rather than a file extension.
      expect((await readFile(root, "src/index.ts")).language).toBe("typescript");
    });

    it("reports an empty file as text with no content, not as an error", async () => {
      fs.writeFileSync(path.join(root, "empty.ts"), "");
      const preview = await readFile(root, "empty.ts");

      expect(preview.kind).toBe("text");
      expect(preview.byteLength).toBe(0);
    });
  });
  describe("defects an adversarial review found", () => {
    it("emits root-relative paths even when the root itself is a symlink", async () => {
      // Measured against the *presented* root, a symlinked workspace path
      // (/tmp is one on macOS) made every emitted path "..'"'"'-prefixed and
      // parentPath at the root ".." instead of null — the module breaking its
      // own promise and handing back paths it would then refuse.
      const presented = path.join(outside, "presented");
      fs.symlinkSync(root, presented);

      const listing = await listDirectory(presented, "");
      expect(listing.path).toBe("");
      expect(listing.parentPath).toBeNull();
      expect(listing.entries.map((e) => e.path)).toEqual(expect.arrayContaining(["src", "README.md"]));
      for (const entry of listing.entries) expect(entry.path).not.toContain("..");
    });

    it("refuses a FIFO rather than blocking a filesystem thread on it forever", async () => {
      // Opening a FIFO never returns. Four of these starve libuv's whole
      // threadpool, taking every filesystem operation the server can make
      // with them — so the kind check has to happen before anything opens it.
      execFileSync("mkfifo", [path.join(root, "pipe")]);

      await expect(readFile(root, "pipe")).rejects.toThrow(/not a regular file/i);
    });

    it("refuses a directory handed to readFile, rather than failing obscurely", async () => {
      await expect(readFile(root, "src")).rejects.toThrow(/not a regular file/i);
    });

    it("refuses to read inside .git, not merely to list it", async () => {
      // Half-hiding it was incoherent, and .git/config routinely holds a
      // remote URL with a credential in it.
      fs.mkdirSync(path.join(root, ".git"), { recursive: true });
      fs.writeFileSync(path.join(root, ".git", "config"), "url = https://x:token@example.com/r.git\n");

      await expect(readFile(root, ".git/config")).rejects.toThrow(/outside/i);
      await expect(listDirectory(root, ".git")).rejects.toThrow(/outside/i);
    });

    it("still reads other dotfiles — .git is machinery, they are content", async () => {
      expect((await readFile(root, ".gitignore")).kind).toBe("text");
    });

    it("resolves what it validated, so a link swapped after the check cannot redirect the read", async () => {
      // The lexical path was previously returned, so the caller opened
      // something the containment check had never seen. Returning the
      // resolved path closes that: the value handed back no longer traverses
      // the link at all.
      fs.symlinkSync(path.join(root, "src"), path.join(root, "link"));
      const resolved = resolveWithin(root, "link/index.ts");

      expect(resolved).toBe(path.join(root, "src", "index.ts"));
      expect(resolved).not.toContain("link");
    });

    it("does not leak an absolute server path when a file simply is not there", async () => {
      // Node's fs errors carry the path they failed on, and the WS server
      // relays error.message verbatim — so a plain ENOENT was handing back
      // the server's filesystem layout.
      await expect(readFile(root, "nope.ts")).rejects.toThrow(
        expect.objectContaining({ message: expect.not.stringContaining(root) }),
      );
      await expect(listDirectory(root, "nope")).rejects.toThrow(
        expect.objectContaining({ message: expect.not.stringContaining(root) }),
      );
    });
  });
describe("search", () => {
  it("finds a match and reports the file, line number and line text", async () => {
    const results = await search(root, "const x");

    expect(results.files).toEqual([
      { path: "src/index.ts", matches: [{ line: 1, text: "const x = 1;" }], matchesTruncated: false },
    ]);
    expect(results.totalMatches).toBe(1);
  });

  it("finds a match in an untracked, uncommitted file — the file you search for when reviewing agent work", async () => {
    // git grep searches TRACKED files only by default, so without --untracked
    // a file the agent just created is invisible. Verified against real git
    // before relying on it.
    fs.writeFileSync(path.join(root, "src", "brand-new.ts"), "const needle = 1;\n");

    const paths = (await search(root, "needle")).files.map((f) => f.path);
    expect(paths).toContain("src/brand-new.ts");
  });

  it("respects the repository's ignore rules without reimplementing them", async () => {
    fs.mkdirSync(path.join(root, "node_modules", "pkg"), { recursive: true });
    fs.writeFileSync(path.join(root, "node_modules", "pkg", "index.js"), "const needle = 1;\n");
    fs.writeFileSync(path.join(root, ".gitignore"), "node_modules\n");

    const paths = (await search(root, "needle")).files.map((f) => f.path);
    expect(paths).not.toContain("node_modules/pkg/index.js");
  });

  it("returns an empty result for no matches, not an error", async () => {
    // git grep exits 1 when nothing matches, and execFile rejects on any
    // non-zero exit — so 1 has to be told apart from a real failure or every
    // empty search surfaces as one.
    const results = await search(root, "definitely-not-in-this-repository");

    expect(results.files).toEqual([]);
    expect(results.totalMatches).toBe(0);
  });

  it("matches literally, so regex metacharacters find themselves", async () => {
    fs.writeFileSync(path.join(root, "src", "regex.ts"), "const pattern = a.*b;\n");

    expect((await search(root, "a.*b")).totalMatches).toBe(1);
    // Were the query treated as a regex, ".*" would match the other files too.
    expect((await search(root, "a.*b")).files.map((f) => f.path)).toEqual(["src/regex.ts"]);
  });

  it("matches case-insensitively", async () => {
    expect((await search(root, "CONST X")).totalMatches).toBe(1);
  });

  it("parses a filename containing a colon", async () => {
    // The default `path:line:content` output is ambiguous for such a name;
    // --null is what makes it parseable at all.
    fs.writeFileSync(path.join(root, "weird:name.ts"), "const needle = 1;\n");

    expect((await search(root, "needle")).files.map((f) => f.path)).toContain("weird:name.ts");
  });

  it("skips binary files instead of emitting an unparseable match line", async () => {
    // Without -I, git grep emits "Binary file X matches" — no line number, and
    // nothing the parser can do with it.
    fs.writeFileSync(path.join(root, "blob.bin"), Buffer.from("needle\u0000binary\n", "binary"));

    const paths = (await search(root, "needle")).files.map((f) => f.path);
    expect(paths).not.toContain("blob.bin");
  });

  it("treats a query that looks like a flag as a query, and finds it", async () => {
    // Asserting "no matches" alone proved nothing — every wrong behaviour also
    // returns nothing. This puts the text in a file, so the only way to pass is
    // to have actually searched for it.
    fs.writeFileSync(path.join(root, "src", "flags.ts"), "// pass --untracked to git grep\n");

    const results = await search(root, "--untracked");
    expect(results.files.map((f) => f.path)).toEqual(["src/flags.ts"]);
  });

  it("refuses a query spanning multiple lines rather than searching for something else", async () => {
    // `git grep -e` splits its pattern on newlines into an OR of patterns, and
    // an empty one among them matches EVERY line of EVERY file — verified: a
    // newline-only query returned all 4 lines of a 4-line repository. Reachable
    // straight over the WebSocket, since the UI's trim() only masks it.
    await expect(search(root, "\n")).rejects.toThrow(/multiple lines/i);
    await expect(search(root, "const x\n")).rejects.toThrow(/multiple lines/i);
    await expect(search(root, "a\r\nb")).rejects.toThrow(/multiple lines/i);
  });

  it("returns nothing for a whitespace-only query instead of matching everything", async () => {
    await expect(search(root, "   ")).resolves.toMatchObject({ totalMatches: 0, files: [] });
  });

  it("parses a filename containing a newline without corrupting the path", async () => {
    // Splitting records on newline before locating the fields returned
    // "ird.ts" for a file called "we\nird.ts" — a path that does not exist,
    // cannot be opened, and silently replaced the real hit.
    const weird = "we\nird.ts";
    fs.writeFileSync(path.join(root, weird), "const needle = 1;\n");

    const paths = (await search(root, "needle")).files.map((f) => f.path);
    expect(paths).toContain(weird);
    expect(paths).not.toContain("ird.ts");
  });

  it("groups every match in a file under that file, in line order", async () => {
    fs.writeFileSync(path.join(root, "src", "many.ts"), "needle\nother\nneedle\nneedle\n");

    const file = (await search(root, "needle")).files.find((f) => f.path === "src/many.ts");
    expect(file?.matches.map((m) => m.line)).toEqual([1, 3, 4]);
  });

  describe("caps, each reported rather than silently applied", () => {
    it("caps matches within one file and says it did", async () => {
      const lines = Array.from({ length: SEARCH_LIMITS.matchesPerFile + 10 }, () => "needle");
      fs.writeFileSync(path.join(root, "src", "dense.ts"), `${lines.join("\n")}\n`);

      const file = (await search(root, "needle")).files.find((f) => f.path === "src/dense.ts");
      expect(file?.matches).toHaveLength(SEARCH_LIMITS.matchesPerFile);
      expect(file?.matchesTruncated).toBe(true);
    });

    it("caps the number of files and says it did", async () => {
      for (let i = 0; i < SEARCH_LIMITS.files + 5; i++) {
        fs.writeFileSync(path.join(root, `f${i}.ts`), "needle\n");
      }

      const results = await search(root, "needle");
      expect(results.files).toHaveLength(SEARCH_LIMITS.files);
      expect(results.truncated.files).toBe(true);
    });

    it("leaves the flags clear when nothing was capped", async () => {
      const results = await search(root, "const x");

      expect(results.truncated).toEqual({ files: false, matches: false, output: false, timedOut: false });
      expect(results.files.every((f) => f.matchesTruncated === false)).toBe(true);
    });

    it("returns partial results flagged rather than failing when git is cut off mid-stream", async () => {
      // A timeout and a maxBuffer overflow both kill git with real results
      // already written. Discarding those would turn "here is some of it" into
      // "Search failed", which tells the user nothing they can act on.
      //
      // Provoked via the buffer bound rather than the clock, because that is
      // deterministic — no dependence on how fast the machine is.
      //
      // Deliberately only a handful of files, each enormous: that makes the
      // assertion below precise. `truncated.files` is otherwise set by the
      // file cap, which the parser only trips once it has *seen* 100 files —
      // so "flagged truncated while returning fewer than the cap" is reachable
      // only through the cut-short branch, and this test would be vacuous
      // without it.
      const fatLine = `${"needle ".repeat(150)}\n`;
      for (let i = 0; i < 5; i++) {
        fs.writeFileSync(path.join(root, `bulk${i}.ts`), fatLine.repeat(9000));
      }

      const results = await search(root, "needle");

      expect(results.files.length).toBeGreaterThan(0);
      // `output` is set only by the cut-short branch, so this is the proof the
      // branch ran — no inference from file counts needed. `files` deliberately
      // stays false: claiming "more files matched" in a five-file repository
      // would be a lie the badge repeats to the user.
      expect(results.truncated.output).toBe(true);
      expect(results.truncated.files).toBe(false);
    });

    it("caps the total match count across every file, not just within each one", async () => {
      // files x matchesPerFile would otherwise allow 2000 matches, which at the
      // line bound is ~600KB aimed at a phone.
      const perFile = SEARCH_LIMITS.matchesPerFile;
      const fileCount = Math.ceil(SEARCH_LIMITS.totalMatches / perFile) + 5;
      for (let i = 0; i < fileCount; i++) {
        fs.writeFileSync(path.join(root, `t${i}.ts`), `${Array.from({ length: perFile }, () => "needle").join("\n")}\n`);
      }

      const results = await search(root, "needle");
      expect(results.totalMatches).toBeLessThanOrEqual(SEARCH_LIMITS.totalMatches);
      expect(results.truncated.matches).toBe(true);
    });

    it("caps a single enormous matched line, so a minified file cannot blow the payload", async () => {
      fs.writeFileSync(path.join(root, "src", "min.ts"), `needle${"x".repeat(5000)}\n`);

      const file = (await search(root, "needle")).files.find((f) => f.path === "src/min.ts");
      expect(file?.matches[0]?.text.length).toBeLessThanOrEqual(SEARCH_LIMITS.lineChars);
    });
  });

  it("searches the Thread's own working tree, never outside it", async () => {
    fs.writeFileSync(path.join(outside, "secret.txt"), "needle in the outside world\n");

    const paths = (await search(root, "needle in the outside world")).files.map((f) => f.path);
    expect(paths).toEqual([]);
  });

  it("does not leak an absolute server path in any result path", async () => {
    fs.writeFileSync(path.join(root, "src", "hit.ts"), "needle\n");

    for (const file of (await search(root, "needle")).files) {
      expect(file.path).not.toContain(root);
      expect(path.isAbsolute(file.path)).toBe(false);
    }
  });
});
});

describe("changedFiles", () => {
  /** The setup's root has no commits, so most cases need a baseline to diff against. */
  function commitBaseline() {
    execFileSync("git", ["config", "user.email", "t@e.com"], { cwd: root });
    execFileSync("git", ["config", "user.name", "T"], { cwd: root });
    execFileSync("git", ["add", "-A"], { cwd: root });
    execFileSync("git", ["commit", "-qm", "baseline"], { cwd: root });
  }

  it("reports nothing for a clean tree, rather than erroring", async () => {
    commitBaseline();
    expect(await changedFiles(root)).toEqual([]);
  });

  it("labels each change with how it changed", async () => {
    commitBaseline();
    fs.writeFileSync(path.join(root, "src", "index.ts"), "const x = 2;\n");
    fs.writeFileSync(path.join(root, "added.ts"), "new\n");
    execFileSync("git", ["add", "added.ts"], { cwd: root });
    fs.rmSync(path.join(root, "README.md"));
    fs.writeFileSync(path.join(root, "untracked.ts"), "fresh\n");

    const byPath = new Map((await changedFiles(root)).map((c) => [c.path, c.kind]));
    expect(byPath.get("src/index.ts")).toBe("modified");
    expect(byPath.get("added.ts")).toBe("added");
    expect(byPath.get("README.md")).toBe("deleted");
    expect(byPath.get("untracked.ts")).toBe("untracked");
  });

  it("reports a rename as a rename, carrying where it came from", async () => {
    commitBaseline();
    execFileSync("git", ["mv", "README.md", "READTHIS.md"], { cwd: root });

    const rename = (await changedFiles(root)).find((c) => c.kind === "renamed");
    expect(rename?.path).toBe("READTHIS.md");
    expect(rename?.previousPath).toBe("README.md");
  });

  it("does not swallow the entry after a rename", async () => {
    // A rename record carries TWO NUL-terminated paths where every other
    // record carries one. A parser that treats each NUL-delimited field as a
    // record mis-associates whatever follows — verified against real porcelain
    // v2 output before this was written.
    commitBaseline();
    execFileSync("git", ["mv", "README.md", "READTHIS.md"], { cwd: root });
    fs.writeFileSync(path.join(root, "src", "index.ts"), "const x = 3;\n");
    fs.writeFileSync(path.join(root, "zzz-after.ts"), "still here\n");

    const byPath = new Map((await changedFiles(root)).map((c) => [c.path, c.kind]));
    expect(byPath.get("READTHIS.md")).toBe("renamed");
    expect(byPath.get("src/index.ts")).toBe("modified");
    expect(byPath.get("zzz-after.ts")).toBe("untracked");
  });

  it("handles paths that porcelain v1 would have quoted or split", async () => {
    // v1 emits `R  old -> new` and quotes paths with spaces or specials, so it
    // is ambiguous for exactly the paths that break things. v2 -z never quotes.
    commitBaseline();
    for (const name of ["with space.ts", "with:colon.ts", "with\nnewline.ts"]) {
      fs.writeFileSync(path.join(root, name), "x\n");
    }

    const paths = (await changedFiles(root)).map((c) => c.path);
    expect(paths).toEqual(expect.arrayContaining(["with space.ts", "with:colon.ts", "with\nnewline.ts"]));
  });

  it("excludes ignored paths, taking the rules from the repository", async () => {
    fs.writeFileSync(path.join(root, ".gitignore"), "node_modules\n");
    commitBaseline();
    fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });
    fs.writeFileSync(path.join(root, "node_modules", "dep.js"), "x\n");

    expect((await changedFiles(root)).map((c) => c.path)).not.toContain("node_modules/dep.js");
  });

  it("never names an absolute server path", async () => {
    commitBaseline();
    fs.writeFileSync(path.join(root, "changed.ts"), "x\n");

    for (const change of await changedFiles(root)) {
      expect(path.isAbsolute(change.path)).toBe(false);
      expect(change.path).not.toContain(root);
    }
  });
});

describe("fileDiff", () => {
  function commitBaseline() {
    execFileSync("git", ["config", "user.email", "t@e.com"], { cwd: root });
    execFileSync("git", ["config", "user.name", "T"], { cwd: root });
    execFileSync("git", ["add", "-A"], { cwd: root });
    execFileSync("git", ["commit", "-qm", "baseline"], { cwd: root });
  }

  it("diffs a modified file against the live working tree", async () => {
    commitBaseline();
    fs.writeFileSync(path.join(root, "src", "index.ts"), "const x = 99;\n");

    const diff = await fileDiff(root, "src/index.ts");
    expect(diff.kind).toBe("text");
    const text = diff.lines.map((l) => l.text).join("\n");
    expect(text).toContain("-const x = 1;");
    expect(text).toContain("+const x = 99;");
  });

  it("diffs an untracked file, which `git diff HEAD` alone returns nothing for", async () => {
    // The single most common thing an agent produces. Verified: `git diff HEAD
    // -- new.ts` on an untracked file is EMPTY, so without the --no-index
    // fallback a new file would list as changed and then show nothing at all.
    commitBaseline();
    fs.writeFileSync(path.join(root, "brand-new.ts"), "hello\nworld\n");

    const diff = await fileDiff(root, "brand-new.ts");
    expect(diff.kind).toBe("text");
    expect(diff.lines.some((l) => l.text.includes("+hello"))).toBe(true);
    expect(diff.lines.some((l) => l.kind === "added")).toBe(true);
  });

  it("classifies each line so the client colours from theme tokens, not by re-parsing", async () => {
    commitBaseline();
    fs.writeFileSync(path.join(root, "src", "index.ts"), "const x = 99;\n");

    const kinds = new Set((await fileDiff(root, "src/index.ts")).lines.map((l) => l.kind));
    expect(kinds).toContain("added");
    expect(kinds).toContain("removed");
    expect(kinds).toContain("meta");
  });

  it("reports a binary file as binary rather than dumping it", async () => {
    commitBaseline();
    fs.writeFileSync(path.join(root, "blob.bin"), Buffer.from([0x00, 0x01, 0x02, 0x00]));

    expect((await fileDiff(root, "blob.bin")).kind).toBe("binary");
  });

  it("refuses a path outside the working tree", async () => {
    commitBaseline();
    await expect(fileDiff(root, "../secret.txt")).rejects.toThrow(/outside/i);
  });
});

describe("currentBranch", () => {
  it("reads the branch from git rather than deriving it", async () => {
    execFileSync("git", ["config", "user.email", "t@e.com"], { cwd: root });
    execFileSync("git", ["config", "user.name", "T"], { cwd: root });
    execFileSync("git", ["add", "-A"], { cwd: root });
    execFileSync("git", ["commit", "-qm", "baseline"], { cwd: root });

    expect(await currentBranch(root)).toEqual({ branch: "main", detached: false });
  });

  it("reports a detached worktree as detached, not as a branch called HEAD", async () => {
    // Phase 3's warning made concrete: a Worktree promoted before branch
    // backing has no branch, and `rev-parse --abbrev-ref HEAD` returns the
    // literal string "HEAD" — which must not be shown as a branch name.
    execFileSync("git", ["config", "user.email", "t@e.com"], { cwd: root });
    execFileSync("git", ["config", "user.name", "T"], { cwd: root });
    execFileSync("git", ["add", "-A"], { cwd: root });
    execFileSync("git", ["commit", "-qm", "baseline"], { cwd: root });
    execFileSync("git", ["checkout", "-q", "--detach", "HEAD"], { cwd: root });

    expect(await currentBranch(root)).toEqual({ branch: null, detached: true });
  });
});
