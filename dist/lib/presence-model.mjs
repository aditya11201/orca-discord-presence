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
import { basename } from 'node:path';
import { describeAgent } from './agent-identity.mjs';
/** Orca's agent states, from `AGENT_STATUS_STATES` in the host. */
export const AGENT_STATES = ['working', 'blocked', 'waiting', 'done'];
export const PRIVACY_LEVELS = ['full', 'minimal', 'off'];
/**
 * Default is `minimal`, not `full`. Branch names routinely carry ticket ids and
 * client names, and a status that silently published them the moment the plugin
 * was enabled would be a bad default even though it is the more interesting one.
 */
export const DEFAULT_PRIVACY = 'minimal';
export const WORKING_LABEL_INTERVAL_MS = 15_000;
const WORKING_LABELS = [
    'Vibing', 'Just vibing', 'In the flow',
    'Catastrophizing', 'Overthinking', 'Worrying',
    'Thinking about mistakes of the past', 'Rehearsing past conversations',
    'Dooming', 'Ruminating', 'Doubting', 'Anticipating with fear', 'Panicking',
    'Spiraling', 'Second-guessing', 'Fretting', 'Dreading', 'Overanalyzing',
    'Bracing for the worst', 'Assuming the worst', 'Running worst-case scenarios',
    'Triple-checking', 'Replaying that one awkward moment', 'Rereading the sent message',
    'Drafting apologies just in case', 'Apologizing preemptively', 'Overexplaining',
    'Reading too much into "ok"', 'Wondering if the user is mad', 'Refreshing for a reply',
    'Lying awake over a typo', 'Worrying about the context window', 'Doubting the diff',
    'Hoping it compiles', 'Bracing for code review', 'Fearing the red squiggles',
    'Nail-biting', 'Pacing'
];
/**
 * Leading segment of the details line — the closest thing to a card "header"
 * this plugin controls. Discord renders the application's own name above it and
 * that name cannot be set over IPC, so the header lives in `details` instead.
 * Set the setting to `""` to drop the segment entirely.
 */
export const DEFAULT_HEADER = '{agent}';
/**
 * A header is a template, not a literal, so that a header naming the workspace
 * still obeys the privacy level. Baking `checkout-service` into the setting
 * would keep publishing it after a drop to `minimal`; `{workspace}` blanks out
 * instead.
 */
const HEADER_TOKENS = /\{(workspace|branch|agent)\}/g;
/** Segment separator inside a header template, and between details segments. */
const SEGMENT_SEPARATOR = ' · ';
/**
 * What the **Set Header** command cycles through when the host hands it no
 * argument. Ends on `''` — hiding the header entirely is a real choice, and a
 * cycle that cannot reach it would force a trip to the settings file.
 */
export const HEADER_PRESETS = [
    DEFAULT_HEADER,
    '{workspace}',
    '{workspace} · {branch}',
    ''
];
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
export const DEFAULT_LARGE_IMAGE = 'https://raw.githubusercontent.com/stablyai/orca/main/resources/app-icons/orca-blue.png';
export const DEFAULT_LARGE_TEXT = 'Orca';
/** Shown at `minimal` when the header has been blanked out. */
const FALLBACK_DETAILS = 'Working in Orca';
/**
 * How many workspace names the status line lists before collapsing the rest
 * into `+N`. Three keeps the line readable on a Discord profile card.
 */
const MAX_WORKSPACE_NAMES = 3;
/** Discord rejects a details/state string shorter than 2 or longer than 128. */
const FIELD_MIN = 2;
const FIELD_MAX = 128;
/**
 * Pane statuses older than this are dropped. The worker is reaped after 5
 * minutes idle and rehydrates from storage on the next event, so without a TTL
 * a fleet that was busy yesterday would still read as busy today.
 */
