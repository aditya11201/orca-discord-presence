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
import { randomUUID } from 'node:crypto';
import { DiscordPresenceClient } from './lib/discord-ipc.mjs';
import { applyAgentIdentities, DEFAULT_HEADER, DEFAULT_LARGE_IMAGE, DEFAULT_PRIVACY, WORKING_LABEL_INTERVAL_MS, applyAgentStatus, applyWorktreeCreated, applyWorktreeRemoved, buildActivity, createPresenceState, deserializeState, describeActivity, describeWorkspaces, isPrivacyLevel, latestAgent, nextHeader, nextPrivacy, renderHeader, pruneStale, serializeState, summarize } from './lib/presence-model.mjs';
import { describeAgent, readAgentIdentities, readAgentImages, resolveAgentImage } from './lib/agent-identity.mjs';
const STORAGE_KEY = 'presence-state';
const STORAGE_SESSION_KEY = 'session-since';
/** Pre-session builds keyed the timer on the busy window; adopted once on load. */
const LEGACY_STORAGE_BUSY_SINCE_KEY = 'busy-since';
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
export const DEFAULT_CLIENT_ID = '1560068042283687946';
/** Coalesce bursts: a single agent transition can fan out several events. */
const PUBLISH_DEBOUNCE_MS = 1_500;
/** Discord throttles SET_ACTIVITY at roughly 5 calls / 15s; stay well under. */
const MIN_PUBLISH_INTERVAL_MS = 4_000;
const RECONNECT_DELAYS_MS = [15_000, 30_000, 60_000];
/**
 * Module-scoped because the host ignores whatever `activate` returns and calls
 * the `deactivate` export for teardown — there is nowhere else to hand the
 * runtime across.
 */
