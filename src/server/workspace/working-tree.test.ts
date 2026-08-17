import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listDirectory, readFile, resolveWithin, search, SEARCH_LIMITS } from "./working-tree.js";

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

  it("treats a query that looks like a flag as a query", async () => {
    await expect(search(root, "--untracked")).resolves.toMatchObject({ totalMatches: 0 });
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

      expect(results.truncated).toEqual({ files: false, matches: false, timedOut: false });
      expect(results.files.every((f) => f.matchesTruncated === false)).toBe(true);
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
