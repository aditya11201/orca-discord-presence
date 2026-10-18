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

import { basename } from 'node:path'
import { describeAgent } from './agent-identity.mjs'
// Type-only, so the model still pulls in no IPC code at runtime.
import type { DiscordActivity } from './discord-ipc.mjs'
import type { AgentStatusState, WorkspaceContext } from './orca-api.mjs'

/** Orca's agent states, from `AGENT_STATUS_STATES` in the host. */
export const AGENT_STATES: readonly AgentStatusState[] = ['working', 'blocked', 'waiting', 'done']

export const PRIVACY_LEVELS = ['full', 'minimal', 'off'] as const
export type PrivacyLevel = (typeof PRIVACY_LEVELS)[number]

/**
 * Default is `minimal`, not `full`. Branch names routinely carry ticket ids and
 * client names, and a status that silently published them the moment the plugin
 * was enabled would be a bad default even though it is the more interesting one.
 */
export const DEFAULT_PRIVACY: PrivacyLevel = 'minimal'

export const WORKING_LABEL_INTERVAL_MS = 30_000
const WORKING_LABELS = ['Vibing', 'Just vibing', 'In the flow'] as const

/**
 * Leading segment of the details line — the closest thing to a card "header"
 * this plugin controls. Discord renders the application's own name above it and
 * that name cannot be set over IPC, so the header lives in `details` instead.
 * Set the setting to `""` to drop the segment entirely.
 */
export const DEFAULT_HEADER = '{agent}'

/**
 * A header is a template, not a literal, so that a header naming the workspace
 * still obeys the privacy level. Baking `checkout-service` into the setting
 * would keep publishing it after a drop to `minimal`; `{workspace}` blanks out
 * instead.
 */
const HEADER_TOKENS = /\{(workspace|branch|agent)\}/g

/** Segment separator inside a header template, and between details segments. */
const SEGMENT_SEPARATOR = ' · '

/**
 * What the **Set Header** command cycles through when the host hands it no
 * argument. Ends on `''` — hiding the header entirely is a real choice, and a
 * cycle that cannot reach it would force a trip to the settings file.
 */
export const HEADER_PRESETS: readonly string[] = [
  DEFAULT_HEADER,
  '{workspace}',
  '{workspace} · {branch}',
  ''
]

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
export const DEFAULT_LARGE_IMAGE =
  'https://raw.githubusercontent.com/stablyai/orca/main/resources/app-icons/orca-blue.png'
export const DEFAULT_LARGE_TEXT = 'Orca'

/** Shown at `minimal` when the header has been blanked out. */
const FALLBACK_DETAILS = 'Working in Orca'

/**
 * How many workspace names the status line lists before collapsing the rest
 * into `+N`. Three keeps the line readable on a Discord profile card.
 */
const MAX_WORKSPACE_NAMES = 3

/** Discord rejects a details/state string shorter than 2 or longer than 128. */
const FIELD_MIN = 2
const FIELD_MAX = 128

/**
 * Pane statuses older than this are dropped. The worker is reaped after 5
 * minutes idle and rehydrates from storage on the next event, so without a TTL
 * a fleet that was busy yesterday would still read as busy today.
 */
export const STALE_STATUS_MS = 6 * 60 * 60 * 1000

export type WorktreeRecord = { path: string; branch: string }
/**
 * `agent` is not carried by the plugin event stream; it is joined in from the
 * host's persisted agent rows (`agent-identity.mts`) and survives a worker reap
 * through storage.
 */
export type PaneRecord = {
  worktreeId: string | null
  state: AgentStatusState
  receivedAt: number
  agent?: string
}

export type PresenceState = {
  worktrees: Map<string, WorktreeRecord>
  panes: Map<string, PaneRecord>
}

export type PresenceSummary = {
  working: number
  blocked: number
  waiting: number
  done: number
  panes: number
  worktrees: number
  activeWorktrees: number
  /** Ids of the worktrees with a working agent, sorted so payloads stay stable. */
  activeWorktreeIds: string[]
}

/** Pane whose agent ran most recently; drives the dynamic logo. */
export type LatestAgent = { paneKey: string; agent: string; receivedAt: number }

