# pi-session-correlation

Stamps session-correlation headers onto every model request pi sends, so a
fronting proxy (loopia) can attribute a call to its session, turn, and parent
session **without re-deriving them from prompt text**.

Companion RFC: `loopia/docs/rfcs/session-correlation-headers.md`.

## Why this exists

The proxy sees one HTTP request per model call and no session identity — pi sends
none today. Session grouping currently has to be *inferred*, and exact prefix-tree
chaining measurably fails (7 of 905 calls linked on a sampled day) because dynamic
blocks — task-list reminders, timestamps — are re-rendered into the prompt between
calls and break byte-stable prefixes.

Some of this pi can already emit: for `openai-responses` models it sets
`session_id` / `x-client-request-id` from `options.sessionId` on every request, and
`models.json` `compat` can turn the same on for `openai-completions`.

**This extension is only strictly necessary for `x-pi-session-id` and
`x-pi-parent-session-id`** — the two values that exist nowhere else on the wire. Turn
boundaries, cwd, and message counts are all derivable by the proxy from the request body
it already receives. Emitting them here is the cheaper and cleaner route, not the only
one: if this extension is ever disabled, those columns go null while `session-id` survives
via the `models.json` path. Worth knowing before anything treats them as guaranteed.

## Headers emitted

| Header | Source | Notes |
|---|---|---|
| `x-pi-session-id` | `sessionManager.getSessionId()` | matches the id in the session file name |
| `x-pi-turn-id` | `<session-id>:<turnIndex>` | **tool-loop granularity** — see caveat below |
| `x-pi-turn-index` | `turn_start.turnIndex` | |
| `x-pi-call-seq` | per-session counter | **best effort** — resets on extension reload, restart, or resume; ordering within one process run, not a durable sequence |
| `x-pi-parent-session-id` | session header `parentSession` | id recovered from the parent path; absent for root sessions |
| `x-pi-cwd` | `ctx.cwd` / `sessionManager.getCwd()` | the project dimension; **sha256 prefix if the path is too long for a header** |
| `x-pi-session-name` | `sessionManager.getSessionName()` | set via `/name` / `--name`; hashed on overflow |
| `x-pi-harness` | constant `pi` | distinguishes pi traffic from other harnesses |

Existing header keys are never overwritten, so an explicit `models.json` header still
wins.

## Caveats worth knowing before you build on these

- **`turnIndex` is pi turns, not human messages.** One assistant response that issues
  tool calls starts another turn. If you need "one human message" granularity, that is
  a different grain — name the column accordingly on the proxy side.
- **Absence is meaningful.** A missing `x-pi-parent-session-id` means a root session.
  The extension omits it rather than writing an empty value, so consumers must treat
  absent as a real state (`usageSource`-style), not as zero.
- **Values that cannot be represented are skipped, not guessed**, for the short identifier
  fields.
- **Oversized values are hashed, not dropped, where absence means something**
  (`x-pi-cwd`, `x-pi-session-name`): beyond the cap or containing non-ASCII, they become a
  stable sha256 prefix so the dimension stays joinable against a mapping table. Short
  identifier fields are still skipped rather than mangled. Handler failures do not change
  the provider response, so a dropped header degrades quietly either way.
- **State is keyed per session id**, because one pi process can host several concurrent
  sessions (in-process subagents). A module-global counter would mix them. It is also
  in-memory, so `callSeq` restarts after a reload, restart, or resume.

## Install

Pi loads extensions from the user or project extensions directory — direct `.ts`/`.js`
files, or subdirectories with an `index.ts`/`index.js` entry point.

```sh
ln -s ~/projects/pi-extensions/pi-session-correlation ~/.pi/agent/extensions/pi-session-correlation
```

Or add the package to `packages` in `~/.pi/agent/settings.json`. Then `/model` (or a
restart) to reload.

## Verify

Point a request at something that echoes headers, or check the proxy log:

```sh
# expect: x-pi-session-id, x-pi-harness present; parent-session-id only on forked sessions
```
