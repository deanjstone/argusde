// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { Composer } from "./composer.js";
import type { PrepareResult } from "../lib/image-attachment.js";

/**
 * The composer's attachment behaviour (spec #93 phase 7, stories 33–38).
 *
 * The real encoder needs a canvas, which jsdom does not have — so it is
 * injected here and exercised for real in test/web-smoke.test.ts. What these
 * tests own is everything around it: what the user sees, what gets sent, and
 * that a refusal is shown rather than swallowed.
 */

function prepared(overrides: Partial<{ name: string; data: string; mimeType: string }> = {}): PrepareResult {
  return {
    ok: true,
    attachment: {
      mimeType: overrides.mimeType ?? "image/png",
      data: overrides.data ?? "AAAA",
      previewUrl: `data:${overrides.mimeType ?? "image/png"};base64,${overrides.data ?? "AAAA"}`,
      name: overrides.name ?? "screenshot.png",
      byteLength: 3,
    },
  };
}

function imageFile(name = "screenshot.png", type = "image/png"): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type });
}

function renderComposer(props: Partial<React.ComponentProps<typeof Composer>> = {}) {
  const onSend = props.onSend ?? vi.fn();
  const prepare = props.prepareAttachment ?? vi.fn(async () => prepared());
  render(
    <Composer
      onSend={onSend}
      acceptsImages={props.acceptsImages ?? true}
      disabled={props.disabled ?? false}
      prepareAttachment={prepare}
      availableCommands={props.availableCommands ?? []}
    />,
  );
  return { onSend, prepare };
}

