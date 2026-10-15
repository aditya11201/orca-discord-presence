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

import { existsSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

/** Directory under userData holding the persisted agent status rows. */
export const AGENT_STATE_DIR_NAME = 'agent-hooks'
/** File under that directory holding one row per pane key. */
export const AGENT_STATE_FILE_NAME = 'last-status.json'

/**
 * The real file carries prompts and last assistant messages, so it grows with
 * the fleet; a cap keeps a pathological host file from stalling the worker.
 */
export const AGENT_STATE_MAX_BYTES = 2 * 1024 * 1024
/** Rows beyond this are ignored; Orca panes are far fewer. */
export const AGENT_ENTRY_LIMIT = 512

/** Agent id as Orca reports it, per pane key. */
export type AgentIdentity = { agent: string; receivedAt: number }

/**
 * Where `<userData>` lives, per platform. Deliberately derived from the worker
 * environment allowlist (HOME, USERPROFILE) rather than electron's app paths:
 * a plugin worker has neither `app.getPath` nor `APPDATA`/`XDG_CONFIG_HOME`
 * guaranteed, but it does have HOME and USERPROFILE, and the XDG default
 * (`~/.config`) needs nothing else.
 */
export function resolveUserDataDir(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  override?: unknown
): string | null {
  if (typeof override === 'string' && isAbsolute(override.trim())) {
    return override.trim()
  }
  if (platform === 'win32') {
    const profile = env['USERPROFILE']
    return profile ? join(profile, 'AppData', 'Roaming', 'Orca') : null
  }
  if (platform === 'darwin') {
    const home = env['HOME']
    return home ? join(home, 'Library', 'Application Support', 'Orca') : null
  }
  const home = env['HOME']
  if (!home) {
    return null
  }
  const xdg = env['XDG_CONFIG_HOME']
  const base = xdg && isAbsolute(xdg) ? xdg : join(home, '.config')
  return join(base, 'Orca')
}

/** Absolute path of the persisted agent status file. */
export function resolveAgentStateFile(agentStateDir?: unknown): string | null {
  const userData = resolveUserDataDir(process.platform, process.env, agentStateDir)
  return userData ? join(userData, AGENT_STATE_DIR_NAME, AGENT_STATE_FILE_NAME) : null
}

export type ReadAgentIdentitiesOptions = {
  /** Directory holding `agent-hooks/`. Defaults to the resolved userData dir. */
  agentStateDir?: unknown
  maxBytes?: number
  maxEntries?: number
  readFile?: (path: string) => string
  exists?: (path: string) => boolean
  sizeOf?: (path: string) => { size: number }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function firstString(...values: readonly unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim()
    }
  }
  return ''
}

/**
 * Agent id for one persisted row. `payload.agentType` is the authoritative
 * field; `agentPresence.agent` is the host's own presence record; `source` is
 * last because it names whatever wrote the row, not necessarily an agent.
 */
function readRowAgent(entry: Record<string, unknown>): string {
  const payload = asRecord(entry['payload'])
  const presence = asRecord(entry['agentPresence'])
  return firstString(payload?.['agentType'], presence?.['agent'], entry['source'])
}

function readRowReceivedAt(entry: Record<string, unknown>): number {
  const payload = asRecord(entry['payload'])
  for (const value of [payload?.['receivedAt'], entry['receivedAt']]) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      return value
    }
  }
  return 0
}

/**
 * paneKey → agent identity, for the panes Orca has a persisted row for.
 *
 * Every failure mode returns an empty map: the file being absent is the normal
 * state before the first agent runs, and a host that reshapes or drops it must
 * not take the presence down with it.
 */