export function createPresenceState(): PresenceState {
  return { worktrees: new Map(), panes: new Map() }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function isAgentState(value: unknown): value is AgentStatusState {
  return typeof value === 'string' && (AGENT_STATES as readonly string[]).includes(value)
}

export function applyWorktreeCreated(state: PresenceState, payload: unknown): PresenceState {
  const record = asRecord(payload)
  const worktreeId = asString(record?.['worktreeId'])
  if (!worktreeId) {
    return state
  }
  state.worktrees.set(worktreeId, {
    path: asString(record?.['path']),
    branch: asString(record?.['branch'])
  })
  return state
}

export function applyWorktreeRemoved(state: PresenceState, payload: unknown): PresenceState {
  const record = asRecord(payload)
  const worktreeId = asString(record?.['worktreeId'])
  if (!worktreeId) {
    return state
  }
  state.worktrees.delete(worktreeId)
  for (const [paneKey, pane] of state.panes) {
    if (pane.worktreeId === worktreeId) {
      state.panes.delete(paneKey)
    }
  }
  return state
}

export function applyAgentStatus(state: PresenceState, payload: unknown): PresenceState {
  const record = asRecord(payload)
  const paneKey = asString(record?.['paneKey'])
  const agentState = record?.['state']
  if (!paneKey || !isAgentState(agentState)) {
    return state
  }
  const worktreeId = record?.['worktreeId']
  const receivedAt = record?.['receivedAt']
  const previous = state.panes.get(paneKey)
  state.panes.set(paneKey, {
    worktreeId: typeof worktreeId === 'string' ? worktreeId : null,
    state: agentState,
    receivedAt: typeof receivedAt === 'number' ? receivedAt : 0,
    // Why: the event stream carries no agent identity, so a status update must
    // not clear one an earlier identity join filled in.
    ...(previous?.agent ? { agent: previous.agent } : {})
  })
  return state
}

/**
 * Joins host-persisted agent identities onto the panes already tracked.
 * Identities for unknown panes are ignored: adopting them would inflate the
 * fleet counts with panes Orca never projected to this plugin.
 */
export function applyAgentIdentities(
  state: PresenceState,
  identities: ReadonlyMap<string, { agent: string; receivedAt: number }>
): PresenceState {
  for (const [paneKey, pane] of state.panes) {
    const identity = identities.get(paneKey)
    if (!identity) {
      continue
    }
    if (pane.agent === identity.agent) {
      continue
    }
    state.panes.set(paneKey, { ...pane, agent: identity.agent })
  }
  return state
}

export function pruneStale(state: PresenceState, now: number): PresenceState {
  for (const [paneKey, pane] of state.panes) {
    if (now - pane.receivedAt > STALE_STATUS_MS) {
      state.panes.delete(paneKey)
    }
  }
  return state
}

/** Storage holds JSON, so Maps round-trip through plain objects. */
export function serializeState(state: PresenceState): {
  worktrees: Record<string, WorktreeRecord>
  panes: Record<string, PaneRecord>
} {
  return {
    worktrees: Object.fromEntries(state.worktrees),
    panes: Object.fromEntries(state.panes)
  }
}

export function deserializeState(raw: unknown): PresenceState {
  const state = createPresenceState()
  const root = asRecord(raw)
  if (!root) {
    return state
  }
  for (const [id, value] of Object.entries(asRecord(root['worktrees']) ?? {})) {
    const record = asRecord(value)
    if (record) {
      state.worktrees.set(id, { path: asString(record['path']), branch: asString(record['branch']) })
    }
  }
  for (const [paneKey, value] of Object.entries(asRecord(root['panes']) ?? {})) {
    const record = asRecord(value)
    if (record && isAgentState(record['state'])) {
      const worktreeId = record['worktreeId']
      const receivedAt = record['receivedAt']
      const agent = record['agent']
      state.panes.set(paneKey, {
        worktreeId: typeof worktreeId === 'string' ? worktreeId : null,
        state: record['state'],
        receivedAt: typeof receivedAt === 'number' ? receivedAt : 0,
        ...(typeof agent === 'string' && agent ? { agent } : {})
      })
    }
  }
  return state
}

/**
 * The pane whose agent ran most recently, among the panes Orca has given an
 * identity to. This is what drives the dynamic logo: finish prompting in OMP,
 * start a session in OpenCode, and the logo follows OpenCode.
 *
 * Ties and zero timestamps resolve by pane key so the choice is deterministic
 * across worker restarts — an unstable payload would republish for nothing.
 */
export function latestAgent(state: PresenceState): LatestAgent | null {
  let best: LatestAgent | null = null
  for (const [paneKey, pane] of state.panes) {
    if (!pane.agent) {
      continue
    }
    const candidate = { paneKey, agent: pane.agent, receivedAt: pane.receivedAt }
    if (!best) {
      best = candidate
      continue
    }
    if (candidate.receivedAt > best.receivedAt) {
      best = candidate
    } else if (candidate.receivedAt === best.receivedAt && candidate.paneKey < best.paneKey) {
      best = candidate
    }
  }
  return best
}

export function summarize(state: PresenceState): PresenceSummary {
  const counts: Record<AgentStatusState, number> = { working: 0, blocked: 0, waiting: 0, done: 0 }
  const activeWorktrees = new Set<string>()
  for (const pane of state.panes.values()) {
    counts[pane.state] += 1
    if (pane.state === 'working' && pane.worktreeId) {
      activeWorktrees.add(pane.worktreeId)
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
  }
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

/**
 * Display name for a worktree. The path's basename is the directory an agent
 * actually works in, which is what a reader recognises; the branch is the
 * fallback for a worktree the host reported without a path.
 */
function worktreeName(record: WorktreeRecord | undefined): string {
  if (record?.path) {
    return basename(record.path)
  }
  return record?.branch.trim() ?? ''
}

/**
 * Names of the workspaces (worktrees) that currently have a working agent.
 *
 * Only worktrees seen through `worktree.created` can be named — one that
 * existed before the plugin was installed is known by id alone, so the list
 * comes back short and `describeActivity` falls back to counting.
 */
export function describeWorkspaces(
  state: PresenceState,
  summary: PresenceSummary = summarize(state)
): string[] {
  const names: string[] = []
  for (const worktreeId of summary.activeWorktreeIds) {
    const name = worktreeName(state.worktrees.get(worktreeId))
    if (name) {
      names.push(name)
    }
  }
  return names
}

function listNames(names: readonly string[]): string {
  if (names.length <= MAX_WORKSPACE_NAMES) {
    return names.join(', ')
  }
  const shown = names.slice(0, MAX_WORKSPACE_NAMES).join(', ')
  return `${shown} +${names.length - MAX_WORKSPACE_NAMES}`
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
export function describeActivity(
  summary: PresenceSummary,
  workspaces: readonly string[] = [],
  elapsedMs = 0
): string {
  const parts: string[] = []
  if (summary.working > 0) {
    const phase = Math.floor(Math.max(0, elapsedMs) / WORKING_LABEL_INTERVAL_MS)
    parts.push(
      WORKING_LABELS[phase % WORKING_LABELS.length] ?? WORKING_LABELS[0],
      `${plural(summary.working, 'agent')} working`
    )
  }
  if (summary.blocked > 0) {
    parts.push(`${summary.blocked} blocked`)
  }
  if (summary.waiting > 0) {
    parts.push(`${summary.waiting} waiting`)
  }
  if (parts.length === 0) {
    return summary.panes > 0 ? 'Fleet idle' : 'No agents running'
  }
  if (summary.working > 0) {
    if (workspaces.length > 0) {
      parts.push(`in ${listNames(workspaces)}`)
    } else if (summary.activeWorktrees > 1) {
      parts.push(`across ${plural(summary.activeWorktrees, 'worktree')}`)
    }
  }
  return parts.join(SEGMENT_SEPARATOR)
}

/**
 * Project label from whatever the host gave us. `workspace.readContext` returns
 * a display name for the focused worktree; a worktree seen only through
 * `worktree.created` has just a path, whose basename is the best available name.
 */
export function describeProject(focus: WorkspaceContext, state: PresenceState): string {
  const displayName = focus?.displayName.trim()
  if (displayName) {
    return displayName
  }
  const branch = focus?.branch.trim()
  for (const worktree of state.worktrees.values()) {
    if (branch && worktree.branch === branch && worktree.path) {
      return basename(worktree.path)
    }
  }
  const [first] = state.worktrees.values()
  return first?.path ? basename(first.path) : ''
}

export type HeaderContext = {
  focus: WorkspaceContext
  state: PresenceState
  privacy: PrivacyLevel
}

/**
 * Expands a header template. `{workspace}` and `{branch}` resolve only at
 * `full`; at `minimal` they blank out, and a template left with nothing but
 * blanks falls back to AI Agent. `{agent}` uses the same latest pane as the logo,
 * including at `minimal` privacy and when agent artwork is disabled.
 *
 * Segments are split on `·` so that a token dropping out takes its separator
 * with it, so `{workspace} · {branch}` never reads as `· `.
 */
export function renderHeader(template: string, { focus, state, privacy }: HeaderContext): string {
  const trimmed = template.trim()
  if (!trimmed) {
    return ''
  }
  const named = privacy === 'full'
  const agent = trimmed.includes('{agent}') ? latestAgent(state) : null
  const values: Record<string, string> = {
    workspace: named ? describeProject(focus, state) : '',
    branch: named ? (focus?.branch.trim() ?? '') : '',
    agent: agent ? describeAgent(agent.agent) : ''
  }
  const rendered = trimmed
    .split('·')
    .map((segment) => segment.replace(HEADER_TOKENS, (_, token: string) => values[token] ?? '').trim())
    .filter(Boolean)
    .join(SEGMENT_SEPARATOR)
  return rendered || 'AI Agent'
}

/**
 * Next template in the cycle. A header the user typed by hand is not in the
 * list, so cycling from it starts the presets over from the top.
 */
export function nextHeader(current: string): string {
  const index = HEADER_PRESETS.indexOf(current.trim())
  const next = index < 0 ? HEADER_PRESETS[0] : HEADER_PRESETS[(index + 1) % HEADER_PRESETS.length]
  return next ?? DEFAULT_HEADER
}

function clampField(value: string): string | undefined {
  const trimmed = value.trim()
  if (trimmed.length < FIELD_MIN) {
    return undefined
  }
  return trimmed.length > FIELD_MAX ? `${trimmed.slice(0, FIELD_MAX - 1)}…` : trimmed
}

/** Drops repeats so a header of "Orca" plus a project named "orca" reads once. */
function dedupeSegments(segments: readonly string[]): string[] {
  const seen = new Set<string>()
  const kept: string[] = []
  for (const segment of segments) {
    const key = segment.toLowerCase()
    if (segment && !seen.has(key)) {
      seen.add(key)
      kept.push(segment)
    }
  }
  return kept
}

export type PresenceAssets = {
  largeImage?: string | undefined
  largeText?: string | undefined
  /** Badge in the corner of the logo. Off by default: the shipped application
   *  hosts no artwork under any other key, so a default would render blank. */
  smallImage?: string | undefined
  smallText?: string | undefined
}

export type BuildActivityInput = {
  state: PresenceState
  focus: WorkspaceContext
  privacy: PrivacyLevel
  startedAt?: number
  /** Milliseconds in the current busy window; controls the display-only label. */
  elapsedMs?: number
  /** Leading segment of the details line; `undefined` takes `DEFAULT_HEADER`. */
  header?: string | undefined
  assets?: PresenceAssets | undefined
  /**
   * Logo for the agent that ran most recently, when the dynamic logo is on.
   * Resolved by the caller (which knows the settings); `undefined` publishes
   * the configured `largeImage` instead.
   */
  agentImage?: { key: string; text?: string } | undefined
  /** Opaque party id; omitted, Discord may not render the party size at all. */
  partyId?: string | undefined
}

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
export function buildActivity({
  state,
  focus,
  privacy,
  startedAt,
  elapsedMs = 0,
  header,
  assets,
  agentImage,
  partyId
}: BuildActivityInput): DiscordActivity | null {
  if (privacy === 'off') {
    return null
  }
  const summary = summarize(state)
  const activity: DiscordActivity = {}
  const heading = renderHeader(header ?? DEFAULT_HEADER, { focus, state, privacy })

  if (privacy === 'full') {
    const project = describeProject(focus, state)
    const branch = focus?.branch.trim() ?? ''
    // Deduped, so a header that already names the workspace does not repeat it.
    const details = dedupeSegments([heading, project, branch]).join(SEGMENT_SEPARATOR)
    activity.details = clampField(details) ?? clampField(FALLBACK_DETAILS)
  } else {
    // `minimal`: the fleet's shape is not sensitive, its names are — so the
    // header is all that survives, and a blanked header leaves details unset.
    activity.details = heading ? clampField(heading) : undefined
  }

  activity.state = clampField(
    describeActivity(
      summary,
      privacy === 'full' ? describeWorkspaces(state, summary) : [],
      elapsedMs
    )
  )
  if (typeof startedAt === 'number' && startedAt > 0) {
    activity.timestamps = { start: Math.floor(startedAt) }
  }
  // `assets.largeImage === ''` means "publish no image at all", so it outranks
  // the dynamic logo and must not fall through to the default asset.
  const imageOff = assets?.largeImage === ''
  const dynamic = imageOff ? undefined : agentImage
  const largeImage = imageOff ? '' : dynamic?.key || assets?.largeImage || DEFAULT_LARGE_IMAGE
  const largeText = dynamic?.text || assets?.largeText || DEFAULT_LARGE_TEXT
  if (largeImage) {
    activity.assets = { large_image: largeImage }
    if (largeText) {
      activity.assets.large_text = clampField(largeText)
    }
  }
  // A small image needs a large one to sit on: Discord renders it as a badge in
  // the logo's corner, and on its own it is simply dropped.
  const smallImage = assets?.smallImage ?? ''
  if (largeImage && smallImage) {
    activity.assets = { ...activity.assets, small_image: smallImage }
    const smallText = assets?.smallText ?? ''
    if (smallText) {
      activity.assets.small_text = clampField(smallText)
    }
  }
  const party = describeParty(summary, partyId)
  if (party) {
    activity.party = party
  }
  activity.instance = false
  return activity
}

/**
 * Fleet gauge: Discord renders `size` as `(2 of 5)` next to the status line.
 *
 * Counts only, so it says the same thing at `full` and at `minimal` — the
 * numbers are already in the status line, and neither level would leak a name
 * through an integer. Omitted when no agent is busy, because `(0 of 3)` reads
 * as a broken party rather than as an idle fleet.
 */
function describeParty(
  summary: PresenceSummary,
  partyId: string | undefined
): { id?: string; size: [number, number] } | null {
  const busy = busyCount(summary)
  if (busy <= 0) {
    return null
  }
  // `max` can never be below `current`: a pane can report a status before its
  // worktree event arrives, and Discord rejects an inverted party size.
  const size: [number, number] = [busy, Math.max(busy, summary.panes)]
  return partyId ? { id: partyId, size } : { size }
}

export function isPrivacyLevel(value: unknown): value is PrivacyLevel {
  return typeof value === 'string' && (PRIVACY_LEVELS as readonly string[]).includes(value)
}

export function nextPrivacy(current: PrivacyLevel): PrivacyLevel {
  const index = PRIVACY_LEVELS.indexOf(current)
  return PRIVACY_LEVELS[(index + 1) % PRIVACY_LEVELS.length] as PrivacyLevel
}

/**
 * True when the fleet has any agent that is not finished.
 *
 * `waiting` counts: Orca maps both `blocked` and `waiting` onto its
 * `permission` status — "agent needs user attention" — so a fleet sitting on a
 * permission prompt is not idle, and the elapsed timer should keep running.
 */
export function isBusy(summary: PresenceSummary): boolean {
  return summary.working > 0 || summary.blocked > 0 || summary.waiting > 0
}

/** Agents the fleet still owes work on — the `current` half of the party size. */
export function busyCount(summary: PresenceSummary): number {
  return summary.working + summary.blocked + summary.waiting
}
