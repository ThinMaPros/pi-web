// local: passive request capture for the Context panel. Reproduces pi-context-view's
// real-turn capture (its src/index.ts `before_agent_start` + `context` handlers and
// capture.ts InitialCaptureState; MIT, Dmitry Makarov) as a hidden inline extension, so
// the panel can show the Initial injections snapshot and count request-only extension
// messages in Usage. Read-only: handlers never change the prompt or messages, never
// write to the session and never start a model request (no silent probe).
//
// Captures live in memory only, per session, for this server run.
import {
  buildSessionContext,
  type BuildSystemPromptOptions,
  type ContextEvent,
  type ExtensionAPI,
  type InlineExtension,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
  type CaptureFinalization,
  collectPromptSources,
  InitialCaptureState,
  parsePersistedIdentities,
  PROBE_IDENTITIES_CUSTOM_TYPE,
  SilentProbeState,
} from "./context-view/capture";
import type { InitialSnapshot } from "./context-view/model";

export const LOCAL_CONTEXT_CAPTURE_EXTENSION_NAME = "pi-web-local-context-capture";

type CaptureSessionManager = {
  getSessionId(): string;
  getEntries(): readonly unknown[];
  getLeafId(): string | null;
};

interface PendingRun {
  readonly options: BuildSystemPromptOptions;
  readonly prompt: string;
}

interface LatestRequest {
  readonly capturedAt: Date;
  readonly build: () => InitialSnapshot | undefined;
  snapshot?: InitialSnapshot;
}

interface CaptureRecord {
  readonly sessionId: string;
  /** First observed request of this server run, frozen (upstream's Initial snapshot). */
  readonly initial: InitialCaptureState;
  pendingRun?: PendingRun;
  /** Most recent request, measured lazily on read (the baseline rebuild is O(session)). */
  latest?: LatestRequest;
}

/** Keyed by the live SessionManager; a record whose session id no longer matches is stale. */
const registry = new WeakMap<object, CaptureRecord>();

function recordFor(manager: CaptureSessionManager): CaptureRecord {
  const sessionId = manager.getSessionId();
  const existing = registry.get(manager);
  if (existing && existing.sessionId === sessionId) return existing;
  const record: CaptureRecord = { sessionId, initial: new InitialCaptureState() };
  registry.set(manager, record);
  return record;
}

export interface LocalContextCapture {
  /** Frozen first request of this run (what the Injections view shows). */
  readonly initial?: InitialSnapshot;
  /** Latest request, used by Usage to count request-only extension messages. */
  readonly latest?: InitialSnapshot;
  readonly latestAt?: Date;
}

/** Read the capture for a session without creating one. */
export function readLocalContextCapture(manager: CaptureSessionManager): LocalContextCapture | undefined {
  const record = registry.get(manager);
  if (!record || record.sessionId !== manager.getSessionId()) return undefined;
  const initial = record.initial.snapshot;
  const latest = record.latest;
  if (latest && latest.snapshot === undefined) {
    try {
      latest.snapshot = latest.build();
    } catch {
      // A stale or disposed session leaves Usage on the native snapshot.
    }
  }
  if (!initial && !latest?.snapshot) return undefined;
  return { initial, latest: latest?.snapshot, latestAt: latest?.capturedAt };
}

/** Session-branch messages as of `leafId`, minus pi-context-view silent-probe messages. */
export function branchMessages(manager: CaptureSessionManager, leafId: string | null): ContextEvent["messages"] {
  const entries = manager.getEntries() as SessionEntry[];
  const probe = new SilentProbeState();
  for (const entry of entries) {
    if (entry.type === "custom" && entry.customType === PROBE_IDENTITIES_CUSTOM_TYPE) {
      probe.restoreIdentities(parsePersistedIdentities(entry.data));
    }
  }
  return probe.filterMessages(buildSessionContext(entries, leafId).messages);
}

/** Own the parts of the shared, mutable options object that measurement reads. */
function copyOptions(options: BuildSystemPromptOptions): BuildSystemPromptOptions {
  return {
    ...options,
    sections: options.sections ? { ...options.sections } : undefined,
    toolSnippets: options.toolSnippets ? { ...options.toolSnippets } : undefined,
    contextFiles: options.contextFiles?.map((file) => ({ ...file })),
    skills: options.skills?.map((skill) => ({ ...skill })),
  };
}

/** Test/extension entry point: register the passive handlers on `pi`. */
export function registerLocalContextCapture(pi: ExtensionAPI): void {
  pi.on("before_agent_start", (event, ctx) => {
    try {
      const record = recordFor(ctx.sessionManager);
      // Inline extensions load after file extensions, so this is the fully chained
      // prompt: every extension's before_agent_start edit is already in it.
      const options = copyOptions(event.systemPromptOptions);
      const prompt = event.systemPrompt;
      record.pendingRun = { options, prompt };
      record.initial.prepare(options, prompt);
    } catch {
      // Capture is best-effort; never disturb the run.
    }
    return undefined;
  });

  pi.on("context", (event, ctx) => {
    try {
      const manager = ctx.sessionManager;
      const record = recordFor(manager);
      const run = record.pendingRun;
      if (!run) return undefined;
      const messages = event.messages.slice();
      const leafId = manager.getLeafId();
      const systemPrompt = ctx.getSystemPrompt();
      const allTools = pi.getAllTools();
      const activeToolNames = pi.getActiveTools();
      const promptSources = collectPromptSources(allTools, pi.getCommands());
      const capturedAt = new Date();
      let baseline: ContextEvent["messages"] | undefined;
      const input = (): CaptureFinalization => ({
        systemPrompt,
        messages,
        baselineMessages: (baseline ??= branchMessages(manager, leafId)),
        allTools,
        activeToolNames,
        promptSources,
        origin: "real-turn",
        capturedAt,
      });
      // Freezes on the first request only, as upstream; later calls are no-ops.
      record.initial.finalize(input);
      record.latest = {
        capturedAt,
        build: () => {
          const state = new InitialCaptureState();
          state.prepare(run.options, run.prompt);
          return state.finalize(input);
        },
      };
    } catch {
      // Capture is best-effort; never disturb the request.
    }
    return undefined;
  });
}

export function createLocalContextCaptureExtension(): InlineExtension {
  return {
    name: LOCAL_CONTEXT_CAPTURE_EXTENSION_NAME,
    hidden: true,
    factory: registerLocalContextCapture,
  };
}
