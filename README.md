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
`models.json` `compat` can turn the same on for `openai-completions`. This extension
covers the rest, which are only reachable from pi's in-process session state.

## Headers emitted

| Header | Source | Notes |
|---|---|---|
| `x-pi-session-id` | `sessionManager.getSessionId()` | matches the id in the session file name |
| `x-pi-turn-id` | `<session-id>:<turnIndex>` | **tool-loop granularity** — see caveat below |
| `x-pi-turn-index` | `turn_start.turnIndex` | |
| `x-pi-call-seq` | per-session counter | monotonic as observed by this extension; not a retry counter |
| `x-pi-parent-session-id` | session header `parentSession` | id recovered from the parent path; absent for root sessions |
| `x-pi-cwd` | `ctx.cwd` / `sessionManager.getCwd()` | the project dimension |
| `x-pi-session-name` | `sessionManager.getSessionName()` | set via `/name` / `--name`; absent otherwise |
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
- **Values that cannot be represented are skipped**, not guessed: non-visible-ASCII, or
  name+value beyond 200 chars. Handler failures do not change the provider response, so
  a dropped header degrades quietly.
- **State is keyed per session id**, because one pi process can host several concurrent
  sessions (in-process subagents). A module-global counter would mix them.

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
