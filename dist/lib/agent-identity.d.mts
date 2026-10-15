/**
 * Which agent runs in which pane.
 *
 * Orca's plugin events are a deliberately bounded four-field projection
 * (`worktreeId`, `paneKey`, `state`, `receivedAt`) and drop agent identity, so
 * the event stream cannot answer "which agent is this?". The host does persist
 * it: every hook event writes a row to
 * `<userData>/agent-hooks/last-status.json`, keyed by pane key, carrying the
 * agent id in `payload.agentType` with `source` and `agentPresence.agent` as
 * fallbacks. That file is the identity source this module reads.
 *
 * Reading it is a local file read, and no capability in Orca's v0 closed set
 * covers "read the host's own state directory" — the worker is plain Node, so
 * it can. That is the fragile part of this feature: the file is a host
 * implementation detail, not a contract. It is read defensively (absent,
 * unreadable, oversized, or reshaped all degrade to "no identity known" rather
 * than to an error), and every path is overridable through `agentStateDir`.
 *
 * Privacy: only the agent id is extracted. `payload.prompt`,
 * `payload.lastAssistantMessage`, terminal handles and remotes are never
 * copied, logged or published.
 */
/** Directory under userData holding the persisted agent status rows. */
export declare const AGENT_STATE_DIR_NAME = "agent-hooks";
/** File under that directory holding one row per pane key. */
export declare const AGENT_STATE_FILE_NAME = "last-status.json";
/**
 * The real file carries prompts and last assistant messages, so it grows with
 * the fleet; a cap keeps a pathological host file from stalling the worker.
 */
export declare const AGENT_STATE_MAX_BYTES: number;
/** Rows beyond this are ignored; Orca panes are far fewer. */
export declare const AGENT_ENTRY_LIMIT = 512;
/** Agent id as Orca reports it, per pane key. */
export type AgentIdentity = {
    agent: string;
    receivedAt: number;
};
/**
 * Where `<userData>` lives, per platform. Deliberately derived from the worker
 * environment allowlist (HOME, USERPROFILE) rather than electron's app paths:
 * a plugin worker has neither `app.getPath` nor `APPDATA`/`XDG_CONFIG_HOME`
 * guaranteed, but it does have HOME and USERPROFILE, and the XDG default
 * (`~/.config`) needs nothing else.
 */
export declare function resolveUserDataDir(platform?: NodeJS.Platform, env?: NodeJS.ProcessEnv, override?: unknown): string | null;
/** Absolute path of the persisted agent status file. */
export declare function resolveAgentStateFile(agentStateDir?: unknown): string | null;
export type ReadAgentIdentitiesOptions = {
    /** Directory holding `agent-hooks/`. Defaults to the resolved userData dir. */
    agentStateDir?: unknown;
    maxBytes?: number;
    maxEntries?: number;
    readFile?: (path: string) => string;
    exists?: (path: string) => boolean;
    sizeOf?: (path: string) => {
        size: number;
    };
};
/**
 * paneKey → agent identity, for the panes Orca has a persisted row for.
 *
 * Every failure mode returns an empty map: the file being absent is the normal
 * state before the first agent runs, and a host that reshapes or drops it must
 * not take the presence down with it.
 */
export declare function readAgentIdentities(options?: ReadAgentIdentitiesOptions): Map<string, AgentIdentity>;
/**
 * Artwork for the agents this plugin can name without configuration. Every URL
 * is checked to respond with an image content type before being shipped here;
 * Discord proxies each one once and caches it, so publishing costs no request.
 *
 * `omp` points at the project's own site. Orca ships no logo for it, and the
 * site's OG image is the only public artwork, so `agentImages` is the knob for
 * a cleaner one.
 */
export declare const DEFAULT_AGENT_IMAGE_SOURCES: Readonly<Record<string, string>>;
export declare function describeAgent(agent: string): string;
export type ResolveAgentImageInput = {
    agentImages?: Record<string, unknown> | undefined;
    /** Asset key to fall back to when the agent has no artwork of its own. */
    fallbackImage?: string | undefined;
};
/**
 * Artwork for one agent. A per-agent override wins over the built-in source,
 * and an unmapped agent keeps `fallbackImage` — a missing asset key would
 * publish an empty square, which is worse than the Orca logo.
 */
export declare function resolveAgentImage(agent: string, { agentImages, fallbackImage }: ResolveAgentImageInput): {
    key: string;
    text: string;
};
/** Reads a `{ "<agent>": "<asset key or https url>" }` settings object. */
export declare function readAgentImages(configured: unknown): Record<string, string>;
