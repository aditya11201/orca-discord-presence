/**
 * Orca plugin worker entry: mirrors the agent fleet into Discord Rich Presence.
 *
 * Lifetime note, because it shapes everything below: Orca reaps a plugin worker
 * after 5 minutes with no in-flight work (`PLUGIN_WORKER_IDLE_REAP_MS`) and
 * re-forks it on the next event. A worker cannot keep itself alive — only
 * host→worker traffic refreshes the idle clock. So the presence is deliberately
 * *ephemeral*: it appears while the fleet is active, disappears once things have
 * been quiet for a few minutes, and comes back on the next agent event. State
 * survives the gap in plugin storage rather than in memory.
 */

import { randomUUID } from 'node:crypto'
import { DiscordPresenceClient } from './lib/discord-ipc.mjs'
import type {
  JsonValue,
  OrcaPluginApi,
  PluginCapabilityKind,
  WorkspaceContext
} from './lib/orca-api.mjs'
import {
  applyAgentIdentities,
  DEFAULT_HEADER,
  DEFAULT_LARGE_IMAGE,
  DEFAULT_PRIVACY,
  applyAgentStatus,
  applyWorktreeCreated,
  applyWorktreeRemoved,
  buildActivity,
  createPresenceState,
  deserializeState,
  describeActivity,
  describeWorkspaces,
  isBusy,
  isPrivacyLevel,
  latestAgent,
  nextHeader,
  nextPrivacy,
  renderHeader,
  pruneStale,
  serializeState,
  summarize,
  type PresenceAssets,
  type PresenceState,
  type PresenceSummary,
  type PrivacyLevel
} from './lib/presence-model.mjs'
import {
  describeAgent,
  readAgentIdentities,
  readAgentImages,
  resolveAgentImage
} from './lib/agent-identity.mjs'

const STORAGE_KEY = 'presence-state'
const STORAGE_STARTED_AT_KEY = 'busy-since'

/**
 * Discord application backing the presence by default.
 *
 * Rich Presence application ids are public identifiers — they travel in every
 * client's IPC traffic and grant nothing on their own. The sensitive half is
 * the OAuth client secret, which Rich Presence never needs and this plugin
 * never asks for. Shipping an id means the plugin works on install; set
 * `clientId` in settings to publish under your own application instead (the
 * application's name is what Discord shows as the "Playing …" line).
 */
export const DEFAULT_CLIENT_ID = '1534192299926360234'

/** Coalesce bursts: a single agent transition can fan out several events. */
const PUBLISH_DEBOUNCE_MS = 1_500
/** Discord throttles SET_ACTIVITY at roughly 5 calls / 15s; stay well under. */
const MIN_PUBLISH_INTERVAL_MS = 4_000
const FOCUS_POLL_MS = 30_000
const RECONNECT_DELAYS_MS = [15_000, 30_000, 60_000] as const

/**
 * `header` and the asset keys are `undefined` when unset so the model can tell
 * "not configured" (take the default) from `""` (deliberately turned off).
 */
type PluginSettings = {
  enabled: boolean
  privacy: PrivacyLevel
  clientId: string
  header: string | undefined
  assets: PresenceAssets
  /** Swap the logo for the agent that ran most recently. On by default. */
  dynamicAgentImage: boolean
  /** Per-agent artwork overrides: asset key or `https://` image URL. */
  agentImages: Record<string, string>
  /** Directory holding the host's `agent-hooks/` rows; resolved if unset. */
  agentStateDir: string | undefined
}

export type PresenceStatusReport = {
  enabled: boolean
  privacy: PrivacyLevel
  connected: boolean
  socketPath: string | null
  /** False once `clientId` in settings points at the user's own application. */
  usingDefaultApplication: boolean
  /** The header template as configured — may still hold `{workspace}`. */
  header: string
  /** The header as published, tokens resolved against the current privacy. */
  headerText: string
  /** Art asset key published as the large image; empty when turned off. */
  largeImage: string
  /** Agent whose logo is published; `null` when the dynamic logo is off/unresolved. */
  agent: string | null
  /** Art key or URL actually published as the logo. */
  publishedImage: string
  /** Art asset key published as the badge; empty unless one is configured. */
  smallImage: string
  summary: PresenceSummary
  lastError: string | null
}

