// argusde#141: the UI primitives under src/web/components/ui are design-system
// registry items installed by the shadcn CLI, not hand-written or Radix copies.
// Same guard as argus/apps/notice-board-web/test/registry-only.test.ts, minus its
// "no raw <button>" check: here the registry's `render` prop is how a row becomes
// a button (`<Item render={<button />}>`), so the raw element is the pattern.
import { readdirSync, readFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SRC = join(ROOT, "src/web");

// registry.json item names at the tag pinned in components.json (v2.7.0).
const REGISTRY_ITEMS = new Set([
  "theme", "utils", "button", "card", "label", "input", "dialog", "tabs", "badge", "alert-dialog", "avatar", "checkbox",
  "collapsible", "drawer", "dropdown-menu", "popover", "progress", "scroll-area", "select", "separator", "sheet", "skeleton",
  "slider", "sonner", "switch", "textarea", "message", "bubble", "marker", "attachment", "message-scroller", "tooltip",
  "use-mobile", "item", "empty", "sidebar", "spinner", "field", "input-group", "toggle", "toggle-group", "button-group",
]);

// Primitives the registry does not ship yet. Each stays here only until it is
// added to design-system and pulled from there; none may import Radix.
const NOT_YET_IN_REGISTRY = new Set(["breadcrumb", "command"]);

const filesUnder = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? filesUnder(join(dir, entry.name)) : [join(dir, entry.name)],
  );

const itemName = (file: string) => basename(file, extname(file));
const sourceFiles = filesUnder(SRC).filter((file) => /\.tsx?$/.test(file));
const appFiles = sourceFiles.filter((file) => !file.includes("/components/ui/"));

describe("registry-only UI", () => {
  it("every ui primitive is a design-system registry item or a listed gap", () => {
    const vendored = [...filesUnder(join(SRC, "components/ui")), join(SRC, "lib/utils.ts")];
    expect(vendored.length).toBeGreaterThan(10);
    expect(vendored.map(itemName).filter((name) => !REGISTRY_ITEMS.has(name) && !NOT_YET_IN_REGISTRY.has(name))).toEqual([]);
  });

  it("components.json pins the registry alias to a release tag on the base-nova style", () => {
    const config = JSON.parse(readFileSync(join(ROOT, "components.json"), "utf8"));
    expect(config.style).toBe("base-nova");
    expect(config.registries["@design-system"].url).toMatch(/\/deanjstone\/design-system\/v\d+\.\d+\.\d+\/r\/\{name\}\.json$/);
  });

  it("nothing imports Radix, and package.json no longer depends on it", () => {
    const importsRadix = /from ['"](radix-ui|@radix-ui\/)/;
    expect(sourceFiles.filter((file) => importsRadix.test(readFileSync(file, "utf8")))).toEqual([]);

    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    const dependencies = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    expect(dependencies.filter((name) => name === "radix-ui" || name.startsWith("@radix-ui/"))).toEqual([]);
  });

  it("app code reaches the component library only through the registry primitives", () => {
    const forbidden = /from ['"](@base-ui\/react|@headlessui\/|@mui\/|antd|react-aria|@shadcn\/react)/;
    expect(appFiles.filter((file) => forbidden.test(readFileSync(file, "utf8")))).toEqual([]);
  });
});
