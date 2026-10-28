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
 * Existing keys win: an explicit models.json header is a deliberate override, and
 * the proxy can no longer tell the two apart, so collisions are resolved here.
 * `ProviderHeaders` is `Record<string, string | null>`, where null means delete.
 *
 * A value that cannot be represented is NOT sent — per the RFC, the field reads null
 * on the proxy side and the request counts as header-absent for coverage. Hashing
 * oversized values is deferred along with `projectSlug`.
 */
function put(headers: ProviderHeaders, name: string, value: string | undefined | null): void {
  if (!value) return;
  if (name.length + value.length > MAX_VALUE_LEN) return;
  if (UNSAFE_VALUE_RE.test(value)) return;
  if (headers[name] !== undefined) return;
  headers[name] = value;
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

    // Run-scoped: pi's turn counter restarts on reload and on resume, so this value
    // is only stable within a process run. The RFC prefers a session-entry-id key
    // once that is confirmed workable; until then this is the counter form.
    if (entry) {
      put(headers, `${PREFIX}-turn-id`, `${sessionId}:${entry.turnIndex}`);
      put(headers, `${PREFIX}-turn-index`, String(entry.turnIndex));
      put(headers, `${PREFIX}-call-seq`, String(entry.callSeq));
    }

    // Lineage. pi records parentSession on the session header for forked and spawned
    // sessions. State is sent explicitly on every request, so absence of the header
    // means "no contract" rather than being overloaded onto root/child, and a child
    // always carries an id.
    const parentSession = sm.getHeader?.()?.parentSession;
    const parentSessionId = sessionIdFromPath(parentSession);
    put(headers, `${PREFIX}-parent-state`, parentSession ? "child" : "root");
    if (parentSessionId) put(headers, `${PREFIX}-parent-session-id`, parentSessionId);

    // Deferred by the RFC (projectSlug follow-up): sent now, not persisted yet.
    put(headers, `${PREFIX}-cwd`, ctx.cwd || sm.getCwd?.());
    put(headers, `${PREFIX}-session-name`, sm.getSessionName?.());
  });
}
