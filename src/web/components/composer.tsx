import { useState } from "react";
import { ATTACHMENT_LIMITS, SUPPORTED_IMAGE_MIME_TYPES } from "../../shared/attachments.js";
import { prepareImageAttachment, type PreparedAttachment, type PrepareResult } from "../lib/image-attachment.js";
import { Button } from "./ui/button.js";
import { Input } from "./ui/input.js";
import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTitle,
} from "./ui/attachment.js";

/** What a message carries besides its text — exactly the wire shape. */
export interface MessageAttachment {
  mimeType: string;
  data: string;
}

export interface ComposerProps {
  onSend: (text: string, attachments: MessageAttachment[]) => void;
  /** Whether the connected agent advertised image support at initialize. */
  acceptsImages: boolean;
  disabled?: boolean;
  /**
   * Injected so the component's own behaviour is testable without a canvas —
   * the real implementation decodes and re-encodes through one, which jsdom
   * has no version of. Production always uses the default.
   */
  prepareAttachment?: (file: File, context: { acceptsImages: boolean }) => Promise<PrepareResult>;
}

/**
 * The message composer (spec #93 phase 7). Extracted from chat-view rather
 * than grown in place: phases 8–10 each add a composer-adjacent surface
 * (slash commands, context meter, plan pill), and four features layered onto
 * an inline form is how a component stops being reviewable.
 */
export function Composer({ onSend, acceptsImages, disabled = false, prepareAttachment = prepareImageAttachment }: ComposerProps) {
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<PreparedAttachment[]>([]);
  // A single message rather than a list: a refusal is about the thing the
  // user just tried, and stacking them turns one mistake into a wall.
  const [refusal, setRefusal] = useState<string | undefined>(undefined);

  const atAttachmentLimit = attachments.length >= ATTACHMENT_LIMITS.maxImagesPerMessage;

  async function attach(files: File[]): Promise<void> {
    // Accumulated locally rather than committed per file: setAttachments is
    // async, so counting against `attachments` inside the loop would read the
    // same stale length for every file and let a multi-file drop past the cap.
    const accepted: PreparedAttachment[] = [];
    let refusalMessage: string | undefined;

    for (const file of files) {
      if (attachments.length + accepted.length >= ATTACHMENT_LIMITS.maxImagesPerMessage) {
        refusalMessage = `A message can carry at most ${ATTACHMENT_LIMITS.maxImagesPerMessage} images.`;
        break;
      }
      const result = await prepareAttachment(file, { acceptsImages });
      if (!result.ok) {
        refusalMessage = result.reason;
        break;
      }
      accepted.push(result.attachment);
    }

    // Whatever was accepted is kept even when a later file was refused —
    // discarding good attachments because a fifth one was too big would make
    // the refusal cost more than the mistake.
    if (accepted.length > 0) setAttachments((current) => [...current, ...accepted]);
    setRefusal(refusalMessage);
  }

  function handlePaste(event: React.ClipboardEvent): void {
    // Only intercept a paste that actually carries files. Pasting a URL or a
    // block of code is the overwhelmingly common case and must stay untouched.
    const files = Array.from(event.clipboardData?.files ?? []);
    if (files.length === 0) return;
    event.preventDefault();
    void attach(files);
  }

  function handleSubmit(event: React.FormEvent): void {
    event.preventDefault();
    const trimmed = text.trim();
    // An image on its own is a message — "here, look at this" needs no words.
    if (!trimmed && attachments.length === 0) return;
    onSend(
      trimmed,
      attachments.map((attachment) => ({ mimeType: attachment.mimeType, data: attachment.data })),
    );
    setText("");
    setAttachments([]);
    setRefusal(undefined);
  }

  return (
    <form onSubmit={handleSubmit} className="border-t border-border p-3">
      {refusal && (
        <p role="alert" className="mb-2 text-xs text-destructive">
          {refusal}
        </p>
      )}

      {attachments.length > 0 && (
        <AttachmentGroup className="mb-2">
          {attachments.map((attachment, index) => (
            <Attachment key={`${attachment.name}-${index}`} size="sm">
              <AttachmentMedia variant="image">
                {/* The thumbnail is the same data: URI that will be sent — see
                    image-attachment.ts on why not a blob: URL. Alt is the file's
                    own name so the list is navigable by screen reader, where a
                    row of "image" would not be. */}
                <img src={attachment.previewUrl} alt={attachment.name} />
              </AttachmentMedia>
              <AttachmentContent>
                <AttachmentTitle>{attachment.name}</AttachmentTitle>
              </AttachmentContent>
              <AttachmentActions>
                <AttachmentAction
                  type="button"
                  aria-label={`Remove ${attachment.name}`}
                  onClick={() => setAttachments((current) => current.filter((_, i) => i !== index))}
                >
                  ✕
                </AttachmentAction>
              </AttachmentActions>
            </Attachment>
          ))}
        </AttachmentGroup>
      )}

      <div className="flex items-center gap-2">
        {/* No attach control at all for an agent that never advertised images:
            an affordance that always refuses is worse than none. A *paste* is
            still handled and still explained (story 38) — the user didn't
            reach for a control there, so there is nothing to hide. */}
        {/* The input carries the accessible name and the label is the visual
            target: a hidden-but-focusable file input inside a styled label is
            the one pattern that keeps both the keyboard and the pointer
            working without a second control. */}
        {acceptsImages && (
            <label
              htmlFor="composer-attach"
              className="inline-flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-md border border-border text-muted-foreground hover:text-foreground has-disabled:pointer-events-none has-disabled:opacity-50"
            >
              <span aria-hidden="true">＋</span>
              <input
                id="composer-attach"
                aria-label="Attach an image"
                type="file"
                accept={SUPPORTED_IMAGE_MIME_TYPES.join(",")}
                multiple
                disabled={disabled || atAttachmentLimit}
                className="sr-only"
                onChange={(event) => {
                  const files = Array.from(event.target.files ?? []);
                  // Reset first: picking the same file twice in a row fires no
                  // change event otherwise, so a removed attachment could not
                  // be re-added without picking something else in between.
                  event.target.value = "";
                  void attach(files);
                }}
              />
            </label>
        )}
        <Input
          placeholder="Message ArgusDE…"
          value={text}
          onChange={(event) => setText(event.target.value)}
          onPaste={handlePaste}
          disabled={disabled}
          className="flex-1"
        />
        <Button type="submit" size="icon" aria-label="Send" disabled={disabled}>
          →
        </Button>
      </div>
    </form>
  );
}
