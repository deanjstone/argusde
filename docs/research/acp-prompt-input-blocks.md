# What Can ACP Carry as Prompt Input? — Research Brief

Ticket: [deanjstone/argusde#86](https://github.com/deanjstone/argusde/issues/86)

Sources read directly for this pass:

- `@agentclientprotocol/sdk` — installed in this worktree via `pnpm install` against the
  repo's declared `"@agentclientprotocol/sdk": "^1.3.0"` (`package.json`), which resolved to
  **1.3.0**. Read from `node_modules/@agentclientprotocol/sdk/dist/schema/types.gen.d.ts`
  (generated TypeScript types — the actual schema, not prose) and
  `node_modules/@agentclientprotocol/sdk/dist/acp.d.ts` (client/agent-facing classes).
- `@agentclientprotocol/claude-agent-acp` (npm) — **not** an ArgusDE dependency; located on
  this machine via the pnpm global store. `which claude-agent-acp` resolves the shim at
  `~/.local/share/pnpm/bin/claude-agent-acp`, whose `cmd-shim-target` comment points at the
  real package:
  `~/.local/share/pnpm/global/v11/413c-19f439d7a88/node_modules/@agentclientprotocol/claude-agent-acp`
  (version **0.57.0**, `package.json`). This package ships only compiled output
  (`dist/acp-agent.js` + `.d.ts`), no `src/` — read the compiled JS directly, which is
  readable (not minified/mangled) TypeScript-compiled-to-ESM.
- The ACP spec at [agentclientprotocol.com](https://agentclientprotocol.com) — `/protocol/content`,
  `/protocol/prompt-turn`, `/protocol/initialization`, `/protocol/slash-commands`. Where the
  prose and the schema could disagree, the schema (source of truth, machine-checked) was
  treated as authoritative; no disagreement was actually found in this pass.
- `deanjstone/t3code` fork (local checkout at `/home/deanj/repos/forks/t3code`), read-only,
  for question 4 only — confirming whether slash commands are a T3-only construct or an ACP
  one.

A version fact worth flagging up front: `claude-agent-acp`'s own `package.json` pins
`"@agentclientprotocol/sdk": "1.2.0"` (exact, not `^`), one minor behind the `1.3.0` ArgusDE
itself resolves against. This **does** matter for trustworthiness of citations below, so it
was checked directly: diffing `types.gen.d.ts`'s `ContentBlock`, `PromptCapabilities`, and
`PromptRequest` definitions between the two installed copies (1.2.0 from the pnpm global
store's `.pnpm` links, 1.3.0 from this worktree's `node_modules`) produced **zero diff** on
all three. The gap exists, but nothing in this brief's four answers is affected by it.

---

## 1. Does ACP support image/file content on inbound prompts, or only agent output?

**Answer: yes, inbound too — this is explicit in both the schema and the spec prose, not an inference.**

The schema's `ContentBlock` union (`node_modules/@agentclientprotocol/sdk/dist/schema/types.gen.d.ts:249-259`)
is one shared type used in both directions:

```ts
export type ContentBlock = (TextContent & { type: "text"; })
  | (ImageContent & { type: "image"; })
  | (AudioContent & { type: "audio"; })
  | (ResourceLink & { type: "resource_link"; })
  | (EmbeddedResource & { type: "resource"; });
```

Its doc comment (lines 234-247) says outright: *"Content blocks appear in: User prompts sent
via `session/prompt` — Language model output streamed through `session/update`
notifications — Progress updates and results from tool calls."* User prompts are listed
first, not as an afterthought.

The inbound request type, `PromptRequest`, uses this exact union for its `prompt` field
(`types.gen.d.ts:5095-5126`):

```ts
export type PromptRequest = {
  sessionId: SessionId;
  prompt: Array<ContentBlock>;   // <-- same ContentBlock union as agent output
  _meta?: { [key: string]: unknown } | null;
};
```

The doc comment on `prompt` (lines 5100-5114) is explicit about which variants are baseline
vs. opt-in: *"As a baseline, the Agent MUST support `ContentBlock::Text` and
`ContentBlock::ResourceLink`, while other variants are optionally enabled via
`PromptCapabilities`."*

`PromptCapabilities` (`types.gen.d.ts:1550-1576`) is the negotiation mechanism — three
booleans an agent returns from `initialize`, each gating one inbound content type:

```ts
export type PromptCapabilities = {
  image?: boolean;           // gates ContentBlock::Image in prompts
  audio?: boolean;           // gates ContentBlock::Audio in prompts
  embeddedContext?: boolean; // gates ContentBlock::Resource in prompts
  _meta?: { [key: string]: unknown } | null;
};
```

The spec's prose page (`agentclientprotocol.com/protocol/initialization`) matches the schema
word for word: *"all Agents MUST support `ContentBlock::Text` and `ContentBlock::ResourceLink`"*
as baseline, then *"The prompt may include `ContentBlock::Image`"* / `Audio` / `Resource` gated
by the three capability flags. The `/protocol/content` page states plainly that these blocks
"appear in ... User prompts sent via `session/prompt`" — the same sentence structure as the
schema comment above, so prose and schema agree here; no disagreement to flag.

**What ArgusDE's `ChatContentBlock` (`src/shared/acp-events.ts`) covers today is the*
*agent → client direction only** — the ticket's framing is correct. `image` blocks render fine
coming from the agent (`toChatContentBlock` in `src/utility/acp-session.ts:42-53` maps ACP's
`ContentBlock` straight onto `ChatContentBlock`, image included), but nothing in ArgusDE
constructs an inbound `ContentBlock[]` to send — see Q2.

---

## 2. What does `@agentclientprotocol/sdk` expose for constructing such a prompt?

**Types**: the `ContentBlock` union above (`ImageContent`, `AudioContent`, `ResourceLink`,
`EmbeddedResource` + their nested `TextResourceContents`/`BlobResourceContents`), all exported
from the package's public schema module and already imported into ArgusDE's own code (see
`src/utility/acp-session.ts:2-16`, which imports `ContentBlock` from `@agentclientprotocol/sdk`
today, just to decode agent output, not to build client input).

`ImageContent` (`types.gen.d.ts:317-344`):

```ts
export type ImageContent = {
  annotations?: Annotations | null;
  data: string;       // base64-encoded media payload
  mimeType: string;
  uri?: string | null;
  _meta?: { [key: string]: unknown } | null;
};
```

**Method**: the SDK's convenience wrapper class `ActiveSession` — the same class ArgusDE
already holds a reference to as `this.activeSession` in `AcpSession` — exposes `prompt()` typed
to accept exactly this union, not just a string
(`node_modules/@agentclientprotocol/sdk/dist/acp.d.ts:338`):

```ts
prompt(
  prompt: string | schema.ContentBlock | Array<schema.ContentBlock>,
  options?: SendRequestOptions,
): Promise<schema.PromptResponse>;
```

Its doc comment (lines 330-337): *"Strings are converted to one text content block. A single
content block is wrapped in an array."* — so `prompt([{type:"text",...}, {type:"image",
data, mimeType}])` is a directly supported call shape, no lower-level construction needed.
Underneath, `ClientSideConnection.prompt(params: schema.PromptRequest)`
(`acp.d.ts:1207`) is the raw JSON-RPC call `ActiveSession.prompt()` wraps; both accept the same
`ContentBlock` shapes, just at different levels of the API.

**ArgusDE's actual gap is one line, not a missing capability.** `AcpSession.sendMessage()`
(`src/utility/acp-session.ts:271-277`) is typed to accept only `text: string` and calls
`this.activeSession.prompt(text)` — the SDK method it's calling is *already* the
multi-content-block one; ArgusDE's own wrapper just narrows the input type before it gets
there. The SDK does not need extending for this; the ArgusDE-side signature does.

---

## 3. Does `claude-agent-acp` actually forward inbound image/resource blocks, or drop them?

**Answer: image blocks are forwarded live to the Claude Agent SDK's `query()` call. Resource
blocks are partially forwarded (text resources only — blob/binary resources are explicitly**
**dropped in code). Audio is unconditionally dropped, consistent with the bridge never**
**advertising `audio` support.**

The translation function is `promptToClaude()`
(`.../claude-agent-acp/dist/acp-agent.js:3672-3747`), which converts an ACP `PromptRequest`
into the Claude Agent SDK's own `SDKUserMessage` shape:

```js
export function promptToClaude(prompt) {
  const content = [];
  const context = [];
  for (const chunk of prompt.prompt) {
    switch (chunk.type) {
      case "text": { /* ...MCP command rewrite, then */ content.push({ type: "text", text }); break; }
      case "resource_link": {
        content.push({ type: "text", text: formatUriAsLink(chunk.uri) });
        break;
      }
      case "resource": {
        if ("text" in chunk.resource) {
          content.push({ type: "text", text: formatUriAsLink(chunk.resource.uri) });
          context.push({ type: "text", text: `\n<context ref="${chunk.resource.uri}">\n${chunk.resource.text}\n</context>` });
        }
        // Ignore blob resources (unsupported)
        break;
      }
      case "image":
        if (chunk.data) {
          content.push({ type: "image", source: { type: "base64", data: chunk.data, media_type: chunk.mimeType } });
        } else if (chunk.uri && chunk.uri.startsWith("http")) {
          content.push({ type: "image", source: { type: "url", url: chunk.uri } });
        }
        break;
      // Ignore audio and other unsupported types
      default: break;
    }
  }
  content.push(...context);
  return { type: "user", message: { role: "user", content }, session_id: prompt.sessionId, parent_tool_use_id: null };
}
```

This is not dead/unreachable code — it is called on every real prompt. `prompt(params)`
(`acp-agent.js:571-609`) is the ACP-facing handler wired to `session/prompt`
(`methods.agent.session.prompt` at line 4194); it calls
`const userMessage = promptToClaude(params);` (line 582) then
`session.input.push(userMessage);` (line 606). `session.input` is a `Pushable` created per
session (`const input = new Pushable();`, line 2720) and handed directly to the Claude Agent
SDK as the live prompt stream: `const q = query({ prompt: input, options });` (line 2937),
where `query` is imported from `@anthropic-ai/claude-agent-sdk` (line 2, the top-level
import). So the chain is genuinely: `session/prompt` → `promptToClaude()` → `session.input`
(the same `Pushable` `query()` reads from) → Anthropic's own agent loop. There is no
intermediate filter that strips image blocks after this point in the code read.

This matches what the bridge advertises during `initialize()`
(`acp-agent.js:410-421`):

```js
return {
  protocolVersion: 1,
  agentCapabilities: {
    _meta: { claudeCode: { promptQueueing: true } },
    promptCapabilities: {
      image: true,
      embeddedContext: true,
      // no `audio: true` — matches the "Ignore audio" branch in promptToClaude()
    },
    ...
  },
};
```

`audio` is never set `true`, which is consistent (capability advertisement and actual
forwarding behavior agree) rather than a spec-vs-bridge violation: an agent that doesn't
advertise `audio: true` is not obligated to accept `ContentBlock::Audio`, and this one
explicitly ignores it if sent anyway. `resource`/embedded context is advertised `true` and is
genuinely forwarded, but only its text form — a `BlobResourceContents` (base64 binary embedded
resource) is matched by the `"resource"` case, fails the `"text" in chunk.resource` check, and
falls through with **no branch that appends anything to `content`** — i.e. a client-side PDF or
other binary attached as an *embedded resource* (as opposed to an `image` block) would be
silently dropped by this bridge even though the spec's `EmbeddedResource` type explicitly
allows `BlobResourceContents`. This is the one place spec-permitted and bridge-actual diverge
found in this pass — worth stating plainly rather than glossing over: **the spec permits binary
blob resources in prompts; `claude-agent-acp` 0.57.0 silently drops them.** Image data (also
binary, also base64) is fine because it goes through the dedicated `image` branch, not the
`resource` one.

---

## 4. Is there a slash-command / prompt-template concept in ACP itself?

**Answer: ACP has a real, protocol-level slash-command mechanism — but it's a thin discovery/**
**advertisement contract, not a templating or expansion engine. Templating-style richness (as**
**seen in T3 Code's composer) is layered on top by the client, not defined by ACP.**

The schema defines `AvailableCommand` (`types.gen.d.ts:3817-3840`):

```ts
export type AvailableCommand = {
  name: string;
  description: string;
  input?: AvailableCommandInput | null;  // = UnstructuredCommandInput = { hint: string }
  _meta?: { [key: string]: unknown } | null;
};
```

and the session notification that advertises a list of them,
`AvailableCommandsUpdate` (`types.gen.d.ts:3866-3884`, `sessionUpdate: "available_commands_update"`
at line 3466). That's the entire protocol surface for commands: a name, a human-readable
description, and an optional free-text input hint. There is **no** field for a body/template,
no structured argument schema beyond the single unstructured hint, and no
expansion/substitution semantics defined anywhere in the schema. The spec's
`/protocol/slash-commands` page confirms the division of responsibility in prose: the agent
sends `available_commands_update` (and may resend it as commands change), the user types
`/name args` as ordinary prompt text, and *the agent* — not the client, not the protocol layer —
"recognizes the command prefix and processes it accordingly." The client's only protocol-level
job is to advertise the discovered names/descriptions/hints in its UI; it does not own
expansion.

`claude-agent-acp` implements the agent side of this fully: it calls
`this.sendAvailableCommandsUpdate(sessionId)` at four call sites
(`acp-agent.js:457, 473, 481, 490`) and constructs the notification via
`getAvailableSlashCommands(message.commands)` (line 1093) / `getAvailableSlashCommands(commands)`
(line 2433) — i.e. it surfaces Claude Code's own slash commands (its system-message-reported
command list) through this exact ACP mechanism, not a bespoke one.

T3 Code layers something considerably richer on top, confirmed read-only in the local fork
checkout. `ComposerCommandMenu.tsx`
(`/home/deanj/repos/forks/t3code/apps/web/src/components/chat/ComposerCommandMenu.tsx:23-54`)
defines a `ComposerCommandItem` union with **four** kinds: `"path"` (file/dir mentions),
`"slash-command"` (T3's own built-in commands, entirely client-defined), `"provider-slash-command"`
(exactly the ACP-sourced `AvailableCommand` list, wrapped as `ServerProviderSlashCommand`), and
`"skill"` (provider-advertised skills, a separate concept from slash commands). The filtering in
the same file (lines 93-94) explicitly separates `builtInItems` (`type === "slash-command"`)
from `providerItems` (`type === "provider-slash-command"`) — i.e. T3's own code distinguishes,
by construction, between commands ACP told it about and commands it invented itself. The
matching/ranking logic (`composerSlashCommandSearch.ts`) operates over both kinds uniformly for
UI purposes but never expands the ACP-sourced ones — it still just types `/name` text into the
prompt and lets the agent do the interpretation described above.

So: the answer isn't a clean binary. ACP itself defines a (thin) slash-command concept — good
enough for "here's what's available, show it to the user" — and `claude-agent-acp` uses it
faithfully to surface Claude Code's real commands. Anything that looks like a template/expansion
system, or client-authored commands with no agent involvement, is T3-specific UI-layer
invention, not part of ACP.

---

## What this means for ArgusDE

**Composer image/file attachments are buildable against what's already installed, at low**
**protocol cost — the constraint is entirely in ArgusDE's own code, not the SDK or the bridge.**

- The SDK already exports everything needed (`ContentBlock`, `ImageContent`, etc.) and
  `ActiveSession.prompt()` already accepts `Array<ContentBlock>` — no SDK upgrade, no new
  dependency.
- `claude-agent-acp` 0.57.0 (the version actually running on this machine) genuinely forwards
  `image` blocks to Claude's own agent loop, and advertises `promptCapabilities.image: true` so
  a client is protocol-correct in sending them without a separate negotiation step.
- The one real piece of implementation work is in ArgusDE's own `AcpSession.sendMessage()`
  (`src/utility/acp-session.ts:271-277`), which needs its signature widened from `text: string`
  to accept `string | ContentBlock | ContentBlock[]` (mirroring the SDK's own `prompt()`
  signature) and a renderer-side attachment UI (file picker → base64-encode → `ImageContent`)
  feeding it. Everything downstream of that one call already exists.
- **Two caveats to carry into implementation, not glossed over:**
  1. **Binary embedded resources (`ContentBlock::Resource` with `BlobResourceContents`) are**
     **silently dropped by this bridge version**, even though the spec allows them and the
     bridge advertises `embeddedContext: true`. If ArgusDE ever wants to attach non-image
     binary files (PDFs, etc.) as embedded resources rather than plain image blocks, that path
     is currently a dead end against `claude-agent-acp` 0.57.0 — worth re-checking against a
     newer bridge version before relying on it, not assuming it works because the capability
     flag is set.
  2. **Non-image binary files can still work today via the `image` content type only if they**
     **are actual images** (`mimeType`-tagged base64 or an `http(s)` URL) — the `image` branch
     in `promptToClaude()` is the only binary-carrying path confirmed to survive to Claude's
     agent loop. Arbitrary file attachments (code files, text documents) should go through
     `resource` with `TextResourceContents` (confirmed forwarded, appended as an inline
     `<context>` block) rather than treating them as generic binary blobs.
- Slash commands are a separate, smaller lift if ever wanted: ACP already delivers Claude
  Code's real command list via `available_commands_update`, so a composer command-menu in
  ArgusDE would mostly be UI work consuming a notification `AcpSession` doesn't currently
  surface at all (it's not in `AcpSessionEvent` in `src/shared/acp-events.ts` today) — not a
  protocol gap.