describe("Composer", () => {
  it("sends plain text with no attachments, exactly as it did before attachments existed", async () => {
    const { onSend } = renderComposer();

    type(screen.getByPlaceholderText(/message argusde/i), "hello there");
    fireEvent.click(screen.getByRole("button", { name: /send/i }));

    expect(onSend).toHaveBeenCalledWith("hello there", []);
  });

  it("shows a thumbnail of what was attached, named, before anything is sent (story 35)", async () => {
    renderComposer();

    upload(screen.getByLabelText(/attach an image/i), imageFile());

    const thumbnail = await screen.findByRole("img", { name: /screenshot\.png/i });
    expect(thumbnail).toHaveAttribute("src", "data:image/png;base64,AAAA");
  });

  it("sends the attachment alongside the text (stories 33, 37)", async () => {
    const { onSend } = renderComposer();

    upload(screen.getByLabelText(/attach an image/i), imageFile());
    await screen.findByRole("img", { name: /screenshot\.png/i });
    type(screen.getByPlaceholderText(/message argusde/i), "what is this?");
    fireEvent.click(screen.getByRole("button", { name: /send/i }));

    expect(onSend).toHaveBeenCalledWith("what is this?", [{ mimeType: "image/png", data: "AAAA" }]);
  });

  it("sends an attachment on its own — an image is a message even with nothing typed", async () => {
    const { onSend } = renderComposer();

    upload(screen.getByLabelText(/attach an image/i), imageFile());
    await screen.findByRole("img", { name: /screenshot\.png/i });
    fireEvent.click(screen.getByRole("button", { name: /send/i }));

    expect(onSend).toHaveBeenCalledWith("", [{ mimeType: "image/png", data: "AAAA" }]);
  });

  it("still refuses to send nothing at all", async () => {
    const { onSend } = renderComposer();

    fireEvent.click(screen.getByRole("button", { name: /send/i }));

    expect(onSend).not.toHaveBeenCalled();
  });

  it("removes an attachment before sending, so a mis-paste is not a sent message (story 36)", async () => {
    const { onSend } = renderComposer();

    upload(screen.getByLabelText(/attach an image/i), imageFile());
    await screen.findByRole("img", { name: /screenshot\.png/i });
    fireEvent.click(screen.getByRole("button", { name: /remove screenshot\.png/i }));

    expect(screen.queryByRole("img", { name: /screenshot\.png/i })).toBeNull();

    type(screen.getByPlaceholderText(/message argusde/i), "never mind");
    fireEvent.click(screen.getByRole("button", { name: /send/i }));
    expect(onSend).toHaveBeenCalledWith("never mind", []);
  });

  it("clears the attachments once a message is sent, so the next one does not resend them", async () => {
    const { onSend } = renderComposer();

    upload(screen.getByLabelText(/attach an image/i), imageFile());
    await screen.findByRole("img", { name: /screenshot\.png/i });
    type(screen.getByPlaceholderText(/message argusde/i), "one");
    fireEvent.click(screen.getByRole("button", { name: /send/i }));

    type(screen.getByPlaceholderText(/message argusde/i), "two");
    fireEvent.click(screen.getByRole("button", { name: /send/i }));

    expect(onSend).toHaveBeenLastCalledWith("two", []);
  });

  it("shows the reason an attachment was refused rather than dropping it silently (story 38)", async () => {
    renderComposer({
      prepareAttachment: vi.fn(async () => ({ ok: false as const, reason: "application/pdf can't be attached." })),
    });

    upload(screen.getByLabelText(/attach an image/i), imageFile("notes.pdf", "application/pdf"));

    expect(await screen.findByRole("alert")).toHaveTextContent("application/pdf can't be attached.");
  });

  it("clears a previous refusal once an attachment succeeds", async () => {
    const prepare = vi
      .fn<(file: File) => Promise<PrepareResult>>()
      .mockResolvedValueOnce({ ok: false, reason: "That image is too large to attach." })
      .mockResolvedValueOnce(prepared());
    renderComposer({ prepareAttachment: prepare });

    upload(screen.getByLabelText(/attach an image/i), imageFile());
    expect(await screen.findByRole("alert")).toBeTruthy();

    upload(screen.getByLabelText(/attach an image/i), imageFile());
    await screen.findByRole("img", { name: /screenshot\.png/i });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("offers no attach control at all when the agent never advertised images", () => {
    renderComposer({ acceptsImages: false });

    expect(screen.queryByLabelText(/attach an image/i)).toBeNull();
  });

  it("still explains a pasted image against an agent that can't take one — no control, but no silent drop either", async () => {
    renderComposer({
      acceptsImages: false,
      prepareAttachment: vi.fn(async () => ({
        ok: false as const,
        reason: "The connected agent doesn't accept images, so this can't be attached.",
      })),
    });

    const input = screen.getByPlaceholderText(/message argusde/i);
    pasteImage(input);

    expect(await screen.findByRole("alert")).toHaveTextContent(/doesn't accept images/i);
  });

  it("attaches an image pasted into the composer, so attaching is one gesture (story 34)", async () => {
    const { prepare } = renderComposer();

    const input = screen.getByPlaceholderText(/message argusde/i);
    pasteImage(input);

    await screen.findByRole("img", { name: /screenshot\.png/i });
    expect(prepare).toHaveBeenCalled();
  });

  it("leaves a pasted-text paste alone — pasting a URL must not be treated as an attachment", async () => {
    const { prepare } = renderComposer();

    const input = screen.getByPlaceholderText(/message argusde/i);
    pasteText(input, "https://example.com");

    await waitFor(() => expect(input).toHaveValue("https://example.com"));
    expect(prepare).not.toHaveBeenCalled();
  });

  describe("slash commands (spec #93 phase 8)", () => {
    const COMMANDS = [
      { name: "review", description: "Review the current diff", inputHint: "What to focus on" },
      { name: "plan", description: "Draft a plan", inputHint: null },
    ];

    it("opens the command menu when the message starts with a slash (story 39)", async () => {
      renderComposer({ availableCommands: COMMANDS });

      type(screen.getByPlaceholderText(/message argusde/i), "/");

      expect(await screen.findByText("review")).toBeInTheDocument();
    });

    it("narrows the menu with whatever follows the slash (story 41)", async () => {
      renderComposer({ availableCommands: COMMANDS });

      type(screen.getByPlaceholderText(/message argusde/i), "/pl");

      expect(await screen.findByText("plan")).toBeInTheDocument();
      expect(screen.queryByText("review")).toBeNull();
    });

    it("puts the picked command in the composer, ready for an argument (stories 39, 43)", async () => {
      renderComposer({ availableCommands: COMMANDS });
      const input = screen.getByPlaceholderText(/message argusde/i);

      type(input, "/pl");
      fireEvent.click(await screen.findByText("plan"));

      // A trailing space, so the caret is where an argument goes rather than
      // glued to the command name.
      await waitFor(() => expect(input).toHaveValue("/plan "));
    });

    it("closes the menu once a command is picked, so it doesn't reopen over the argument", async () => {
      renderComposer({ availableCommands: COMMANDS });

      type(screen.getByPlaceholderText(/message argusde/i), "/pl");
      fireEvent.click(await screen.findByText("plan"));

      await waitFor(() => expect(screen.queryByText("Draft a plan")).toBeNull());
    });

    it("leaves the menu closed once an argument is being typed (story 43)", async () => {
      renderComposer({ availableCommands: COMMANDS });

      // The space ends the command name — from here the user is writing the
      // argument, and a menu popping back over it would be in the way.
      type(screen.getByPlaceholderText(/message argusde/i), "/review my diff");

      await waitFor(() => expect(screen.queryByText("Review the current diff")).toBeNull());
    });

    it("never opens for a slash that isn't at the start — a path is not a command", async () => {
      renderComposer({ availableCommands: COMMANDS });

      type(screen.getByPlaceholderText(/message argusde/i), "look at src/web/app.tsx");

      await waitFor(() => expect(screen.queryByText("Review the current diff")).toBeNull());
    });

    it("offers no menu at all when the agent advertises no commands (story 45)", async () => {
      renderComposer({ availableCommands: [] });

      type(screen.getByPlaceholderText(/message argusde/i), "/");

      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    });

    it("picks a command with the keyboard, and Enter does not send the half-typed name (story 42)", async () => {
      const { onSend } = renderComposer({ availableCommands: COMMANDS });
      const input = screen.getByPlaceholderText(/message argusde/i);

      type(input, "/");
      await screen.findByText("review");
      fireEvent.keyDown(input, { key: "ArrowDown" });
      fireEvent.keyDown(input, { key: "Enter" });

      await waitFor(() => expect(input).toHaveValue("/plan "));
      // Enter belonged to the menu, not to the form — sending "/" would be a
      // message the user never meant to send.
      expect(onSend).not.toHaveBeenCalled();
    });

    it("sends a completed command as an ordinary message — the agent parses the slash, not this app", async () => {
      const { onSend } = renderComposer({ availableCommands: COMMANDS });
      const input = screen.getByPlaceholderText(/message argusde/i);

      type(input, "/pl");
      fireEvent.click(await screen.findByText("plan"));
      await waitFor(() => expect(input).toHaveValue("/plan "));
      type(input, "/plan the refactor");
      fireEvent.click(screen.getByRole("button", { name: /send/i }));

      expect(onSend).toHaveBeenCalledWith("/plan the refactor", []);
    });
  });

  it("disables everything while the thread is closed", async () => {
    renderComposer({ disabled: true });

    expect(screen.getByPlaceholderText(/message argusde/i)).toBeDisabled();
    expect(screen.getByRole("button", { name: /send/i })).toBeDisabled();
  });
});

/**
 * A paste carrying a real file. jsdom's ClipboardEvent populates no
 * clipboardData of its own, so the shape the handler reads is supplied
 * directly — the same shape a browser provides.
 */
function pasteImage(target: HTMLElement): void {
  fireEvent.paste(target, { clipboardData: { files: [imageFile()] } });
}

function pasteText(target: HTMLElement, text: string): void {
  // A text paste carries no files at all — the case the composer must leave
  // alone, since pasting a URL or a block of code is the common one.
  fireEvent.paste(target, { clipboardData: { files: [] } });
  fireEvent.change(target, { target: { value: text } });
}

function type(target: HTMLElement, value: string): void {
  fireEvent.change(target, { target: { value } });
}

function upload(input: HTMLElement, file: File): void {
  // `files` is read-only on a real input, so fireEvent's `target` shorthand
  // can't assign it — defined directly instead, then the change dispatched.
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  fireEvent.change(input);
}
