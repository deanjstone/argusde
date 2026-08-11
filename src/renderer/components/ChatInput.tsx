import { useState, type FormEvent } from "react";

interface Props {
  disabled: boolean;
  placeholder?: string;
  onSend: (text: string) => void;
}

export function ChatInput({ disabled, placeholder, onSend }: Props) {
  const [text, setText] = useState("");

  function handleSubmit(event: FormEvent): void {
    event.preventDefault();
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setText("");
  }

  return (
    <form className="chat-input" onSubmit={handleSubmit}>
      <input
        type="text"
        value={text}
        disabled={disabled}
        placeholder={placeholder ?? (disabled ? "Claude is working…" : "Message Claude Code…")}
        onChange={(event) => setText(event.target.value)}
      />
      <button type="submit" disabled={disabled || !text.trim()}>
        Send
      </button>
    </form>
  );
}