export function readAgentIdentities(
  options: ReadAgentIdentitiesOptions = {}
): Map<string, AgentIdentity> {
  const identities = new Map<string, AgentIdentity>()
  const path = resolveAgentStateFile(options.agentStateDir)
  if (!path) {
    return identities
  }
  const exists = options.exists ?? existsSync
  const sizeOf = options.sizeOf ?? statSync
  const maxBytes = options.maxBytes ?? AGENT_STATE_MAX_BYTES
  const maxEntries = options.maxEntries ?? AGENT_ENTRY_LIMIT
  try {
    if (!exists(path)) {
      return identities
    }
    if (sizeOf(path).size > maxBytes) {
      return identities
    }
    const readFile = options.readFile ?? ((file: string) => readFileSync(file, 'utf8'))
    const parsed: unknown = JSON.parse(readFile(path))
    const entries = asRecord(asRecord(parsed)?.['entries'])
    if (!entries) {
      return identities
    }
    for (const [paneKey, value] of Object.entries(entries)) {
      if (identities.size >= maxEntries) {
        break
      }
      const entry = asRecord(value)
      if (!paneKey || !entry) {
        continue
      }
      const agent = readRowAgent(entry)
      if (!agent) {
        continue
      }
      identities.set(paneKey, { agent, receivedAt: readRowReceivedAt(entry) })
    }
  } catch {
    // Unreadable, permission-denied or reshaped: no identities is a valid answer.
  }
  return identities
}

/**
 * Artwork for the agents this plugin can name without configuration. Every URL
 * is checked to respond with an image content type before being shipped here;
 * Discord proxies each one once and caches it, so publishing costs no request.
 *
 * `omp` points at the project's own site. Orca ships no logo for it, and the
 * site's OG image is the only public artwork, so `agentImages` is the knob for
 * a cleaner one.
 */
export const DEFAULT_AGENT_IMAGE_SOURCES: Readonly<Record<string, string>> = Object.freeze({
  omp: 'https://omp.sh/og-image.png',
  opencode: 'https://raw.githubusercontent.com/stablyai/orca/main/resources/opencode.webp',
  // Orca's second OpenCode runtime; same product, same artwork.
  opencode2: 'https://raw.githubusercontent.com/stablyai/orca/main/resources/opencode.webp',
  claude: 'https://raw.githubusercontent.com/stablyai/orca/main/resources/claude.webp',
  openclaude: 'https://raw.githubusercontent.com/stablyai/orca/main/resources/openclaude-logo.png'
})

/** Display names for the agents Orca ships artwork for. */
const AGENT_DISPLAY_NAMES: Readonly<Record<string, string>> = Object.freeze({
  omp: 'Oh My Pi (OMP)',
  opencode: 'OpenCode',
  opencode2: 'OpenCode 2',
  claude: 'Claude',
  openclaude: 'OpenClaude'
})

export function describeAgent(agent: string): string {
  return AGENT_DISPLAY_NAMES[agent] ?? agent
}

/**
 * Discord accepts either an `https://` image URL (proxied once, then cached) or
 * a plain asset key naming art uploaded to the application. Anything else — a
 * file path, a non-image URL, a key with a colon — would be sent as-is and
 * rejected, so it is filtered out here.
 */
const IMAGE_URL_RE = /^https:\/\/\S+\.(?:png|jpe?g|gif|webp)$/i
const ASSET_KEY_RE = /^[A-Za-z0-9_-]+$/

function isUsableImage(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false
  }
  const trimmed = value.trim()
  if (!trimmed) {
    return false
  }
  return IMAGE_URL_RE.test(trimmed) || ASSET_KEY_RE.test(trimmed)
}

export type ResolveAgentImageInput = {
  agentImages?: Record<string, unknown> | undefined
  /** Asset key to fall back to when the agent has no artwork of its own. */
  fallbackImage?: string | undefined
}

/**
 * Artwork for one agent. A per-agent override wins over the built-in source,
 * and an unmapped agent keeps `fallbackImage` — a missing asset key would
 * publish an empty square, which is worse than the Orca logo.
 */
export function resolveAgentImage(
  agent: string,
  { agentImages, fallbackImage }: ResolveAgentImageInput
): { key: string; text: string } {
  const override = agentImages?.[agent]
  if (isUsableImage(override)) {
    return { key: override.trim(), text: describeAgent(agent) }
  }
  const source = DEFAULT_AGENT_IMAGE_SOURCES[agent]
  if (source) {
    return { key: source, text: describeAgent(agent) }
  }
  return { key: fallbackImage ?? '', text: describeAgent(agent) }
}

/** Reads a `{ "<agent>": "<asset key or https url>" }` settings object. */
export function readAgentImages(configured: unknown): Record<string, string> {
  const record = asRecord(configured)
  if (!record) {
    return {}
  }
  const images: Record<string, string> = {}
  for (const [agent, value] of Object.entries(record)) {
    if (isUsableImage(value)) {
      images[agent.trim()] = value.trim()
    }
  }
  return images
}
