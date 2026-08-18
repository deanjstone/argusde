import {
  ATTACHMENT_LIMITS,
  SUPPORTED_IMAGE_MIME_TYPES,
  refuseAttachment,
  refuseForCapability,
  type AttachmentContext,
} from "../../shared/attachments.js";

/**
 * Turning a picked or pasted file into something sendable (spec #93 phase 7).
 *
 * The sizing decisions are pure and tested in image-attachment.test.ts; the
 * encode itself needs a real canvas, so it is covered end to end by the
 * browser test in test/web-smoke.test.ts rather than faked in jsdom.
 */

export interface PreparedAttachment {
  /** Always one of the supported types — a converted source has already become JPEG by here. */
  mimeType: string;
  /** Base64, no data: prefix — exactly what goes on the wire. */
  data: string;
  /**
   * A data: URI for the thumbnail. Deliberately not a blob: URL from
   * URL.createObjectURL: the app's CSP is `img-src 'self' data:` and does not
   * allow blob:, so a blob thumbnail renders blank with only a console
   * message to show for it. One representation, no second encoding path.
   */
  previewUrl: string;
  /** The file's own name where it had one — a pasted image has none. */
  name: string;
  byteLength: number;
}

export type PrepareResult = { ok: true; attachment: PreparedAttachment } | { ok: false; reason: string };

/**
 * The size to draw at: unchanged when the image already fits, otherwise
 * scaled by its longest edge so the aspect ratio survives. Anything past this
 * bound is downscaled by the model side anyway, so nothing is lost — and it
 * is what keeps a persisted Thread's history openable over Tailscale.
 */
export function targetDimensions(
  width: number,
  height: number,
  maxEdge: number = ATTACHMENT_LIMITS.maxImageEdge,
): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= maxEdge) return { width, height };
  const scale = maxEdge / longest;
  // A dimension can round to 0 on an extreme aspect ratio, which produces a
  // zero-area canvas and an unreadable image rather than a small one.
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export interface ReencodingInput {
  width: number;
  height: number;
  byteLength: number;
  mimeType: string;
}

/**
 * Whether this source has to be redrawn rather than sent as it arrived.
 *
 * Note the format case: a phone's camera roll hands over HEIC or AVIF, which
 * the agent side doesn't take. Converting those is what makes story 33 —
 * "attach a screenshot from a phone" — actually work, where refusing them
 * would fail the one case the story is about.
 */
export function needsReencoding({ width, height, byteLength, mimeType }: ReencodingInput): boolean {
  if (Math.max(width, height) > ATTACHMENT_LIMITS.maxImageEdge) return true;
  if (byteLength > ATTACHMENT_LIMITS.maxBytesPerImage) return true;
  return !(SUPPORTED_IMAGE_MIME_TYPES as readonly string[]).includes(mimeType);
}

/** JPEG quality for a re-encode. High enough that text in a screenshot stays legible. */
const REENCODE_QUALITY = 0.85;
const REENCODE_MIME_TYPE = "image/jpeg";

async function toBase64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  // Chunked rather than String.fromCharCode(...bytes): spreading a megabyte
  // of bytes into an argument list overflows the call stack.
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function reencode(bitmap: ImageBitmap): Promise<Blob> {
  const { width, height } = targetDimensions(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("no 2d context");
  context.drawImage(bitmap, 0, 0, width, height);
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, REENCODE_MIME_TYPE, REENCODE_QUALITY),
  );
  if (!blob) throw new Error("canvas produced no image");
  return blob;
}

/**
 * Prepares one picked or pasted file for sending, or says why it can't be.
 * Every refusal carries a reason (story 38 forbids a silent drop), and the
 * shared rules in src/shared/attachments.ts are the ones applied — the same
 * rules the server enforces authoritatively when the message is actually sent.
 */
export async function prepareImageAttachment(file: File, context: AttachmentContext): Promise<PrepareResult> {
  // A non-image is refused on its own type, before the agent's capabilities
  // come into it: a PDF is not attachable against any agent.
  if (!file.type.startsWith("image/")) {
    const reason = refuseAttachment({ mimeType: file.type || "That file", byteLength: file.size }, context);
    return { ok: false, reason: reason ?? "That file can't be attached." };
  }

  // Checked before decoding, so an agent that takes no images doesn't make
  // the browser chew through a photo to reach the same answer.
  const capabilityRefusal = refuseForCapability(context);
  if (capabilityRefusal) return { ok: false, reason: capabilityRefusal };

  let blob: Blob = file;
  let mimeType = file.type;

  // Decoded unconditionally: whether a re-encode is needed depends on the
  // pixel dimensions, and the file itself only knows its byte size. A decode
  // that fails is its own answer — a format this browser can't read.
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return { ok: false, reason: `That image couldn't be read (${file.type}).` };
  }
  try {
    if (needsReencoding({ width: bitmap.width, height: bitmap.height, byteLength: file.size, mimeType })) {
      blob = await reencode(bitmap);
      mimeType = REENCODE_MIME_TYPE;
    }
  } catch {
    return { ok: false, reason: "That image couldn't be prepared for sending." };
  } finally {
    bitmap.close();
  }

  const data = await toBase64(blob);
  const refusal = refuseAttachment({ mimeType, byteLength: blob.size }, context);
  // Reachable when even a downscaled image is still over the cap — a very
  // large photograph of noise, say. Refused rather than truncated.
  if (refusal) return { ok: false, reason: refusal };

  return {
    ok: true,
    attachment: {
      mimeType,
      data,
      previewUrl: `data:${mimeType};base64,${data}`,
      name: file.name || "Pasted image",
      byteLength: blob.size,
    },
  };
}
