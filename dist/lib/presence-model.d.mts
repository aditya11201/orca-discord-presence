/**
 * Pure state model: Orca events in, a Discord activity payload out.
 *
 * Kept free of IPC and of the `orca` host API so the interesting parts — what
 * counts as "working", what leaks at each privacy level, how a payload degrades
 * when a field is missing — are testable without a Discord client or a running
 * Orca.
 *
 * Event payloads arrive as `unknown` even though the host validates them with
 * zod before delivery. The host's guarantee is worth trusting for shape, not
 * for this plugin's own storage round-trip, and one validation path is simpler
 * to reason about than two.
 */
import type { DiscordActivity } from './discord-ipc.mjs';
import type { AgentStatusState, WorkspaceContext } from './orca-api.mjs';
/** Orca's agent states, from `AGENT_STATUS_STATES` in the host. */
export declare const AGENT_STATES: readonly AgentStatusState[];
export declare const PRIVACY_LEVELS: readonly ['full', 'minimal', 'off'];
export type PrivacyLevel = (typeof PRIVACY_LEVELS)[number];
/**
 * Default is `minimal`, not `full`. Branch names routinely carry ticket ids and
 * client names, and a status that silently published them the moment the plugin
 * was enabled would be a bad default even though it is the more interesting one.
 */
export declare const DEFAULT_PRIVACY: PrivacyLevel;
export declare const WORKING_LABEL_INTERVAL_MS = 30000;
/**
 * Leading segment of the details line — the closest thing to a card "header"
 * this plugin controls. Discord renders the application's own name above it and
 * that name cannot be set over IPC, so the header lives in `details` instead.
 * Set the setting to `""` to drop the segment entirely.
 */
export declare const DEFAULT_HEADER = "{agent}";
/**
 * What the **Set Header** command cycles through when the host hands it no
 * argument. Ends on `''` — hiding the header entirely is a real choice, and a
 * cycle that cannot reach it would force a trip to the settings file.
 */
export declare const HEADER_PRESETS: readonly string[];
/**
 * Default logo. This is a URL rather than an asset key because the shipped
 * application hosts no artwork: publishing the key `orca` renders Discord's
 * missing-asset placeholder (a question mark), which is what a fresh install
 * showed before this default moved. An `https://` image is proxied by Discord
 * once and cached, so it costs no per-publish request.
 *
 * Point `clientId` at your own application and `largeImage` back at an asset key
 * you uploaded, if you prefer that.
 */
export declare const DEFAULT_LARGE_IMAGE = "https://raw.githubusercontent.com/stablyai/orca/main/resources/app-icons/orca-blue.png";
export declare const DEFAULT_LARGE_TEXT = "Orca";
/**
 * Pane statuses older than this are dropped. The worker is reaped after 5
 * minutes idle and rehydrates from storage on the next event, so without a TTL
 * a fleet that was busy yesterday would still read as busy today.
 */
export declare const STALE_STATUS_MS: number;
export type WorktreeRecord = {
    path: string;
    branch: string;
};
/**
 * `agent` is not carried by the plugin event stream; it is joined in from the
 * host's persisted agent rows (`agent-identity.mts`) and survives a worker reap
 * through storage.
 */
export type PaneRecord = {
    worktreeId: string | null;
    state: AgentStatusState;
    receivedAt: number;
    agent?: string;
};
export type PresenceState = {
    worktrees: Map<string, WorktreeRecord>;
    panes: Map<string, PaneRecord>;
};
export type PresenceSummary = {
    working: number;
    blocked: number;
    waiting: number;
    done: number;
    panes: number;
    worktrees: number;
    activeWorktrees: number;
    /** Ids of the worktrees with a working agent, sorted so payloads stay stable. */
    activeWorktreeIds: string[];
};
/** Pane whose agent ran most recently; drives the dynamic logo. */
export type LatestAgent = {
    paneKey: string;
    agent: string;
    receivedAt: number;
};
export declare function createPresenceState(): PresenceState;
export declare function applyWorktreeCreated(state: PresenceState, payload: unknown): PresenceState;
export declare function applyWorktreeRemoved(state: PresenceState, payload: unknown): PresenceState;
export declare function applyAgentStatus(state: PresenceState, payload: unknown): PresenceState;
/**
 * Joins host-persisted agent identities onto the panes already tracked.
 * Identities for unknown panes are ignored: adopting them would inflate the
 * fleet counts with panes Orca never projected to this plugin.
 */
export declare function applyAgentIdentities(state: PresenceState, identities: ReadonlyMap<string, {
    agent: string;
    receivedAt: number;
}>): PresenceState;
export declare function pruneStale(state: PresenceState, now: number): PresenceState;
/** Storage holds JSON, so Maps round-trip through plain objects. */
export declare function serializeState(state: PresenceState): {
    worktrees: Record<string, WorktreeRecord>;
    panes: Record<string, PaneRecord>;
};
export declare function deserializeState(raw: unknown): PresenceState;
/**
 * The pane whose agent ran most recently, among the panes Orca has given an
 * identity to. This is what drives the dynamic logo: finish prompting in OMP,
 * start a session in OpenCode, and the logo follows OpenCode.
 *
 * Ties and zero timestamps resolve by pane key so the choice is deterministic
 * across worker restarts — an unstable payload would republish for nothing.
 */
