# pi-session-correlation

Stamps session-correlation headers onto every model request pi sends, so a
fronting proxy (loopia) can attribute a call to its session, turn, and parent
session **without re-deriving them from prompt text**.

Companion RFC: `loopia/docs/rfcs/session-correlation-headers.md`. **Header names here
are provisional until that RFC's wire contract lands.** The contract now assigns exactly
one canonical name per field and resolves any same-name collision **on the client** — the
proxy can only see the final value, so this extension is where collisions get decided.

## Why this exists

The proxy sees one HTTP request per model call and no session identity — pi sends
none today. Session grouping currently has to be *inferred*, and exact prefix-tree
chaining measurably fails (7 of 905 calls linked on a sampled day) because dynamic
blocks — task-list reminders, timestamps — are re-rendered into the prompt between
calls and break byte-stable prefixes.

Some of this pi can already emit: for `openai-responses` models it sets
`session_id` / `x-client-request-id` from `options.sessionId` on every request, and
`models.json` `compat` can turn the same on for `openai-completions`.

**This extension is strictly necessary only for `x-pi-parent-state`,
`x-pi-parent-session-id`, and `x-pi-run-id`** — the values that exist nowhere else on the
wire. `session-id` also reaches the proxy through the `models.json` session-affinity path,
though the RFC has that alias **disabled until independent attribution exists**; turn
boundaries, cwd, and message counts are all derivable from the request body the proxy
already receives. If this extension stops loading, the parent columns and the run key go
dark while session grouping survives via `x-pi-session-id`. Worth knowing before anything
treats them as guaranteed.

## Headers emitted

| Header | Source | Notes |
|---|---|---|
| `x-pi-session-id` | `sessionManager.getSessionId()` | matches the id in the session file name |
| `x-pi-turn-id` | `<session-id>:<run-id>:<turn-index>` | run-scoped, and the run id is what keeps it join-safe across reloads and resumes. **The proxy stores this opaque and does not parse it** — see caveat below |
| `x-pi-run-id` | per-process nonce (**UUIDv4**, via `randomUUID()`), minted at extension load | **extension-only**; a reload re-imports the module and mints a new one |
| `x-pi-turn-index` | `turn_start.turnIndex` | |
| `x-pi-call-seq` | per-session counter | **advisory** — resets on extension reload, restart, or resume. The RFC dropped it as a persisted field (ordering is recoverable from `timestamp` + `requestId`); still emitted, nothing consumes it yet |
| `x-pi-parent-state` | session header `parentSession` | **`root` or `child`, sent on every request** — absence means "no contract", so state is never inferred from a missing header |
| `x-pi-parent-session-id` | session header `parentSession` | id recovered from the parent path; **sent for children only** |
| `x-pi-cwd` | `ctx.cwd` / `sessionManager.getCwd()` | sent now, **not persisted yet** — `projectSlug` is a deferred follow-up in the RFC |
| `x-pi-session-name` | `sessionManager.getSessionName()` | same — sent, persistence deferred |
| `x-pi-harness` | constant `pi` | **a declaration, not a proof** — the proxy records what the client asserted; it cannot independently verify the sender |

Existing header keys are never overwritten, so an explicit `models.json` header still
wins.

## Caveats worth knowing before you build on these

- **The compound turn key is a client convention, and the consistency check is ours, not the proxy's.** The proxy stores `x-pi-turn-id` verbatim and never parses it — it validates `x-pi-session-id` and `x-pi-run-id` independently, and cannot detect a disagreement with the components embedded here. This extension mints all three from the same values (`sessionId`, the module-level `RUN_ID`, and the per-session `turnIndex`), so within it they agree by construction. If the key ever needs to be machine-read downstream, version the format first.
- **`turnIndex` is pi turns, not human messages.** One assistant response that issues
  tool calls starts another turn. The run id makes the key unique per run, but it does not
  change the granularity — if you need "one human message", that is a different grain and a
  separate column on the proxy side.
- **Do not infer parent state from a missing id.** `x-pi-parent-state` is sent on every
  request precisely so that "root", "no contract", and "header lost" stay distinguishable.
  A `child` always carries an id; if it cannot, the consumer demotes it to `unknown` rather
  than inventing one.
- **Unrepresentable values are not sent.** Beyond the 200-char cap, or containing
  non-visible-ASCII, the field is omitted and reads null on the proxy side — hashing
  oversized values is deferred along with `projectSlug`. Handler failures do not change the
  provider response either, so a dropped header degrades quietly; that is what the RFC's
  coverage signal is for.
- **State is keyed per session id**, because one pi process can host several concurrent
  sessions (in-process subagents). A module-global counter would mix them. It is also
  in-memory, so `callSeq` restarts after a reload, restart, or resume.

## Install

From npm, once published:

```sh
pi install npm:@lexiupon/pi-session-correlation
```

From git — this works because the package root is the repository root and the extension is
declared under `pi.extensions`:

```sh
pi install git:github.com/lexiupon/pi-session-correlation
```

Or link this checkout into the user extensions directory:

```sh
ln -s ~/projects2/pi-session-correlation ~/.pi/agent/extensions/pi-session-correlation
```

Then `/model` (or a restart) to reload.

## Verify

Point a request at something that echoes headers, or check the proxy log:

```sh
# expect on every request: x-pi-session-id, x-pi-harness, x-pi-parent-state (root|child)
# expect on children only:  x-pi-parent-session-id
# sent but not yet persisted: x-pi-cwd, x-pi-session-name, x-pi-call-seq
```
