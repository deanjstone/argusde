import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listDirectory, readFile, resolveWithin } from "./working-tree.js";

let root: string;
let outside: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "argusde-wt-root-")));
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
    // an invitation to page through loose objects and checkpoint refs.
    fs.mkdirSync(path.join(root, ".git"));
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
});