export const STALE_STATUS_MS = 6 * 60 * 60 * 1000;
export function createPresenceState() {
    return { worktrees: new Map(), panes: new Map() };
}
function asRecord(value) {
    return typeof value === 'object' && value !== null ? value : null;
}
function asString(value) {
    return typeof value === 'string' ? value : '';
}
function isAgentState(value) {
    return typeof value === 'string' && AGENT_STATES.includes(value);
}
export function applyWorktreeCreated(state, payload) {
    const record = asRecord(payload);
    const worktreeId = asString(record?.['worktreeId']);
    if (!worktreeId) {
        return state;
    }
    state.worktrees.set(worktreeId, {
        path: asString(record?.['path']),
        branch: asString(record?.['branch'])
    });
    return state;
}
export function applyWorktreeRemoved(state, payload) {
    const record = asRecord(payload);
    const worktreeId = asString(record?.['worktreeId']);
    if (!worktreeId) {
        return state;
    }
    state.worktrees.delete(worktreeId);
    for (const [paneKey, pane] of state.panes) {
        if (pane.worktreeId === worktreeId) {
            state.panes.delete(paneKey);
        }
    }
    return state;
}
export function applyAgentStatus(state, payload) {
    const record = asRecord(payload);
    const paneKey = asString(record?.['paneKey']);
    const agentState = record?.['state'];
    if (!paneKey || !isAgentState(agentState)) {
        return state;
    }
    const worktreeId = record?.['worktreeId'];
    const receivedAt = record?.['receivedAt'];
    const previous = state.panes.get(paneKey);
    state.panes.set(paneKey, {
        worktreeId: typeof worktreeId === 'string' ? worktreeId : null,
        state: agentState,
        receivedAt: typeof receivedAt === 'number' ? receivedAt : 0,
        // Why: the event stream carries no agent identity, so a status update must
        // not clear one an earlier identity join filled in.
        ...(previous?.agent ? { agent: previous.agent } : {})
    });
    return state;
}
/**
 * Joins host-persisted agent identities onto the panes already tracked.
 * Identities for unknown panes are ignored: adopting them would inflate the
 * fleet counts with panes Orca never projected to this plugin.
 */
export function applyAgentIdentities(state, identities) {
    for (const [paneKey, pane] of state.panes) {
        const identity = identities.get(paneKey);
        const progress = pane.state === 'working' ? identity?.progress : undefined;
        if (!identity && !pane.progress)
            continue;
        const agent = identity?.agent ?? pane.agent;
        if (pane.agent === agent && pane.progress === progress)
            continue;
        state.panes.set(paneKey, { ...pane, ...(agent ? { agent } : {}), progress });
    }
    return state;
}
export function pruneStale(state, now) {
    for (const [paneKey, pane] of state.panes) {
        if (now - pane.receivedAt > STALE_STATUS_MS) {
            state.panes.delete(paneKey);
        }
    }
    return state;
}
/** Storage holds JSON, so Maps round-trip through plain objects. */
export function serializeState(state) {
    return {
        worktrees: Object.fromEntries(state.worktrees),
        panes: Object.fromEntries(state.panes)
    };
}
export function deserializeState(raw) {
    const state = createPresenceState();
    const root = asRecord(raw);
    if (!root) {
        return state;
    }
    for (const [id, value] of Object.entries(asRecord(root['worktrees']) ?? {})) {
        const record = asRecord(value);
        if (record) {
            state.worktrees.set(id, { path: asString(record['path']), branch: asString(record['branch']) });
        }
    }
    for (const [paneKey, value] of Object.entries(asRecord(root['panes']) ?? {})) {
        const record = asRecord(value);
        if (record && isAgentState(record['state'])) {
            const worktreeId = record['worktreeId'];
            const receivedAt = record['receivedAt'];
            const agent = record['agent'];
            state.panes.set(paneKey, {
                worktreeId: typeof worktreeId === 'string' ? worktreeId : null,
                state: record['state'],
                receivedAt: typeof receivedAt === 'number' ? receivedAt : 0,
                ...(typeof agent === 'string' && agent ? { agent } : {})
            });
        }
    }
    return state;
}
/**
 * Most recent identified agent, scoped to the focused workspace when provided.
 * Terminal ids identify the workspace first; a unique branch is the fallback.
 *
 * Ties and zero timestamps resolve by pane key so the choice is deterministic
 * across worker restarts — an unstable payload would republish for nothing.
 */
