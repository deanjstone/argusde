import { chromium } from "playwright";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { execFileSync } from "node:child_process";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "argusde-search-"));
const git = (a) => execFileSync("git", a, { cwd: dir });
git(["init","-q","--initial-branch=main"]); git(["config","user.email","p@e.com"]); git(["config","user.name","P"]);
fs.mkdirSync(path.join(dir, "src"));
fs.writeFileSync(path.join(dir,"src/committed.ts"), "const first = 1;\nconst retryHandler = 2;\nconst third = 3;\n");
fs.mkdirSync(path.join(dir,"node_modules/pkg"), { recursive: true });
fs.writeFileSync(path.join(dir,"node_modules/pkg/i.js"), "retryHandler in a dependency\n");
fs.writeFileSync(path.join(dir,".gitignore"), "node_modules\n");
git(["add","-A"]); git(["commit","-qm","init"]);
// Uncommitted, written after the commit — the agent-just-made-this case.
fs.writeFileSync(path.join(dir,"src/uncommitted.ts"), "const retryHandler = 99;\n");

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport:{width:390,height:844} })).newPage();
const errors = []; page.on("pageerror", e => errors.push(e.message));
page.on("console", m => { if (m.type()==="error") errors.push(m.text()); });
await page.goto("http://127.0.0.1:4877/");
await page.getByRole("button", { name:/type a path manually/i }).click();
await page.getByLabel(/workspace path/i).fill(dir);
await page.getByRole("button", { name:/start/i }).click();
await page.waitForSelector('input[placeholder*="Message" i]', { timeout:25000 });
await page.getByRole("button", { name:"Files" }).click();
await page.waitForSelector("text=src/", { timeout:15000 });

await page.getByLabel(/search the working tree/i).fill("retryHandler");
await page.getByRole("button", { name:"Search" }).click();
await page.waitForSelector('[data-testid="search-results"]', { timeout:20000 });
const files = await page.locator('[data-testid="search-results"] p.font-mono').allTextContents();
console.log("files with matches:", files);
console.log("ignored dependency excluded:", !files.some(f => f.includes("node_modules")));
console.log("uncommitted file found:  ", files.some(f => f.includes("uncommitted")));

await page.getByRole("button", { name:/const retryHandler = 2;/ }).click();
await page.waitForSelector('[data-testid="preview-highlighted-line"]', { timeout:15000 });
const marked = await page.locator('[data-testid="preview-highlighted-line"]').textContent();
console.log("opened at the matching line:", JSON.stringify(marked?.trim()));

await page.getByRole("button", { name:/← Files/ }).click();
await page.getByRole("button", { name:/clear search/i }).click();
await page.waitForSelector("text=src/", { timeout:10000 });
console.log("cleared back to browsing ✓");

const noH = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
console.log("no horizontal scroll at 390px:", noH, "| tab bar:", await page.getByRole("button",{name:"Settings"}).isVisible());
console.log("console errors:", errors.length ? errors : "none");
await browser.close(); fs.rmSync(dir,{recursive:true,force:true});