export declare function latestAgent(state: PresenceState): LatestAgent | null;
export declare function summarize(state: PresenceState): PresenceSummary;
/**
 * Names of the workspaces (worktrees) that currently have a working agent.
 *
 * Only worktrees seen through `worktree.created` can be named — one that
 * existed before the plugin was installed is known by id alone, so the list
 * comes back short and `describeActivity` falls back to counting.
 */
export declare function describeWorkspaces(state: PresenceState, summary?: PresenceSummary): string[];
/**
 * The status line: a display-only working label followed by the fleet counts.
 *
 * `blocked` and `waiting` are separate segments even though Orca renders both
 * as its `permission` status — the distinction is free here and tells a reader
 * whether the fleet is stuck or merely asking.
 *
 * `workspaces` names the worktrees the working agents sit in. It is passed only
 * at `full` privacy — at `minimal` the trailing segment stays a bare count, so
 * the shape of the fleet still shows without leaking what it is working on.
 */
export declare function describeActivity(summary: PresenceSummary, workspaces?: readonly string[], elapsedMs?: number): string;
/**
 * Project label from whatever the host gave us. `workspace.readContext` returns
 * a display name for the focused worktree; a worktree seen only through
 * `worktree.created` has just a path, whose basename is the best available name.
 */
export declare function describeProject(focus: WorkspaceContext, state: PresenceState): string;
export type HeaderContext = {
    focus: WorkspaceContext;
    state: PresenceState;
    privacy: PrivacyLevel;
};
/**
 * Expands a header template. `{workspace}` and `{branch}` resolve only at
 * `full`; at `minimal` they blank out, and a template left with nothing but
 * blanks falls back to AI Agent. `{agent}` uses the same latest pane as the logo,
 * including at `minimal` privacy and when agent artwork is disabled.
 *
 * Segments are split on `·` so that a token dropping out takes its separator
 * with it, so `{workspace} · {branch}` never reads as `· `.
 */
export declare function renderHeader(template: string, { focus, state, privacy }: HeaderContext): string;
/**
 * Next template in the cycle. A header the user typed by hand is not in the
 * list, so cycling from it starts the presets over from the top.
 */
export declare function nextHeader(current: string): string;
export type PresenceAssets = {
    largeImage?: string | undefined;
    largeText?: string | undefined;
    /** Badge in the corner of the logo. Off by default: the shipped application
     *  hosts no artwork under any other key, so a default would render blank. */
    smallImage?: string | undefined;
    smallText?: string | undefined;
};
export type BuildActivityInput = {
    state: PresenceState;
    focus: WorkspaceContext;
    privacy: PrivacyLevel;
    startedAt?: number;
    /** Milliseconds in the current busy window; controls the display-only label. */
    elapsedMs?: number;
    /** Leading segment of the details line; `undefined` takes `DEFAULT_HEADER`. */
    header?: string | undefined;
    assets?: PresenceAssets | undefined;
    /**
     * Logo for the agent that ran most recently, when the dynamic logo is on.
     * Resolved by the caller (which knows the settings); `undefined` publishes
     * the configured `largeImage` instead.
     */
    agentImage?: {
        key: string;
        text?: string;
    } | undefined;
    /** Opaque party id; omitted, Discord may not render the party size at all. */
    partyId?: string | undefined;
};
/**
 * Builds the payload handed to SET_ACTIVITY. Returns `null` when nothing should
 * be published — the caller clears the status rather than sending an empty one.
 *
 * The card reads top to bottom as:
 *
 *   OpenCode 2 · my-app · feat/ipc        ← details: agent, workspace, branch
 *   Vibing · 2 agents working · in my-app ← state: working label and fleet
 *
 * `startedAt` drives Discord's elapsed timer; it is the moment the fleet last
 * went from idle to busy, not process start, so the timer reads as "how long
 * this batch of work has been running".
 */
export declare function buildActivity({ state, focus, privacy, startedAt, elapsedMs, header, assets, agentImage, partyId }: BuildActivityInput): DiscordActivity | null;
export declare function isPrivacyLevel(value: unknown): value is PrivacyLevel;
export declare function nextPrivacy(current: PrivacyLevel): PrivacyLevel;
/**
 * True when the fleet has any agent that is not finished.
 *
 * `waiting` counts: Orca maps both `blocked` and `waiting` onto its
 * `permission` status — "agent needs user attention" — so a fleet sitting on a
 * permission prompt is not idle, and the elapsed timer should keep running.
 */
export declare function isBusy(summary: PresenceSummary): boolean;
/** Agents the fleet still owes work on — the `current` half of the party size. */
export declare function busyCount(summary: PresenceSummary): number;