/**
 * Module-scoped because the host ignores whatever `activate` returns and calls
 * the `deactivate` export for teardown — there is nowhere else to hand the
 * runtime across.
 */
let activeRuntime: PresenceRuntime | null = null

export default function activate(orca: OrcaPluginApi): void {
  activeRuntime?.dispose()
  const runtime = new PresenceRuntime(orca)
  activeRuntime = runtime
  runtime.start()

  orca.commands.register('presence.toggle', () => runtime.toggleEnabled())
  // Takes a level when the host passes one, and cycles otherwise — same shape
  // as the header command, for the same reason.
  orca.commands.register('presence.privacy', (args) => runtime.setPrivacy(args))
  orca.commands.register('presence.status', () => runtime.reportStatus())
  orca.commands.register('presence.reconnect', () => runtime.reconnectNow())
  // Takes the new header as its argument when the host passes one, and cycles
  // the presets when it does not — Orca has no text-input affordance for
  // commands, so the cycle is what makes this usable from the palette alone.
  orca.commands.register('presence.header', (args) => runtime.setHeader(args))
  orca.commands.register('presence.logo', () => runtime.toggleDynamicLogo())

  orca.events.on('worktree.created', (payload) => {
    runtime.onEvent((state) => applyWorktreeCreated(state, payload))
  })
  orca.events.on('worktree.removed', (payload) => {
    runtime.onEvent((state) => applyWorktreeRemoved(state, payload))
  })
  orca.events.on('agent.status.changed', (payload) => {
    runtime.onEvent((state) => applyAgentStatus(state, payload))
    // The event carries no agent identity, so the join runs against the host's
    // persisted rows on every status change — the moment a new agent speaks up
    // is exactly when the logo has to move.
    runtime.onEvent((state) => applyAgentIdentities(state, runtime.readIdentities()))
  })
}

export async function deactivate(): Promise<void> {
  const runtime = activeRuntime
  activeRuntime = null
  // Clear the status on the way out: a stale "3 agents working" left sitting on
  // a profile after Orca quits is worse than no presence at all.
  await runtime?.shutdown()
}

class PresenceRuntime {
  readonly #orca: OrcaPluginApi
  readonly #granted: Set<PluginCapabilityKind>

