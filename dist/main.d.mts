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
import type { OrcaPluginApi } from './lib/orca-api.mjs';
import { type PresenceSummary, type PrivacyLevel } from './lib/presence-model.mjs';
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
export declare const DEFAULT_CLIENT_ID = "1534192299926360234";
export type PresenceStatusReport = {
    enabled: boolean;
    privacy: PrivacyLevel;
    connected: boolean;
    socketPath: string | null;
    /** False once `clientId` in settings points at the user's own application. */
    usingDefaultApplication: boolean;
    /** The header template as configured — may still hold `{workspace}`. */
    header: string;
    /** The header as published, tokens resolved against the current privacy. */
    headerText: string;
    /** Art asset key published as the large image; empty when turned off. */
    largeImage: string;
    /** Agent whose logo is published; `null` when the dynamic logo is off/unresolved. */
    agent: string | null;
    /** Art key or URL actually published as the logo. */
    publishedImage: string;
    /** Art asset key published as the badge; empty unless one is configured. */
    smallImage: string;
    summary: PresenceSummary;
    lastError: string | null;
};
export default function activate(orca: OrcaPluginApi): void;
export declare function deactivate(): Promise<void>;
