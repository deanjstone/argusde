// A deliberately un-cooperative agent subprocess: it speaks nothing, and
// crucially it does NOT exit when its stdin reaches EOF. That models the
// real claude-agent-acp's observed behavior — closing the ACP connection
// (which closes the child's stdin) is not on its own enough to make the
// process go away, which is exactly how ArgusDE leaked one agent process
// per closed Thread until the transport learned to kill its own child.
//
// Writes its pid to the file given as argv[2] so a test can assert on the
// process's real liveness rather than trusting the spawner's bookkeeping.
import fs from "node:fs";

const pidFile = process.argv[2];
if (pidFile) fs.writeFileSync(pidFile, String(process.pid));

// Keep stdin flowing and the event loop alive indefinitely — nothing here
// will ever voluntarily terminate this process.
process.stdin.resume();
setInterval(() => {}, 1 << 30);
