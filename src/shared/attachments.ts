/**
 * What may be attached to a message, and why a given attachment may not be
 * (spec #93 phase 7). Shared rather than duplicated: the client refuses at
 * attach time so the user finds out before writing a message around an image
 * that was never going to arrive, and the server refuses at send time because
 * a client can be stale. Story 38 forbids a silent drop on either side, so
 * every refusal returns a reason rather than a boolean.
 */

/**
 * The formats the model side accepts. Deliberately narrower than "any
 * image/*": a TIFF the agent will reject is better refused here, by name,
 * than sent and lost somewhere downstream.
 */
export const SUPPORTED_IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;

export type SupportedImageMimeType = (typeof SUPPORTED_IMAGE_MIME_TYPES)[number];

export const ATTACHMENT_LIMITS = {
  /**
   * Per image, after the client's downscale. A user message is persisted
   * verbatim as a `thread.message-recorded` event and replayed on every
   * thread.get-history — over Tailscale, to the phone this feature exists
   * for. 1 MiB is comfortably above a downscaled screenshot and low enough
   * that a Thread's history stays openable.
   */
  maxBytesPerImage: 1024 * 1024,
  maxImagesPerMessage: 4,
  /**
   * Longest edge the client downscales to. Anthropic downscales anything
   * larger before the model ever sees it, so nothing is lost by doing it
   * here — and doing it here is what keeps the persisted history small.
   */
  maxImageEdge: 1568,
} as const;

export interface AttachmentDescriptor {
  mimeType: string;
  /** Decoded size in bytes — not the base64 length. See base64ByteLength. */
  byteLength: number;
}

export interface AttachmentContext {
  /** Whether the connected agent advertised `promptCapabilities.image` at initialize. */
  acceptsImages: boolean;
}

function isSupportedImageType(mimeType: string): boolean {
  return (SUPPORTED_IMAGE_MIME_TYPES as readonly string[]).includes(mimeType);
}

/**
 * The capability gate on its own. Split out because the client applies it
 * *before* converting a camera-roll photo into a supported format — at which
 * point the file's own type is not yet the type that will be sent, so the
 * combined check below would refuse the wrong thing.
 */
export function refuseForCapability(context: AttachmentContext): string | undefined {
  return context.acceptsImages ? undefined : "The connected agent doesn't accept images, so this can't be attached.";
}

/** Reason this one attachment can't be sent, or undefined if it can. */
export function refuseAttachment(attachment: AttachmentDescriptor, context: AttachmentContext): string | undefined {
  if (!isSupportedImageType(attachment.mimeType)) {
    return `${attachment.mimeType} can't be attached — only ${SUPPORTED_IMAGE_MIME_TYPES.join(", ")} images are supported.`;
  }
  // Checked after the type so an unsupported file gets the more useful of the
  // two answers: "this kind of file, never" rather than "this agent, today".
  const capabilityRefusal = refuseForCapability(context);
  if (capabilityRefusal) return capabilityRefusal;
  if (attachment.byteLength <= 0) {
    return "That image is empty.";
  }
  if (attachment.byteLength > ATTACHMENT_LIMITS.maxBytesPerImage) {
    return `That image is too large to attach — the limit is 1 MB and it is ${formatBytes(attachment.byteLength)}.`;
  }
  return undefined;
}

/** Reason this whole set can't be sent, or undefined if it can. */
export function refuseAttachmentSet(
  attachments: readonly AttachmentDescriptor[],
  context: AttachmentContext,
): string | undefined {
  if (attachments.length === 0) return undefined;
  if (attachments.length > ATTACHMENT_LIMITS.maxImagesPerMessage) {
    return `A message can carry at most ${ATTACHMENT_LIMITS.maxImagesPerMessage} images.`;
  }
  for (const attachment of attachments) {
    const refusal = refuseAttachment(attachment, context);
    if (refusal) return refusal;
  }
  return undefined;
}

/**
 * Decoded byte length of a base64 payload, without allocating the decode.
 * The server sees attachments as base64 on the wire but every limit above is
 * expressed in real bytes, and decoding a set of images just to measure them
 * is the kind of work an over-cap payload would most like you to do.
 */
export function base64ByteLength(data: string): number {
  if (data.length === 0) return 0;
  let padding = 0;
  if (data.endsWith("==")) padding = 2;
  else if (data.endsWith("=")) padding = 1;
  return Math.floor((data.length * 3) / 4) - padding;
}

function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}
