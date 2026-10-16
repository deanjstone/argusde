// Standalone diagnostics for the iOS terminal-input failure (argusde#133,
// restored by #146). Vite copies src/web/public into dist/web as-is, so this
// is served at /diag.html by `node dist/server/cli.js serve`. No inline
// script and no inline style, so it lives under the app's real CSP.
//
// The terminal check tells apart the three failures #133 names:
//   1. terminal.input never gets an answer       -> "input-unanswered"
//   2. it is accepted but the shell does nothing  -> "no-effect"
//   3. the shell runs it but no output push comes -> "output-not-pushed"
// Case 3 is told from case 2 by re-opening the terminal (idempotent) and
// reading the server's own scrollback for the command's output.
const logEl = document.getElementById("log");
const summaryEl = document.getElementById("summary");
const verdictEl = document.getElementById("verdict");
const keySummaryEl = document.getElementById("keysummary");

const params = new URLSearchParams(location.search);
const replyTimeoutMs = Number(params.get("timeoutMs")) || 15000;
const outputWaitMs = 3000;

function log(line) {
  logEl.textContent += line + "\n";
  window.scrollTo(0, document.body.scrollHeight);
}

function setVerdict(verdict, text) {
  verdictEl.dataset.verdict = verdict;
  verdictEl.textContent = text;
  log(text);
}

window.addEventListener("error", (event) => log(`JS ERROR: ${event.message} @ ${event.filename}:${event.lineno}`));
window.addEventListener("unhandledrejection", (event) => log(`UNHANDLED REJECTION: ${event.reason}`));

log(`device: ${navigator.userAgent}`);
log(
  `maxTouchPoints=${navigator.maxTouchPoints} viewport=${window.innerWidth}x${window.innerHeight} ` +
    `dpr=${window.devicePixelRatio} standalone=${window.matchMedia("(display-mode: standalone)").matches}`,
);

class NoReplyError extends Error {}

const pending = new Map();
let socket;
let commandCounter = 0;
let outputWatch = null;

function send(command) {
  const commandId = `diag-${++commandCounter}`;
  const message = { ...command, commandId };
  return new Promise((resolve, reject) => {
    pending.set(commandId, { resolve, reject });
    socket.send(JSON.stringify(message));
    setTimeout(() => {
      if (pending.has(commandId)) {
        pending.delete(commandId);
        reject(new NoReplyError(`${command.type}: no reply in ${replyTimeoutMs}ms`));
      }
    }, replyTimeoutMs);
  });
}