let activeRuntime = null;
export default function activate(orca) {
    activeRuntime?.dispose();
    const runtime = new PresenceRuntime(orca);
    activeRuntime = runtime;
    runtime.start();
    orca.commands.register('presence.toggle', () => runtime.toggleEnabled());
    // Takes a level when the host passes one, and cycles otherwise — same shape
    // as the header command, for the same reason.
    orca.commands.register('presence.privacy', (args) => runtime.setPrivacy(args));
    orca.commands.register('presence.status', () => runtime.reportStatus());
    orca.commands.register('presence.reconnect', () => runtime.reconnectNow());
    // Takes the new header as its argument when the host passes one, and cycles
    // the presets when it does not — Orca has no text-input affordance for
    // commands, so the cycle is what makes this usable from the palette alone.
    orca.commands.register('presence.header', (args) => runtime.setHeader(args));
    orca.commands.register('presence.logo', () => runtime.toggleDynamicLogo());
    orca.events.on('worktree.created', (payload) => {
        runtime.onEvent((state) => applyWorktreeCreated(state, payload));
    });
    orca.events.on('worktree.removed', (payload) => {
        runtime.onEvent((state) => applyWorktreeRemoved(state, payload));
    });
    orca.events.on('agent.status.changed', (payload) => {
        runtime.onEvent((state) => applyAgentStatus(state, payload));
        // The event carries no agent identity, so the join runs against the host's
        // persisted rows on every status change — the moment a new agent speaks up
        // is exactly when the logo has to move.
        runtime.onEvent((state) => applyAgentIdentities(state, runtime.readIdentities()));
    });
}
export async function deactivate() {
    const runtime = activeRuntime;
    activeRuntime = null;
    // Clear the status on the way out: a stale "3 agents working" left sitting on
    // a profile after Orca quits is worse than no presence at all.
    await runtime?.shutdown();
}
class PresenceRuntime {
    #orca;
    #granted;
    #state = createPresenceState();
    #settings = {
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
    };
    #client = null;
    #connecting = false;
    #reconnectAttempt = 0;
    #sessionSince = 0;
    #lastPublishAt = 0;
    #lastPayload = '';
    #focus = null;
    #publishTimer = null;
    #reconnectTimer = null;
    #refreshTimer = null;
    #disposed = false;
    #lastError = null;
    /**
     * Per-worker party id. Random rather than fixed: a party id is the handle
     * Discord would group people by, and two Orca users are not in a party
     * together just because they both run this plugin. Nothing joinable is
     * published — Rich Presence needs a join secret for that, which this plugin
     * never sends.
     */
    #partyId = randomUUID();
    constructor(orca) {
        this.#orca = orca;
        // Consent is granted per manifest, but a host that narrows a grant should
        // cost us a skipped call, not a failing one every 30 seconds.
        this.#granted = new Set(orca.grantedCapabilities ?? []);
    }
    start() {
        void this.#bootstrap();
        // ponytail: reuse the refresh poll; use a phase timer if exact boundaries matter.
        this.#refreshTimer = setInterval(() => {
            void this.#refreshFocus();
            if (this.#settings.enabled && this.#settings.privacy !== 'off') {
                this.#schedulePublish();
            }
        }, WORKING_LABEL_INTERVAL_MS);
        this.#refreshTimer.unref?.();
    }
    async #bootstrap() {
        await this.#loadSettings();
        await this.#loadState();
        this.#startSession();
        await this.#refreshFocus();
        this.#schedulePublish();
    }
    /**
     * Discord's elapsed timer measures the Orca session, not a stretch of agent
     * work, so the stamp is written once and never cleared: agents starting and
     * stopping changes the status line but not the clock. Persisting it is what
     * lets a reaped worker restore the same timer instead of restarting it.
     */
    #startSession() {
        if (this.#sessionSince > 0) {
            return;
        }
        this.#sessionSince = Date.now();
        if (this.#can('storage')) {
            void this.#orca.host
                .call('storage.set', { key: STORAGE_SESSION_KEY, value: this.#sessionSince })
                .catch(() => { });
        }
    }
    #can(capability) {
        return this.#granted.has(capability);
    }
    /**
     * Agent identities from the host's persisted rows. Public because the event
     * handlers in `activate()` run outside the class but need the same join.
     * Returns an empty map whenever the file is missing, oversized or unreadable
     * — the presence keeps working with the Orca logo in that case.
     */
    readIdentities() {
        // Why: no `dynamicAgentImage` guard here. Turning the logo off must stop
        // publishing agent artwork, not stop *learning* which agent each pane runs —
        // with the guard, a pane's identity never lands in storage, so re-enabling
        // the logo later shows nothing until a fresh status event happens to arrive.
        return readAgentIdentities({ agentStateDir: this.#settings.agentStateDir });
    }
    /** Logo for the agent that ran most recently, or `undefined` to keep the default. */
    #agentImage() {
        if (!this.#settings.dynamicAgentImage) {
            return undefined;
        }
        const latest = latestAgent(this.#state);
        if (!latest) {
            return undefined;
        }
        const image = resolveAgentImage(latest.agent, {
            agentImages: this.#settings.agentImages,
            fallbackImage: this.#settings.assets.largeImage ?? DEFAULT_LARGE_IMAGE
        });
        // The fallback key is what would have been published anyway; publishing it
        // through this path would only obscure the status report.
        return image.key === (this.#settings.assets.largeImage ?? DEFAULT_LARGE_IMAGE)
            ? undefined
            : image;
    }
    async #loadSettings() {
        if (!this.#can('settings:own')) {
            return;
        }
        try {
            const result = await this.#orca.host.call('settings.get');
            const stored = result.settings ?? {};
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
            };
        }
        catch (error) {
            this.#orca.log(`settings unavailable, using defaults: ${describeError(error)}`);
        }
    }
    async #saveSetting(key, value) {
        if (!this.#can('settings:own')) {
            return;
        }
        try {
            await this.#orca.host.call('settings.set', { key, value });
        }
        catch (error) {
            this.#orca.log(`could not persist ${key}: ${describeError(error)}`);
        }
    }
    async #loadState() {
        if (!this.#can('storage')) {
            return;
        }
        try {
            const stored = await this.#orca.host.call('storage.get', { key: STORAGE_KEY });
            this.#state = pruneStale(deserializeState(stored.value), Date.now());
            const since = await this.#orca.host.call('storage.get', { key: STORAGE_SESSION_KEY });
            if (typeof since.value === 'number') {
                this.#sessionSince = since.value;
                return;
            }
            await this.#adoptLegacySessionSince();
        }
        catch (error) {
            this.#orca.log(`could not restore state: ${describeError(error)}`);
        }
    }
    /**
     * Migrates a `busy-since` stamp written by a build whose timer restarted on
     * every idle→busy transition. Adopting it rather than starting fresh keeps
     * the current session's timer continuous across the upgrade.
     */
    async #adoptLegacySessionSince() {
        try {
            const legacy = await this.#orca.host.call('storage.get', {
                key: LEGACY_STORAGE_BUSY_SINCE_KEY
            });
            if (typeof legacy.value !== 'number') {
                return;
            }
            this.#sessionSince = legacy.value;
            await this.#orca.host.call('storage.set', { key: STORAGE_SESSION_KEY, value: legacy.value });
            await this.#orca.host.call('storage.delete', { key: LEGACY_STORAGE_BUSY_SINCE_KEY });
        }
        catch (error) {
            this.#orca.log(`could not adopt the previous timer: ${describeError(error)}`);
        }
    }
    async #persistState() {
        if (!this.#can('storage')) {
            return;
        }
        try {
            await this.#orca.host.call('storage.set', {
                key: STORAGE_KEY,
                value: serializeState(this.#state)
            });
        }
        catch (error) {
            this.#orca.log(`could not persist state: ${describeError(error)}`);
        }
    }
    async #refreshFocus() {
        if (this.#disposed || !this.#can('workspace:read')) {
            return;
        }
        const previous = this.#focus;
        let next;
        try {
            next = await this.#orca.host.call('workspace.readContext');
        }
        catch (error) {
            // Non-fatal: without focus context the presence falls back to counts only.
            this.#orca.log(`workspace context unavailable: ${describeError(error)}`);
            next = null;
        }
        this.#focus = next;
        // The identity join is cheap (one bounded file read) and the focus poll is
        // the only heartbeat while the fleet is quiet, so it doubles as the sweep
        // that catches an agent switching panes without a status event. It runs
        // regardless of `dynamicAgentImage`: identities are state, not publication.
        this.onEvent((state) => applyAgentIdentities(state, this.readIdentities()));
        // Orca still has no focus-change plugin event. Polling only helps if a
        // changed context triggers a publish; otherwise the new workspace sits in
        // memory until an unrelated agent event happens to arrive.
        if (this.#settings.privacy === 'full' && !sameFocus(previous, next)) {
            this.#schedulePublish();
        }
    }
    /** Applies a state mutation, then persists and republishes. */
    onEvent(mutate) {
        if (this.#disposed) {
            return;
        }
        try {
            mutate(this.#state);
        }
        catch (error) {
            this.#orca.log(`event ignored: ${describeError(error)}`);
            return;
        }
        pruneStale(this.#state, Date.now());
        void this.#persistState();
        this.#schedulePublish();
    }
    #schedulePublish() {
        if (this.#disposed || this.#publishTimer) {
            return;
        }
        const sinceLast = Date.now() - this.#lastPublishAt;
        const delay = Math.max(PUBLISH_DEBOUNCE_MS, MIN_PUBLISH_INTERVAL_MS - sinceLast);
        this.#publishTimer = setTimeout(() => {
            this.#publishTimer = null;
            void this.#publish();
        }, delay);
        this.#publishTimer.unref?.();
    }
    async #publish() {
        if (this.#disposed || !this.#settings.enabled || this.#settings.privacy === 'off') {
            return;
        }
        if (!this.#settings.clientId) {
            this.#lastError = 'no Discord application id configured';
            return;
        }
        const activity = buildActivity({
            state: this.#state,
            focus: this.#focus,
            privacy: this.#settings.privacy,
            startedAt: this.#sessionSince,
            elapsedMs: Date.now() - this.#sessionSince,
            header: this.#settings.header,
            assets: this.#settings.assets,
            agentImage: this.#agentImage(),
            partyId: this.#partyId
        });
        // Why: identical payloads still cost a rate-limit slot, and a fleet can emit
        // many events that do not change what the status would say.
        const encoded = JSON.stringify(activity);
        if (encoded === this.#lastPayload) {
            return;
        }
        const client = await this.#ensureClient();
        if (!client) {
            return;
        }
        try {
            await client.setActivity(activity);
            this.#lastPayload = encoded;
            this.#lastPublishAt = Date.now();
            this.#lastError = null;
        }
        catch (error) {
            this.#lastError = describeError(error);
            this.#orca.log(`could not publish presence: ${this.#lastError}`);
        }
    }
    async #ensureClient() {
        if (this.#client?.connected) {
            return this.#client;
        }
        if (this.#connecting || this.#disposed) {
            return null;
        }
        this.#connecting = true;
        const client = new DiscordPresenceClient({
            clientId: this.#settings.clientId,
            log: (line) => this.#orca.log(line)
        });
        client.onDisconnect = (error) => {
            this.#client = null;
            this.#lastPayload = '';
            this.#lastError = describeError(error);
            this.#scheduleReconnect();
        };
        try {
            await client.connect();
            this.#client = client;
            this.#reconnectAttempt = 0;
            this.#lastError = null;
            return client;
        }
        catch (error) {
            this.#lastError = describeError(error);
            this.#orca.log(`discord unavailable: ${this.#lastError}`);
            this.#scheduleReconnect();
            return null;
        }
        finally {
            this.#connecting = false;
        }
    }
    #scheduleReconnect() {
        if (this.#disposed || this.#reconnectTimer || !this.#settings.enabled) {
            return;
        }
        const index = Math.min(this.#reconnectAttempt, RECONNECT_DELAYS_MS.length - 1);
        const delay = RECONNECT_DELAYS_MS[index] ?? RECONNECT_DELAYS_MS[0];
        this.#reconnectAttempt += 1;
        this.#reconnectTimer = setTimeout(() => {
            this.#reconnectTimer = null;
            this.#schedulePublish();
        }, delay);
        this.#reconnectTimer.unref?.();
    }
    async toggleEnabled() {
        this.#settings.enabled = !this.#settings.enabled;
        await this.#saveSetting('enabled', this.#settings.enabled);
        if (this.#settings.enabled) {
            this.#lastPayload = '';
            this.#schedulePublish();
        }
        else {
            await this.#clearPresence();
        }
        await this.#notify('Discord Presence', this.#settings.enabled ? 'Presence enabled.' : 'Presence disabled.');
        return { enabled: this.#settings.enabled };
    }
    /**
     * Sets the privacy level from the command's argument, or advances the cycle
     * when the host passes none.
     */
    async setPrivacy(args) {
        const requested = readPrivacyArg(args);
        this.#settings.privacy = requested ?? nextPrivacy(this.#settings.privacy);
        await this.#saveSetting('privacy', this.#settings.privacy);
        this.#lastPayload = '';
        if (this.#settings.privacy === 'off') {
            await this.#clearPresence();
        }
        else {
            this.#schedulePublish();
        }
        await this.#notify('Discord Presence', `Privacy level: ${this.#settings.privacy}`);
        return { privacy: this.#settings.privacy };
    }
    /**
     * Sets the header from the command's argument, or advances the preset cycle
     * when the host passes none.
     */
    async setHeader(args) {
        const requested = readHeaderArg(args);
        const next = requested ?? nextHeader(this.#settings.header ?? DEFAULT_HEADER);
        this.#settings.header = next;
        await this.#saveSetting('header', next);
        this.#lastPayload = '';
        this.#schedulePublish();
        const headerText = this.#renderHeader(next);
        // Templates and their result differ; showing both is what makes it obvious
        // that `{workspace}` is empty because privacy is masking it, not broken.
        await this.#notify('Discord Presence', next === ''
            ? 'Header hidden.'
            : next === headerText
                ? `Header: ${headerText}`
                : `Header: ${next} → ${headerText}`);
        return { header: next, headerText };
    }
    /**
     * Turns the agent-following logo off (or back on). Off means the configured
     * `largeImage` — or the shipped `orca` asset — is published instead.
     */
    async toggleDynamicLogo() {
        this.#settings.dynamicAgentImage = !this.#settings.dynamicAgentImage;
        await this.#saveSetting('dynamicAgentImage', this.#settings.dynamicAgentImage);
        this.#lastPayload = '';
        this.#schedulePublish();
        const latest = this.#settings.dynamicAgentImage ? latestAgent(this.#state) : null;
        await this.#notify('Discord Presence', this.#settings.dynamicAgentImage
            ? latest
                ? `Logo follows the latest agent: ${describeAgent(latest.agent)}.`
                : 'Logo follows the latest agent; no agent seen yet.'
            : 'Logo pinned to the configured image.');
        return {
            dynamicAgentImage: this.#settings.dynamicAgentImage,
            agent: latest?.agent ?? null
        };
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
    async reconnectNow() {
        if (this.#reconnectTimer) {
            clearTimeout(this.#reconnectTimer);
            this.#reconnectTimer = null;
        }
        this.#reconnectAttempt = 0;
        this.#lastPayload = '';
        this.#client?.close();
        this.#client = null;
        if (this.#settings.enabled && this.#settings.privacy !== 'off') {
            await this.#refreshFocus();
            await this.#publish();
        }
        return this.reportStatus();
    }
    async reportStatus() {
        // The command is an explicit request for current truth; do not make the
        // user wait for the next 30-second focus poll.
        await this.#refreshFocus();
        const summary = summarize(this.#state);
        const header = this.#settings.header ?? DEFAULT_HEADER;
        const headerText = this.#renderHeader(header);
        const largeImage = this.#settings.assets.largeImage ?? DEFAULT_LARGE_IMAGE;
        const smallImage = this.#settings.assets.smallImage ?? '';
        const agentImage = this.#agentImage();
        const latest = latestAgent(this.#state);
        const publishedImage = agentImage?.key || largeImage;
        const connection = this.#client?.connected
            ? `connected (${this.#client.socketPath})`
            : (this.#lastError ?? 'not connected');
        // Mirrors what would actually be published, workspace names included — the
        // point of the command is to show what Discord is being told.
        const body = [
            `${this.#settings.enabled ? 'Enabled' : 'Disabled'} · privacy: ${this.#settings.privacy}`,
            [
                headerText,
                describeActivity(summary, this.#visibleWorkspaces(summary), Date.now() - this.#sessionSince)
            ]
                .filter(Boolean)
                .join(' · '),
            this.#settings.dynamicAgentImage
                ? latest
                    ? `logo: ${publishedImage} (${describeAgent(latest.agent)})`
                    : `logo: ${publishedImage || 'off'} (no agent seen yet)`
                : `logo: ${publishedImage || 'off'}${smallImage ? ` · badge: ${smallImage}` : ''}`,
            connection
        ].join('\n');
        await this.#notify('Discord Presence', body);
        return {
            enabled: this.#settings.enabled,
            privacy: this.#settings.privacy,
            connected: Boolean(this.#client?.connected),
            socketPath: this.#client?.socketPath ?? null,
            usingDefaultApplication: this.#settings.clientId === DEFAULT_CLIENT_ID,
            header,
            headerText,
            sessionStartedAt: this.#sessionSince,
            largeImage,
            agent: latest?.agent ?? null,
            publishedImage,
            smallImage,
            summary,
            lastError: this.#lastError
        };
    }
    #renderHeader(template) {
        return renderHeader(template, {
            focus: this.#focus,
            state: this.#state,
            privacy: this.#settings.privacy
        });
    }
    /** Workspace names only leak into the status line at `full` privacy. */
    #visibleWorkspaces(summary) {
        return this.#settings.privacy === 'full' ? describeWorkspaces(this.#state, summary) : [];
    }
    async #clearPresence() {
        this.#lastPayload = '';
        if (!this.#client?.connected) {
            return;
        }
        try {
            await this.#client.setActivity(null);
        }
        catch (error) {
            this.#orca.log(`could not clear presence: ${describeError(error)}`);
        }
    }
    async #notify(title, body) {
        if (!this.#can('notifications:show')) {
            return;
        }
        try {
            await this.#orca.host.call('notifications.show', { title, body });
        }
        catch (error) {
            this.#orca.log(`${title}: ${body} (${describeError(error)})`);
        }
    }
    /** Graceful stop: drop the status first, then tear the connection down. */
    async shutdown() {
        if (this.#disposed) {
            return;
        }
        try {
            await this.#clearPresence();
        }
        catch {
            // Nothing actionable during teardown.
        }
        this.dispose();
    }
    dispose() {
        this.#disposed = true;
        if (this.#publishTimer) {
            clearTimeout(this.#publishTimer);
        }
        if (this.#reconnectTimer) {
            clearTimeout(this.#reconnectTimer);
        }
        if (this.#refreshTimer) {
            clearInterval(this.#refreshTimer);
        }
        this.#publishTimer = null;
        this.#reconnectTimer = null;
        this.#refreshTimer = null;
        this.#client?.close();
        this.#client = null;
    }
}
/** Terminals are irrelevant to the card, so they do not make a focus change. */
function sameFocus(left, right) {
    return ((left?.displayName.trim() ?? '') === (right?.displayName.trim() ?? '') &&
        (left?.branch.trim() ?? '') === (right?.branch.trim() ?? ''));
}
function describeError(error) {
    return error instanceof Error ? error.message : String(error);
}
/** A configured id wins; anything blank or non-string falls back to the default. */
function readClientId(configured) {
    if (typeof configured === 'string' && configured.trim().length > 0) {
        return configured.trim();
    }
    return DEFAULT_CLIENT_ID;
}
/**
 * Keeps `""` distinct from "absent": a blank string is how the settings file
 * turns the header or the logo off, whereas a missing key takes the default.
 */
function readOptionalString(configured) {
    return typeof configured === 'string' ? configured.trim() : undefined;
}
/**
 * Privacy level handed to the command. Same shapes as the header argument,
 * since both travel through Orca's `unknown` command argument; anything that
 * is not a known level means "no argument", which cycles instead.
 */
function readPrivacyArg(args) {
    if (isPrivacyLevel(args)) {
        return args;
    }
    if (typeof args === 'object' && args !== null) {
        const record = args;
        for (const key of ['privacy', 'level', 'value']) {
            const candidate = record[key];
            if (isPrivacyLevel(candidate)) {
                return candidate;
            }
        }
    }
    return undefined;
}
/**
 * Header handed to the command. Accepts a bare string or the object shapes a
 * host or keybinding is likely to send, since Orca's command arguments are
 * `unknown` by contract. `""` is a value, not an absence — it hides the header.
 */
function readHeaderArg(args) {
    if (typeof args === 'string') {
        return args.trim();
    }
    if (typeof args === 'object' && args !== null) {
        const record = args;
        for (const key of ['header', 'value', 'text']) {
            const candidate = record[key];
            if (typeof candidate === 'string') {
                return candidate.trim();
            }
        }
    }
    return undefined;
}
//# sourceMappingURL=main.mjs.map