export function latestAgent(state, focus) {
    let worktreeIds;
    if (focus) {
        worktreeIds = new Set();
        if (focus.worktreeId)
            worktreeIds.add(focus.worktreeId);
        for (const [key, pane] of state.panes) {
            if (!focus.worktreeId && pane.worktreeId && focus.terminals?.some(({ id }) => key.split(':').includes(id))) {
                worktreeIds.add(pane.worktreeId);
            }
        }
        if (worktreeIds.size === 0) {
            const branch = focus.branch.trim().replace(/^refs\/heads\//, '');
            const matches = [...state.worktrees].filter(([, tree]) => branch ? tree.branch.replace(/^refs\/heads\//, '') === branch
                : basename(tree.path) === focus.displayName.trim());
            // ponytail: ambiguous branches stay unnamed; a host-provided worktree id would remove this limit.
            if (matches.length !== 1)
                return null;
            worktreeIds.add(matches[0][0]);
        }
    }
    let best = null;
    for (const [paneKey, pane] of state.panes) {
        if (!pane.agent || (worktreeIds && !worktreeIds.has(pane.worktreeId))) {
            continue;
        }
        const candidate = { paneKey, agent: pane.agent, receivedAt: pane.receivedAt };
        if (!best) {
            best = candidate;
            continue;
        }
        if (candidate.receivedAt > best.receivedAt) {
            best = candidate;
        }
        else if (candidate.receivedAt === best.receivedAt && candidate.paneKey < best.paneKey) {
            best = candidate;
        }
    }
    return best;
}
export function summarize(state) {
    const counts = { working: 0, blocked: 0, waiting: 0, done: 0 };
    const activeWorktrees = new Set();
    for (const pane of state.panes.values()) {
        counts[pane.state] += 1;
        if (pane.state === 'working' && pane.worktreeId) {
            activeWorktrees.add(pane.worktreeId);
        }
    }
    return {
        ...counts,
        panes: state.panes.size,
        worktrees: state.worktrees.size,
        activeWorktrees: activeWorktrees.size,
        // Sorted, not insertion-ordered: pane events arrive in whatever order the
        // fleet happens to emit them, and an unstable order would republish an
        // otherwise identical payload against the rate limit.
        activeWorktreeIds: [...activeWorktrees].sort()
    };
}
function plural(count, noun) {
    return `${count} ${noun}${count === 1 ? '' : 's'}`;
}
/**
 * Display name for a worktree. The path's basename is the directory an agent
 * actually works in, which is what a reader recognises; the branch is the
 * fallback for a worktree the host reported without a path.
 */
function worktreeName(record) {
    if (record?.path) {
        return basename(record.path);
    }
    return record?.branch.trim() ?? '';
}
/**
 * Names of the workspaces (worktrees) that currently have a working agent.
 *
 * Only worktrees seen through `worktree.created` can be named — one that
 * existed before the plugin was installed is known by id alone, so the list
 * comes back short and `describeActivity` falls back to counting.
 */
export function describeWorkspaces(state, summary = summarize(state)) {
    const names = [];
    for (const worktreeId of summary.activeWorktreeIds) {
        const name = worktreeName(state.worktrees.get(worktreeId));
        if (name) {
            names.push(name);
        }
    }
    return names;
}
function listNames(names) {
    if (names.length <= MAX_WORKSPACE_NAMES) {
        return names.join(', ');
    }
    const shown = names.slice(0, MAX_WORKSPACE_NAMES).join(', ');
    return `${shown} +${names.length - MAX_WORKSPACE_NAMES}`;
}
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
export function describeActivity(summary, workspaces = [], elapsedMs = 0) {
    const parts = [];
    if (summary.working > 0) {
        const phase = Math.floor(Math.max(0, elapsedMs) / WORKING_LABEL_INTERVAL_MS);
        parts.push(WORKING_LABELS[phase % WORKING_LABELS.length] ?? WORKING_LABELS[0], summary.activeWorktrees > 1
            ? `${plural(summary.working, 'agent')} from ${plural(summary.activeWorktrees, 'worktree')}`
            : `${plural(summary.working, 'agent')} working`);
    }
    if (summary.blocked > 0) {
        parts.push(`${summary.blocked} blocked`);
    }
    if (summary.waiting > 0) {
        parts.push(`${summary.waiting} waiting`);
    }
    if (parts.length === 0) {
        return summary.panes > 0 ? 'Fleet idle' : 'No agents running';
    }
    if (summary.working > 0 && summary.activeWorktrees <= 1) {
        if (workspaces.length > 0) {
            parts.push(`in ${listNames(workspaces)}`);
        }
    }
    return parts.join(SEGMENT_SEPARATOR);
}
/**
 * Project label from whatever the host gave us. `workspace.readContext` returns
 * a display name for the focused worktree; a worktree seen only through
 * `worktree.created` has just a path, whose basename is the best available name.
 */
export function describeProject(focus, state) {
    const displayName = focus?.displayName.trim();
    if (displayName) {
        return displayName;
    }
    const branch = focus?.branch.trim();
    for (const worktree of state.worktrees.values()) {
        if (branch && worktree.branch === branch && worktree.path) {
            return basename(worktree.path);
        }
    }
    const [first] = state.worktrees.values();
    return first?.path ? basename(first.path) : '';
}
/**
 * Expands a header template. `{workspace}` and `{branch}` resolve only at
 * `full`; at `minimal` they blank out. Templates rendered blank fall back to AI Agent,
 * except the default header shows Idle when no agents are running. `{agent}`
 * uses the same latest pane as the logo, regardless of artwork settings.
 *
 * Segments are split on `·` so that a token dropping out takes its separator
 * with it, so `{workspace} · {branch}` never reads as `· `.
 */
export function renderHeader(template, { focus, state, privacy }) {
    const trimmed = template.trim();
    if (!trimmed) {
        return '';
    }
    const named = privacy === 'full';
    const agent = trimmed.includes('{agent}') ? latestAgent(state, named ? focus : undefined) : null;
    const values = {
        workspace: named ? describeProject(focus, state) : '',
        branch: named ? (focus?.branch.trim() ?? '') : '',
        agent: agent ? describeAgent(agent.agent) : ''
    };
    const rendered = trimmed
        .split('·')
        .map((segment) => segment.replace(HEADER_TOKENS, (_, token) => values[token] ?? '').trim())
        .filter(Boolean)
        .join(SEGMENT_SEPARATOR);
    return rendered || (trimmed === DEFAULT_HEADER && state.panes.size === 0 ? 'Idle' : 'AI Agent');
}
/**
 * Next template in the cycle. A header the user typed by hand is not in the
 * list, so cycling from it starts the presets over from the top.
 */
export function nextHeader(current) {
    const index = HEADER_PRESETS.indexOf(current.trim());
    const next = index < 0 ? HEADER_PRESETS[0] : HEADER_PRESETS[(index + 1) % HEADER_PRESETS.length];
    return next ?? DEFAULT_HEADER;
}
function clampField(value) {
    const trimmed = value.trim();
    if (trimmed.length < FIELD_MIN) {
        return undefined;
    }
    return trimmed.length > FIELD_MAX
        ? `${trimmed.slice(0, FIELD_MAX - 1).replace(/[\uD800-\uDBFF]$/, '')}…` : trimmed;
}
/** Drops repeats so a header of "Orca" plus a project named "orca" reads once. */
function dedupeSegments(segments) {
    const seen = new Set();
    const kept = [];
    for (const segment of segments) {
        const key = segment.toLowerCase();
        if (segment && !seen.has(key)) {
            seen.add(key);
            kept.push(segment);
        }
    }
    return kept;
}
/**
 * Builds the payload handed to SET_ACTIVITY. Returns `null` when nothing should
 * be published — the caller clears the status rather than sending an empty one.
 *
 * The card reads top to bottom as:
 *
 *   OpenCode 2 - my app                  ← details: agent and focused workspace
 *   Vibing · 2 agents working · in my-app ← state: working label and fleet
 *
 * `startedAt` is supplied by the runtime and stays unchanged across workspace
 * switches. Public details are limited to 64 characters, including "...".
 */
export function buildActivity({ state, focus, privacy, startedAt, elapsedMs = 0, header, assets, agentImage, partyId }) {
    if (privacy === 'off') {
        return null;
    }
    const summary = summarize(state);
    const activity = {};
    const heading = renderHeader(header ?? DEFAULT_HEADER, { focus, state, privacy });
    const selected = latestAgent(state, privacy === 'full' ? focus : undefined);
    const pane = selected ? state.panes.get(selected.paneKey) : undefined;
    const progress = privacy === 'full' && pane?.state === 'working' ? pane.progress : undefined;
    if (privacy === 'full') {
        const project = basename(describeProject(focus, state).replaceAll('\\', '/'))
            .replace(/[-_]+/g, ' ').trim();
        const details = dedupeSegments([
            heading, (header ?? DEFAULT_HEADER).includes('{workspace}') ? '' : project
        ]).join(' - ');
        const characters = Array.from(details);
        activity.details = clampField(characters.length > 64 ? `${characters.slice(0, 61).join('')}...` : details) ?? clampField(FALLBACK_DETAILS);
    }
    else {
        // `minimal`: the fleet's shape is not sensitive, its names are — so the
        // header is all that survives, and a blanked header leaves details unset.
        activity.details = heading ? clampField(heading) : undefined;
    }
    const description = describeActivity(summary, progress ? [] : privacy === 'full' ? describeWorkspaces(state, summary) : [], elapsedMs);
    activity.state = clampField(progress ? `${description} · ${progress}` : description);
    if (typeof startedAt === 'number' && startedAt > 0) {
        activity.timestamps = { start: Math.floor(startedAt) };
    }
    // `assets.largeImage === ''` means "publish no image at all", so it outranks
    // the dynamic logo and must not fall through to the default asset.
    const imageOff = assets?.largeImage === '';
    const dynamic = imageOff ? undefined : agentImage;
    const largeImage = imageOff ? '' : dynamic?.key || assets?.largeImage || DEFAULT_LARGE_IMAGE;
    const largeText = dynamic?.text || assets?.largeText || DEFAULT_LARGE_TEXT;
    if (largeImage) {
        activity.assets = { large_image: largeImage };
        if (largeText) {
            activity.assets.large_text = clampField(largeText);
        }
    }
    // A small image needs a large one to sit on: Discord renders it as a badge in
    // the logo's corner, and on its own it is simply dropped.
    const workingImage = selected && state.panes.get(selected.paneKey)?.state === 'working'
        ? assets?.workingSmallImage : undefined;
    const smallImage = workingImage || assets?.smallImage || '';
    if (largeImage && smallImage) {
        activity.assets = { ...activity.assets, small_image: smallImage };
        const smallText = workingImage ? 'Agent working' : assets?.smallText ?? '';
        if (smallText) {
            activity.assets.small_text = clampField(smallText);
        }
    }
    const party = describeParty(summary, partyId);
    if (party) {
        activity.party = party;
    }
    activity.instance = false;
    return activity;
}
/**
 * Fleet gauge: Discord renders `size` as `(2 of 5)` next to the status line.
 *
 * Counts only, so it says the same thing at `full` and at `minimal` — the
 * numbers are already in the status line, and neither level would leak a name
 * through an integer. Omitted when no agent is busy, because `(0 of 3)` reads
 * as a broken party rather than as an idle fleet.
 */
function describeParty(summary, partyId) {
    const busy = busyCount(summary);
    if (busy <= 0) {
        return null;
    }
    // `max` can never be below `current`: a pane can report a status before its
    // worktree event arrives, and Discord rejects an inverted party size.
    const size = [busy, Math.max(busy, summary.panes)];
    return partyId ? { id: partyId, size } : { size };
}
export function isPrivacyLevel(value) {
    return typeof value === 'string' && PRIVACY_LEVELS.includes(value);
}
export function nextPrivacy(current) {
    const index = PRIVACY_LEVELS.indexOf(current);
    return PRIVACY_LEVELS[(index + 1) % PRIVACY_LEVELS.length];
}
/**
 * True when the fleet has any agent that is not finished.
 *
 * `waiting` counts: Orca maps both `blocked` and `waiting` onto its
 * `permission` status — "agent needs user attention" — so a fleet sitting on a
 * permission prompt is not idle, and the elapsed timer should keep running.
 */
export function isBusy(summary) {
    return summary.working > 0 || summary.blocked > 0 || summary.waiting > 0;
}
/** Agents the fleet still owes work on — the `current` half of the party size. */
export function busyCount(summary) {
    return summary.working + summary.blocked + summary.waiting;
}
//# sourceMappingURL=presence-model.mjs.map