  #state: PresenceState = createPresenceState()
  #settings: PluginSettings = {
    enabled: true,
    privacy: DEFAULT_PRIVACY,
    clientId: DEFAULT_CLIENT_ID,
    header: undefined,
    assets: {
      largeImage: undefined,
      largeText: undefined,
      smallImage: undefined,
      smallText: undefined
    },
    dynamicAgentImage: true,
    agentImages: {},
    agentStateDir: undefined
  }
  #client: DiscordPresenceClient | null = null
  #connecting = false
  #reconnectAttempt = 0
  #busySince = 0
  #lastPublishAt = 0
  #lastPayload = ''
  #focus: WorkspaceContext = null
  #publishTimer: NodeJS.Timeout | null = null
  #reconnectTimer: NodeJS.Timeout | null = null
  #focusTimer: NodeJS.Timeout | null = null
  #disposed = false
  #lastError: string | null = null
  /**
   * Per-worker party id. Random rather than fixed: a party id is the handle
   * Discord would group people by, and two Orca users are not in a party
   * together just because they both run this plugin. Nothing joinable is
   * published — Rich Presence needs a join secret for that, which this plugin
   * never sends.
   */
  readonly #partyId = randomUUID()

  constructor(orca: OrcaPluginApi) {
    this.#orca = orca
    // Consent is granted per manifest, but a host that narrows a grant should
    // cost us a skipped call, not a failing one every 30 seconds.
    this.#granted = new Set(orca.grantedCapabilities ?? [])
  }

  start(): void {
    void this.#bootstrap()
    this.#focusTimer = setInterval(() => void this.#refreshFocus(), FOCUS_POLL_MS)
    this.#focusTimer.unref?.()
  }

  async #bootstrap(): Promise<void> {
    await this.#loadSettings()
    await this.#loadState()
    await this.#refreshFocus()
    this.#schedulePublish()
  }

  #can(capability: PluginCapabilityKind): boolean {
    return this.#granted.has(capability)
  }

  /**
   * Agent identities from the host's persisted rows. Public because the event
   * handlers in `activate()` run outside the class but need the same join.
   * Returns an empty map whenever the file is missing, oversized or unreadable
   * — the presence keeps working with the Orca logo in that case.
   */
  readIdentities(): Map<string, { agent: string; receivedAt: number }> {
    // Why: no `dynamicAgentImage` guard here. Turning the logo off must stop
    // publishing agent artwork, not stop *learning* which agent each pane runs —
    // with the guard, a pane's identity never lands in storage, so re-enabling
    // the logo later shows nothing until a fresh status event happens to arrive.
    return readAgentIdentities({ agentStateDir: this.#settings.agentStateDir })
  }

  /** Logo for the agent that ran most recently, or `undefined` to keep the default. */
  #agentImage(): { key: string; text: string } | undefined {
    if (!this.#settings.dynamicAgentImage) {
      return undefined
    }
    const latest = latestAgent(this.#state)
    if (!latest) {
      return undefined
    }
    const image = resolveAgentImage(latest.agent, {
      agentImages: this.#settings.agentImages,
      fallbackImage: this.#settings.assets.largeImage ?? DEFAULT_LARGE_IMAGE
    })
    // The fallback key is what would have been published anyway; publishing it
    // through this path would only obscure the status report.
    return image.key === (this.#settings.assets.largeImage ?? DEFAULT_LARGE_IMAGE)
      ? undefined
      : image
  }

  async #loadSettings(): Promise<void> {
    if (!this.#can('settings:own')) {
      return
    }
    try {
      const result = await this.#orca.host.call('settings.get')
      const stored = result.settings ?? {}
      this.#settings = {
        enabled: stored['enabled'] !== false,
        privacy: isPrivacyLevel(stored['privacy']) ? stored['privacy'] : DEFAULT_PRIVACY,
        clientId: readClientId(stored['clientId']),
        header: readOptionalString(stored['header']),
        assets: {
          largeImage: readOptionalString(stored['largeImage']),
          largeText: readOptionalString(stored['largeText']),
          smallImage: readOptionalString(stored['smallImage']),
          smallText: readOptionalString(stored['smallText'])
        },
        dynamicAgentImage: stored['dynamicAgentImage'] !== false,
        agentImages: readAgentImages(stored['agentImages']),
        agentStateDir: readOptionalString(stored['agentStateDir'])
      }
    } catch (error) {
      this.#orca.log(`settings unavailable, using defaults: ${describeError(error)}`)
    }
  }

  async #saveSetting(key: string, value: JsonValue): Promise<void> {
    if (!this.#can('settings:own')) {
      return
    }
    try {
      await this.#orca.host.call('settings.set', { key, value })
    } catch (error) {
      this.#orca.log(`could not persist ${key}: ${describeError(error)}`)
    }
  }

  async #loadState(): Promise<void> {
    if (!this.#can('storage')) {
      return
    }
    try {
      const stored = await this.#orca.host.call('storage.get', { key: STORAGE_KEY })
      this.#state = pruneStale(deserializeState(stored.value), Date.now())
      const since = await this.#orca.host.call('storage.get', { key: STORAGE_STARTED_AT_KEY })
      this.#busySince = typeof since.value === 'number' ? since.value : 0
    } catch (error) {
      this.#orca.log(`could not restore state: ${describeError(error)}`)
    }
  }

  async #persistState(): Promise<void> {
    if (!this.#can('storage')) {
      return
    }
    try {
      await this.#orca.host.call('storage.set', {
        key: STORAGE_KEY,
        value: serializeState(this.#state) as unknown as JsonValue
      })
    } catch (error) {
      this.#orca.log(`could not persist state: ${describeError(error)}`)
    }
  }

  async #refreshFocus(): Promise<void> {
    if (this.#disposed || !this.#can('workspace:read')) {
      return
    }
    const previous = this.#focus
    let next: WorkspaceContext
    try {
      next = await this.#orca.host.call('workspace.readContext')
    } catch (error) {
      // Non-fatal: without focus context the presence falls back to counts only.
      this.#orca.log(`workspace context unavailable: ${describeError(error)}`)
      next = null
    }
    this.#focus = next
    // The identity join is cheap (one bounded file read) and the focus poll is
    // the only heartbeat while the fleet is quiet, so it doubles as the sweep
    // that catches an agent switching panes without a status event. It runs
    // regardless of `dynamicAgentImage`: identities are state, not publication.
    this.onEvent((state) => applyAgentIdentities(state, this.readIdentities()))
    // Orca still has no focus-change plugin event. Polling only helps if a
    // changed context triggers a publish; otherwise the new workspace sits in
    // memory until an unrelated agent event happens to arrive.
    if (this.#settings.privacy === 'full' && !sameFocus(previous, next)) {
      this.#schedulePublish()
    }
  }

  /** Applies a state mutation, then persists and republishes. */
  onEvent(mutate: (state: PresenceState) => void): void {
    if (this.#disposed) {
      return
    }
    try {
      mutate(this.#state)
    } catch (error) {
      this.#orca.log(`event ignored: ${describeError(error)}`)
      return
    }
    pruneStale(this.#state, Date.now())
    this.#trackBusyWindow()
    void this.#persistState()
    this.#schedulePublish()
  }

  /**
   * Discord's elapsed timer should measure the current stretch of work, so the
   * start stamp is set when the fleet goes idle→busy and cleared on the way back.
   */
  #trackBusyWindow(): void {
    const busy = isBusy(summarize(this.#state))
    if (busy && this.#busySince === 0) {
      this.#busySince = Date.now()
      if (this.#can('storage')) {
        void this.#orca.host
          .call('storage.set', { key: STORAGE_STARTED_AT_KEY, value: this.#busySince })
          .catch(() => {})
      }
    } else if (!busy && this.#busySince !== 0) {
      this.#busySince = 0
      if (this.#can('storage')) {
        void this.#orca.host.call('storage.delete', { key: STORAGE_STARTED_AT_KEY }).catch(() => {})
      }
    }
  }

  #schedulePublish(): void {
    if (this.#disposed || this.#publishTimer) {
      return
    }
    const sinceLast = Date.now() - this.#lastPublishAt
    const delay = Math.max(PUBLISH_DEBOUNCE_MS, MIN_PUBLISH_INTERVAL_MS - sinceLast)
    this.#publishTimer = setTimeout(() => {
      this.#publishTimer = null
      void this.#publish()
    }, delay)
    this.#publishTimer.unref?.()
  }

  async #publish(): Promise<void> {
    if (this.#disposed || !this.#settings.enabled || this.#settings.privacy === 'off') {
      return
    }
    if (!this.#settings.clientId) {
      this.#lastError = 'no Discord application id configured'
      return
    }
    const activity = buildActivity({
      state: this.#state,
      focus: this.#focus,
      privacy: this.#settings.privacy,
      startedAt: this.#busySince,
      header: this.#settings.header,
      assets: this.#settings.assets,
      agentImage: this.#agentImage(),
      partyId: this.#partyId
    })
    // Why: identical payloads still cost a rate-limit slot, and a fleet can emit
    // many events that do not change what the status would say.
    const encoded = JSON.stringify(activity)
    if (encoded === this.#lastPayload) {
      return
    }

    const client = await this.#ensureClient()
    if (!client) {
      return
    }
    try {
      await client.setActivity(activity)
      this.#lastPayload = encoded
      this.#lastPublishAt = Date.now()
      this.#lastError = null
    } catch (error) {
      this.#lastError = describeError(error)
      this.#orca.log(`could not publish presence: ${this.#lastError}`)
    }
  }

  async #ensureClient(): Promise<DiscordPresenceClient | null> {
    if (this.#client?.connected) {
      return this.#client
    }
    if (this.#connecting || this.#disposed) {
      return null
    }
    this.#connecting = true
    const client = new DiscordPresenceClient({
      clientId: this.#settings.clientId,
      log: (line) => this.#orca.log(line)
    })
    client.onDisconnect = (error) => {
      this.#client = null
      this.#lastPayload = ''
      this.#lastError = describeError(error)
      this.#scheduleReconnect()
    }
    try {
      await client.connect()
      this.#client = client
      this.#reconnectAttempt = 0
      this.#lastError = null
      return client
    } catch (error) {
      this.#lastError = describeError(error)
      this.#orca.log(`discord unavailable: ${this.#lastError}`)
      this.#scheduleReconnect()
      return null
    } finally {
      this.#connecting = false
    }
  }

  #scheduleReconnect(): void {
    if (this.#disposed || this.#reconnectTimer || !this.#settings.enabled) {
      return
    }
    const index = Math.min(this.#reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)
    const delay = RECONNECT_DELAYS_MS[index] ?? RECONNECT_DELAYS_MS[0]
    this.#reconnectAttempt += 1
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null
      this.#schedulePublish()
    }, delay)
    this.#reconnectTimer.unref?.()
  }

  async toggleEnabled(): Promise<{ enabled: boolean }> {
    this.#settings.enabled = !this.#settings.enabled
    await this.#saveSetting('enabled', this.#settings.enabled)
    if (this.#settings.enabled) {
      this.#lastPayload = ''
      this.#schedulePublish()
    } else {
      await this.#clearPresence()
    }
    await this.#notify(
      'Discord Presence',
      this.#settings.enabled ? 'Presence enabled.' : 'Presence disabled.'
    )
    return { enabled: this.#settings.enabled }
  }

  /**
   * Sets the privacy level from the command's argument, or advances the cycle
   * when the host passes none.
   */
  async setPrivacy(args?: unknown): Promise<{ privacy: PrivacyLevel }> {
    const requested = readPrivacyArg(args)
    this.#settings.privacy = requested ?? nextPrivacy(this.#settings.privacy)
    await this.#saveSetting('privacy', this.#settings.privacy)
    this.#lastPayload = ''
    if (this.#settings.privacy === 'off') {
      await this.#clearPresence()
    } else {
      this.#schedulePublish()
    }
    await this.#notify('Discord Presence', `Privacy level: ${this.#settings.privacy}`)
    return { privacy: this.#settings.privacy }
  }

  /**
   * Sets the header from the command's argument, or advances the preset cycle
   * when the host passes none.
   */
  async setHeader(args?: unknown): Promise<{ header: string; headerText: string }> {
    const requested = readHeaderArg(args)
    const next = requested ?? nextHeader(this.#settings.header ?? DEFAULT_HEADER)
    this.#settings.header = next
    await this.#saveSetting('header', next)
    this.#lastPayload = ''
    this.#schedulePublish()

    const headerText = this.#renderHeader(next)
    // Templates and their result differ; showing both is what makes it obvious
    // that `{workspace}` is empty because privacy is masking it, not broken.
    await this.#notify(
      'Discord Presence',
      next === ''
        ? 'Header hidden.'
        : next === headerText
          ? `Header: ${headerText}`
          : `Header: ${next} → ${headerText}`
    )
    return { header: next, headerText }
  }

  /**
   * Turns the agent-following logo off (or back on). Off means the configured
   * `largeImage` — or the shipped `orca` asset — is published instead.
   */
  async toggleDynamicLogo(): Promise<{ dynamicAgentImage: boolean; agent: string | null }> {
    this.#settings.dynamicAgentImage = !this.#settings.dynamicAgentImage
    await this.#saveSetting('dynamicAgentImage', this.#settings.dynamicAgentImage)
    this.#lastPayload = ''
    this.#schedulePublish()
    const latest = this.#settings.dynamicAgentImage ? latestAgent(this.#state) : null
    await this.#notify(
      'Discord Presence',
      this.#settings.dynamicAgentImage
        ? latest
          ? `Logo follows the latest agent: ${describeAgent(latest.agent)}.`
          : 'Logo follows the latest agent; no agent seen yet.'
        : 'Logo pinned to the configured image.'
    )
    return {
      dynamicAgentImage: this.#settings.dynamicAgentImage,
      agent: latest?.agent ?? null
    }
  }

  /**
   * Drops the connection and publishes again straight away.
   *
   * The reconnect backoff already recovers on its own, but only while the
   * worker is alive — Discord started after Orca, or restarted during a quiet
   * stretch, leaves a reaped worker with nothing to retry. Invoking the command
   * re-forks the worker, and this makes that fork reconnect now instead of
   * waiting out the backoff.
   */
  async reconnectNow(): Promise<PresenceStatusReport> {
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer)
      this.#reconnectTimer = null
    }
    this.#reconnectAttempt = 0
    this.#lastPayload = ''
    this.#client?.close()
    this.#client = null
    if (this.#settings.enabled && this.#settings.privacy !== 'off') {
      await this.#refreshFocus()
      await this.#publish()
    }
    return this.reportStatus()
  }

  async reportStatus(): Promise<PresenceStatusReport> {
    // The command is an explicit request for current truth; do not make the
    // user wait for the next 30-second focus poll.
    await this.#refreshFocus()
    const summary = summarize(this.#state)
    const header = this.#settings.header ?? DEFAULT_HEADER
    const headerText = this.#renderHeader(header)
    const largeImage = this.#settings.assets.largeImage ?? DEFAULT_LARGE_IMAGE
    const smallImage = this.#settings.assets.smallImage ?? ''
    const agentImage = this.#agentImage()
    const latest = latestAgent(this.#state)
    const publishedImage = agentImage?.key || largeImage
    const connection = this.#client?.connected
      ? `connected (${this.#client.socketPath})`
      : (this.#lastError ?? 'not connected')
    // Mirrors what would actually be published, workspace names included — the
    // point of the command is to show what Discord is being told.
    const body = [
      `${this.#settings.enabled ? 'Enabled' : 'Disabled'} · privacy: ${this.#settings.privacy}`,
      [headerText, describeActivity(summary, this.#visibleWorkspaces(summary))]
        .filter(Boolean)
        .join(' · '),
      this.#settings.dynamicAgentImage
        ? latest
          ? `logo: ${publishedImage} (${describeAgent(latest.agent)})`
          : `logo: ${publishedImage || 'off'} (no agent seen yet)`
        : `logo: ${publishedImage || 'off'}${smallImage ? ` · badge: ${smallImage}` : ''}`,
      connection
    ].join('\n')
    await this.#notify('Discord Presence', body)
    return {
      enabled: this.#settings.enabled,
      privacy: this.#settings.privacy,
      connected: Boolean(this.#client?.connected),
      socketPath: this.#client?.socketPath ?? null,
      usingDefaultApplication: this.#settings.clientId === DEFAULT_CLIENT_ID,
      header,
      headerText,
      largeImage,
      agent: latest?.agent ?? null,
      publishedImage,
      smallImage,
      summary,
      lastError: this.#lastError
    }
  }

  #renderHeader(template: string): string {
    return renderHeader(template, {
      focus: this.#focus,
      state: this.#state,
      privacy: this.#settings.privacy
    })
  }

  /** Workspace names only leak into the status line at `full` privacy. */
  #visibleWorkspaces(summary: PresenceSummary): string[] {
    return this.#settings.privacy === 'full' ? describeWorkspaces(this.#state, summary) : []
  }

  async #clearPresence(): Promise<void> {
    this.#lastPayload = ''
    if (!this.#client?.connected) {
      return
    }
    try {
      await this.#client.setActivity(null)
    } catch (error) {
      this.#orca.log(`could not clear presence: ${describeError(error)}`)
    }
  }

  async #notify(title: string, body: string): Promise<void> {
    if (!this.#can('notifications:show')) {
      return
    }
    try {
      await this.#orca.host.call('notifications.show', { title, body })
    } catch (error) {
      this.#orca.log(`${title}: ${body} (${describeError(error)})`)
    }
  }

  /** Graceful stop: drop the status first, then tear the connection down. */
  async shutdown(): Promise<void> {
    if (this.#disposed) {
      return
    }
    try {
      await this.#clearPresence()
    } catch {
      // Nothing actionable during teardown.
    }
    this.dispose()
  }

  dispose(): void {
    this.#disposed = true
    if (this.#publishTimer) {
      clearTimeout(this.#publishTimer)
    }
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer)
    }
    if (this.#focusTimer) {
      clearInterval(this.#focusTimer)
    }
    this.#publishTimer = null
    this.#reconnectTimer = null
    this.#focusTimer = null
    this.#client?.close()
    this.#client = null
  }
}

/** Terminals are irrelevant to the card, so they do not make a focus change. */
function sameFocus(left: WorkspaceContext, right: WorkspaceContext): boolean {
  return (
    (left?.displayName.trim() ?? '') === (right?.displayName.trim() ?? '') &&
    (left?.branch.trim() ?? '') === (right?.branch.trim() ?? '')
  )
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** A configured id wins; anything blank or non-string falls back to the default. */
function readClientId(configured: unknown): string {
  if (typeof configured === 'string' && configured.trim().length > 0) {
    return configured.trim()
  }
  return DEFAULT_CLIENT_ID
}

/**
 * Keeps `""` distinct from "absent": a blank string is how the settings file
 * turns the header or the logo off, whereas a missing key takes the default.
 */
function readOptionalString(configured: unknown): string | undefined {
  return typeof configured === 'string' ? configured.trim() : undefined
}

/**
 * Privacy level handed to the command. Same shapes as the header argument,
 * since both travel through Orca's `unknown` command argument; anything that
 * is not a known level means "no argument", which cycles instead.
 */
function readPrivacyArg(args: unknown): PrivacyLevel | undefined {
  if (isPrivacyLevel(args)) {
    return args
  }
  if (typeof args === 'object' && args !== null) {
    const record = args as Record<string, unknown>
    for (const key of ['privacy', 'level', 'value']) {
      const candidate = record[key]
      if (isPrivacyLevel(candidate)) {
        return candidate
      }
    }
  }
  return undefined
}

/**
 * Header handed to the command. Accepts a bare string or the object shapes a
 * host or keybinding is likely to send, since Orca's command arguments are
 * `unknown` by contract. `""` is a value, not an absence — it hides the header.
 */
function readHeaderArg(args: unknown): string | undefined {
  if (typeof args === 'string') {
    return args.trim()
  }
  if (typeof args === 'object' && args !== null) {
    const record = args as Record<string, unknown>
    for (const key of ['header', 'value', 'text']) {
      const candidate = record[key]
      if (typeof candidate === 'string') {
        return candidate.trim()
      }
    }
  }
  return undefined
}
