/**
 * pi-session-correlation
 *
 * Stamps session-correlation headers onto every model request so a fronting
 * proxy can attribute a call to its session, turn, and parent session without
 * re-deriving them from prompt text.
 *
 * Companion RFC: loopia docs/rfcs/session-correlation-headers.md
 *
 * Design constraints:
 * - No I/O in the hot path. Handlers are awaited in stream order, so anything
 *   blocking here delays the model request. All values here come from the
 *   in-memory session manager.
 * - State is keyed by session id, never module-global: one pi process can host
 *   several concurrent sessions (in-process subagents), and a single global
 *   counter would mix them.
 * - Headers are advisory. Handler failures do not change the provider response,
 *   so a value that cannot be represented is skipped rather than guessed.
 */

import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ProviderHeaders } from "@earendil-works/pi-ai";

const PREFIX = "x-pi";

/** HTTP header values must stay within visible ASCII. */
const UNSAFE_VALUE_RE = /[^\x21-\x7e]/;
const MAX_VALUE_LEN = 200;

/**
 * Per-session counters. Keyed by session id rather than held in a module global
 * so concurrent sessions in one process cannot corrupt each other.
 *
 * BEST EFFORT. State lives in this process and a reload clears it: `/model`
 * reloads extensions, and a session resumed or forked into a new process starts
 * its counter again. Treat `x-pi-call-seq` as ordering within one process run,
 * not as a durable sequence.
 */
const state = new Map<string, { turnIndex: number; callSeq: number }>();

function setState(sessionId: string): { turnIndex: number; callSeq: number } | undefined {
  if (!sessionId) return undefined;
  let entry = state.get(sessionId);
  if (!entry) {
    entry = { turnIndex: 0, callSeq: 0 };
    state.set(sessionId, entry);
  }
  return entry;
}

/**
 * Set a header if the value is present, representable, and not already set.
 * Existing keys win: an explicit models.json header is a deliberate override.
 * `ProviderHeaders` is `Record<string, string | null>`, where null means delete.
 */
function put(headers: ProviderHeaders, name: string, value: string | undefined | null): void {
  if (!value) return;
  if (name.length + value.length > MAX_VALUE_LEN) return;
  if (UNSAFE_VALUE_RE.test(value)) return;
  if (headers[name] !== undefined) return;
  headers[name] = value;
}

/**
 * Like `put`, but an oversized value becomes a stable hash instead of disappearing.
 * Used for the project dimension, where dropping it is the worst option: absence
 * already carries meaning elsewhere in this schema, so a silently missing cwd is
 * indistinguishable from "not applicable". Hash the raw value so the dimension
 * stays joinable even when it is no longer human-readable.
 */
function putStable(headers: ProviderHeaders, name: string, value: string | undefined | null): void {
  if (!value) return;
  if (headers[name] !== undefined) return;
  if (value.length <= MAX_VALUE_LEN && !UNSAFE_VALUE_RE.test(value)) {
    headers[name] = value;
    return;
  }
  headers[name] = createHash("sha256").update(value).digest("hex").slice(0, 16);
}

/**
 * Session ids live in the file name as `<timestamp>_<session-id>.jsonl`, so the
 * parent session id can be recovered from the parent path without putting a long
 * filesystem path on the wire.
 */
function sessionIdFromPath(sessionPath: string | undefined): string | undefined {
  if (!sessionPath) return undefined;
  const stem = (sessionPath.split("/").pop() ?? sessionPath).replace(/\.jsonl$/, "");
  const sep = stem.lastIndexOf("_");
  return sep >= 0 ? stem.slice(sep + 1) : stem;
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    state.delete(ctx.sessionManager.getSessionId());
  });

  pi.on("turn_start", (event, ctx) => {
    const entry = setState(ctx.sessionManager.getSessionId());
    if (!entry) return;
    entry.turnIndex = event.turnIndex;
    entry.callSeq = 0;
  });

  pi.on("before_provider_headers", (event, ctx) => {
    const headers = event.headers;
    const sm = ctx.sessionManager;

    const sessionId = sm.getSessionId();
    if (!sessionId) return;

    const entry = setState(sessionId);
    if (entry) entry.callSeq += 1;

    put(headers, `${PREFIX}-session-id`, sessionId);
    put(headers, `${PREFIX}-harness`, "pi");

    if (entry) {
      put(headers, `${PREFIX}-turn-id`, `${sessionId}:${entry.turnIndex}`);
      put(headers, `${PREFIX}-turn-index`, String(entry.turnIndex));
      put(headers, `${PREFIX}-call-seq`, String(entry.callSeq));
    }

    // Lineage. pi records parentSession on the session header for forked and
    // spawned sessions; a root session legitimately has none, so absence is
    // meaningful and is left unset rather than written as an empty value.
    const parentSession = sm.getHeader?.()?.parentSession;
    put(headers, `${PREFIX}-parent-session-id`, sessionIdFromPath(parentSession));

    // Project attribution. Hashed rather than dropped when a path is too long for
    // a header value — deep worktree paths are exactly the ones that matter.
    putStable(headers, `${PREFIX}-cwd`, ctx.cwd || sm.getCwd?.());
    putStable(headers, `${PREFIX}-session-name`, sm.getSessionName?.());
  });
}
