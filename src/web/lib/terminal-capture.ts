/**
 * Terminal output on its way to the agent (spec #128 phase 3).
 *
 * Capture is always an explicit gesture — the selection, or the recent
 * output, because the user asked for one of them (story 28). Nothing here
 * guesses what was interesting: a terminal with no shell integration cannot
 * know where the last command began, and inventing a boundary would attach
 * the wrong thing confidently.
 *
 * Entirely client-side: the emulator already holds the text, so there is
 * nothing to ask the server for and no protocol change in this phase.
 */

export type CaptureSource = "selection" | "output";

export interface TerminalCapture {
  /** Already bounded — this is exactly what will be sent. */
  text: string;
  lines: number;
  /** True when output was dropped from the front to fit the bounds. */
  truncated: boolean;
  source: CaptureSource;
}

/**
 * Bounds on what one capture can carry.
 *
 * Sized for a message rather than for a log: 400 lines is a long failing
 * test run, and the byte cap is the backstop for output that is few lines
 * but enormous (a minified bundle printed to stdout, a base64 blob). Both
 * are far below anything that would trouble the wire — the point is that
 * what the agent is given stays readable, and that story 27's "40 MB log"
 * truncates visibly instead of being sent.
 */
export const CAPTURE_LIMITS = {
  maxLines: 400,
  maxBytes: 16 * 1024,
} as const;

/** Trims a terminal's trailing blank rows — a buffer read always ends in them, and they are not output. */
function withoutTrailingBlankLines(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1]!.trim() === "") end -= 1;
  return lines.slice(0, end);
}

export function boundCapture(raw: string, source: CaptureSource): TerminalCapture {
  // A terminal's line endings are its own business; a message should read
  // the way the output looked.
  const normalised = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const allLines = withoutTrailingBlankLines(normalised.split("\n"));

  let truncated = false;
  let lines = allLines;
  if (lines.length > CAPTURE_LIMITS.maxLines) {
    // The tail, always: the end of a log is the part that says what went
    // wrong.
    lines = lines.slice(lines.length - CAPTURE_LIMITS.maxLines);
    truncated = true;
  }

  let text = lines.join("\n");
  while (text.length > CAPTURE_LIMITS.maxBytes && lines.length > 1) {
    lines = lines.slice(1);
    text = lines.join("\n");
    truncated = true;
  }
  if (text.length > CAPTURE_LIMITS.maxBytes) {
    // A single line longer than the whole cap — cut it, keeping the end.
    text = text.slice(text.length - CAPTURE_LIMITS.maxBytes);
    truncated = true;
  }

  return { text, lines: text === "" ? 0 : text.split("\n").length, truncated, source };
}

/**
 * A fence long enough that nothing inside the block can close it early.
 *
 * Terminal output routinely contains backticks — a README being catted, a
 * shell error quoting a command. A three-backtick fence around it would end
 * the block at the first one and leak the rest of the log into the message
 * as prose.
 */
function fenceFor(text: string): string {
  const longestRun = Math.max(0, ...Array.from(text.matchAll(/`+/g), (match) => match[0].length));
  return "`".repeat(Math.max(3, longestRun + 1));
}

/**
 * The message the agent actually receives: the user's own words, then the
 * captured output in a labelled block.
 *
 * Sent as ordinary message text rather than as a new kind of attachment, so
 * it lands on the user's own message in the transcript (story 26) with no
 * protocol change and nothing to replay specially on history load.
 */
export function formatMessageWithCapture(text: string, capture: TerminalCapture | null): string {
  if (!capture || capture.text === "") return text;

  const label = capture.source === "selection" ? "Terminal selection" : "Terminal output";
  // The agent is told when it is looking at a tail. Without this it reasons
  // about "the whole output" and is wrong.
  const heading = capture.truncated
    ? `${label} (last ${CAPTURE_LIMITS.maxLines} lines, earlier output omitted):`
    : `${label}:`;
  const fence = fenceFor(capture.text);
  const block = [heading, fence, capture.text, fence].join("\n");

  return text ? `${text}\n\n${block}` : block;
}