function connect() {
  const url = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`;
  log(`connecting to ${url}`);
  socket = new WebSocket(url);
  socket.addEventListener("open", () => log("socket OPEN"));
  socket.addEventListener("close", (event) => {
    summaryEl.textContent = "disconnected";
    log(`socket CLOSED code=${event.code} reason=${event.reason || "(none)"}`);
  });
  socket.addEventListener("error", () => log("socket ERROR"));
  socket.addEventListener("message", (event) => {
    let push;
    try {
      push = JSON.parse(event.data);
    } catch (error) {
      log(`bad JSON push: ${error}`);
      return;
    }
    if (push.type === "server.welcome") {
      summaryEl.textContent = `connected — apiVersion ${push.apiVersion}`;
      log(`welcome apiVersion=${push.apiVersion}`);
      return;
    }
    if (push.type === "command.result") {
      const entry = pending.get(push.commandId);
      pending.delete(push.commandId);
      if (!entry) return;
      if (push.ok) entry.resolve(push.result);
      else entry.reject(new Error(push.error));
      return;
    }
    if (push.type === "terminal.output") {
      log(`PUSH terminal.output ${JSON.stringify(push.data).slice(0, 120)}`);
      if (outputWatch && push.terminalId === outputWatch.terminalId) {
        outputWatch.received += push.data;
      }
      return;
    }
    if (push.type === "terminal.exit") {
      log(`PUSH terminal.exit ${JSON.stringify(push.exit)}`);
      return;
    }
    log(`PUSH ${push.type}`);
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runTerminalCheck() {
  verdictEl.dataset.verdict = "";
  verdictEl.textContent = "";
  outputWatch = null;
  try {
    log("--- terminal check ---");
    const projects = await send({ type: "project.list" });
    log(`projects: ${projects.length}`);
    if (projects.length === 0) return setVerdict("failed", "STOP: no projects — open the app once and make one");

    let target = null;
    for (const project of projects) {
      const threads = await send({ type: "thread.list", projectId: project.id });
      const open = threads.find((thread) => thread.closedAt === null);
      if (open) {
        target = { project, thread: open };
        break;
      }
    }
    if (!target) return setVerdict("failed", "STOP: no open thread found");
    log(`using thread ${target.thread.id.slice(0, 8)} in ${target.project.title}`);

    const threadId = target.thread.id;
    const opened = await send({ type: "terminal.open", threadId, cols: 80, rows: 24 });
    log(
      `terminal.open OK id=${opened.terminalId.slice(0, 8)} resumed=${opened.resumed} cwd=${opened.cwd} scrollback=${opened.scrollback.length}b`,
    );

    // The shell's arithmetic expansion means the marker only appears in the
    // output if the shell actually ran the line — the pty's echo of the
    // typed text carries "$((…))", not the expanded number.
    const runId = Date.now() % 100000;
    const marker = `DIAG_FROM_PHONE_${runId}`;
    outputWatch = { terminalId: opened.terminalId, received: "" };

    try {
      await send({ type: "terminal.input", threadId, terminalId: opened.terminalId, data: `echo DIAG_FROM_PHONE_$((${runId}+0))\n` });
    } catch (error) {
      if (error instanceof NoReplyError) {
        return setVerdict(
          "input-unanswered",
          `RESULT: terminal.input got no reply in ${replyTimeoutMs}ms — the input never reached the server, or its answer never came back`,
        );
      }
      throw error;
    }
    log("terminal.input OK (server accepted it)");

    const deadline = Date.now() + outputWaitMs;
    while (Date.now() < deadline && !outputWatch.received.includes(marker)) await delay(100);
    if (outputWatch.received.includes(marker)) {
      return setVerdict("ok", "RESULT: output came back — the send path works from this device");
    }

    log(`no ${marker} push after ${outputWaitMs}ms — reading the server's scrollback`);
    const reopened = await send({ type: "terminal.open", threadId, cols: 80, rows: 24 });
    if (reopened.scrollback.includes(marker)) {
      return setVerdict(
        "output-not-pushed",
        "RESULT: the shell ran the input (its output is in the server's scrollback) but the terminal.output push never arrived",
      );
    }
    return setVerdict("no-effect", "RESULT: the server accepted the input but the shell produced no output for it");
  } catch (error) {
    setVerdict("failed", `FAILED: ${error.message}`);
  } finally {
    outputWatch = null;
  }
}

document.getElementById("run").addEventListener("click", () => void runTerminalCheck());
document.getElementById("clear").addEventListener("click", () => {
  logEl.textContent = "";
});

// Keyboard probe: what does this device actually send?
const probe = document.getElementById("probe");
const keyCounts = { keydown: [], input: [], composition: 0 };
probe.addEventListener("keydown", (event) => {
  keyCounts.keydown.push(event.keyCode);
  updateKeySummary();
});
probe.addEventListener("input", (event) => {
  keyCounts.input.push(`${event.inputType}:${JSON.stringify(event.data)}:composed=${event.composed}`);
  updateKeySummary();
});
for (const type of ["compositionstart", "compositionupdate", "compositionend"]) {
  probe.addEventListener(type, () => {
    keyCounts.composition += 1;
    updateKeySummary();
  });
}
function updateKeySummary() {
  keySummaryEl.textContent = `keydown codes: [${keyCounts.keydown.join(",")}] | input: ${keyCounts.input.join(" ")} | composition events: ${keyCounts.composition}`;
}

connect();
