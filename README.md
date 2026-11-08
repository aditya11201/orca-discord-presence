# Orca Discord Presence

Publishes your [Orca](https://github.com/stablyai/orca) agent fleet's activity to Discord, with the latest agent's name and artwork.

Maintained by [aditya11201](https://github.com/aditya11201), based on
[Lutica_CANARD's Orca Discord Presence](https://github.com/LuticaCANARD/orca-discord-presence).
The original copyright notice and MIT license remain in [LICENSE](LICENSE).

```text
┌──────┐  OpenCode 2                                       ← minimal (default)
│ logo │  Vibing · 2 agents from 2 worktrees · 1 blocked   (3 of 5)
└──────┘  00:14 elapsed

┌──────┐  OpenCode 2 - checkout service                    ← full
│ logo │  Vibing · 2 agents from 2 worktrees · 1 blocked   (3 of 5)
└──────┘  00:14 elapsed
```

Line one is the **header**, and it is yours to set. Line two is the fleet, ending in Discord's own party gauge: busy agents out of the agents Orca has announced. The timer uses a persisted timestamp that survives worker and agent changes and can continue across Orca restarts. Agent starts and stops do not reset it; without a reliable host app-session identity or start time, it does not measure the current Orca app's lifetime.

An agent counts as busy while it is `working`, `blocked`, or `waiting` — Orca renders the last two identically, as "agent needs user attention", so a fleet sitting on permission prompts keeps the timer running instead of reading as idle.

TypeScript, no runtime dependencies — the Discord Rich Presence IPC protocol is spoken directly over `node:net`.

## Requirements

- Orca `>= 1.4.246` for this manifest-v2 development version
- The Discord **desktop** app running on the same machine (the web client exposes no local IPC socket)

The default Discord application is **Orca ADE** (`1560068042283687946`). The plugin starts publishing as soon as an agent does something.

## Install

The repository's legacy `orca-marketplace.json` index pins the committed
manifest-v2 snapshot at
`50f63055ef98b062b18e3a9560997d5b90122ff9`. Orca's plugin-catalog docs say it
still falls back to this legacy format, but `orca plugin validate` accepts only
the newer `orca-catalog.json`; it does not validate `orca-marketplace.json`.
This repository index is not evidence of a community marketplace listing.

Install that exact snapshot with the documented CLI syntax:

```text
orca plugin install aditya11201/orca-discord-presence --ref 50f63055ef98b062b18e3a9560997d5b90122ff9
```

Installing plugin code requires approval in Orca. The pinned commit contains
manifest v2, version `0.2.0`. It is not a release and excludes uncommitted
review changes in this checkout. The existing `v0.2.0` tag points to the earlier
v1 manifest under the upstream identity, so do not use that tag for this
version. Replace this commit ref with a newly reviewed release tag only after
that tag exists.

## Privacy

**The default is `minimal`, and that is deliberate.** Branch names routinely carry ticket ids and client names, and a status that published them the moment you enabled the plugin would be a bad default.

| Level | Published |
| --- | --- |
| `full` | Agent and focused workspace (up to 64 characters), agent counts, and the workspaces agents are working in. Branches appear only when explicitly requested in a header template. |
| `minimal` *(default)* | Header and agent counts. Busy worktrees are counted, never named; `{workspace}` and `{branch}` in the header blank out |
| `off` | Nothing; the status is cleared |

Cycle levels with the **Cycle Privacy Level** command. The `minimal` masking is not a convention — tests assert that no project, branch, or workspace name reaches the payload at that level.

When multiple worktrees have working agents, the fleet reads `3 agents from 3 worktrees` instead of listing workspace names. A single named worktree can still appear at `full` privacy.

## Commands

| Command | Effect |
| --- | --- |
| `Discord Presence: Toggle` | Enable/disable publishing |
| `Discord Presence: Cycle Privacy Level` | Sets the level from the command's argument, or cycles `full` → `minimal` → `off` → … without one |
| `Discord Presence: Set Header` | Sets line one from the command's argument, or cycles the presets without one |
| `Discord Presence: Toggle Agent Logo` | Pins the logo to `largeImage`, or puts it back on following the latest agent |
| `Discord Presence: Reconnect` | Drops the Discord connection and publishes again immediately |
| `Discord Presence: Show Connection Status` | What is being published, the logo key, connection state, socket path, and the last error |

All of them persist. **Show Connection Status** is the first thing to reach for when something looks wrong — it reports why the last publish failed.

**Reconnect** is for the case the backoff cannot cover: Discord started after Orca, or restarted while the fleet was quiet. The plugin retries on its own, but only while its worker is alive, and Orca reaps an idle worker after five minutes (see [Known limitations](#known-limitations)). Running the command re-forks the worker *and* makes that fork connect straight away.

### Shortcuts

Every command shows up under **Settings → Shortcuts → Plugins**, where you can record a chord for the ones you reach for — `Toggle` and `Cycle Privacy Level` being the likely two.

**The plugin ships no default chords, deliberately.** A manifest keybinding is *instructional content* to Orca: declaring one binds your consent to the plugin's file tree, so every release would arrive as *Needs review* in Settings → Plugins, and a chord that collided with another plugin's would disable **both** plugins' commands. A shortcut you record yourself is an override — it survives updates and costs neither.

## Configuration

Every setting has a working default; this section is for changing them.

### The header

The **Set Header** command is the way in that does not involve a text editor:

- **With an argument** — the argument becomes the header, so a keybinding or automation can set it outright: `"My Fleet"`, or `{ "header": "My Fleet" }`. An empty string hides the header.
- **With no argument** — it cycles the presets, which is all the command palette can drive on its own:

  `{agent}` → `{workspace}` → `{workspace} · {branch}` → *hidden* → `{agent}` → …

`{workspace}` and `{branch}` resolve only at `full` privacy. At `minimal`, they blank out and take their separators with them. A template left with no visible text reads `AI Agent`, except the default `{agent}` header reads `Idle` when no agents are running.

`{agent}` shows the latest agent's display name, such as `OpenCode 2` or
`Oh My Pi (OMP)`. It follows the same pane as the dynamic logo and remains
available at `minimal` privacy or with artwork disabled. The default header
shows `Idle` when no agents are running, or `AI Agent` when an agent's identity is unknown.
Custom headers are preserved; include `{agent}` to make them agent-aware.

At `full`, the default details read `OpenCode 2 - Tracing log di production`.
Directory paths and branch refs are not appended. Workspace-name hyphens and
underscores become spaces; long details end in `...` within 64 characters.
The workspace reported by Orca is checked every **15 seconds**, plus publish
debouncing. Switching workspaces does not reset the elapsed timer.
The agent name and artwork use the latest identified pane in that workspace.
Opaque `term_` handles are resolved through `orca terminal list --json` to a
stable `worktreeId`, so display-name edits and branch switches do not break matching.
The installed Orca CLI must be available on the worker's PATH. Lookups have a
five-second timeout; if unavailable, matching falls back to legacy terminal ids
and a unique branch. Unknown or ambiguous workspaces show `AI Agent` and the
fallback logo rather than another workspace's agent.
At `minimal`, agent selection remains global and workspace names stay hidden.

### Working indicator

While at least one agent is `working`, the status cycles through working labels,
including `Vibing`, `Overthinking`, and `Hoping it compiles`, followed by the real
fleet counts. Labels advance in 15-second phases; the plugin refreshes every 15
seconds, so the visible change can lag by one refresh.
When no agent is working, the status shows the actual waiting, blocked, or idle
summary instead.

These are display-only labels, not agent thoughts or a task transcript. Prompt
text, reasoning, assistant messages, and tool output are not sent to Discord.

At `full` privacy, a working OMP agent can append its real tool intent instead
of the `in workspace` suffix: `Just vibing · 1 agent working · Checking ep GKE deployment state`.
This requires no OMP extension or configuration change. The plugin follows
`providerSession.transcriptPath` from Orca and reads only the `data.intent`
label of a current-turn `tool_execution_start` marker in the existing JSONL.
Only the last 128 KiB is inspected; missing, incomplete, or unreadable markers
fall back to the normal status. Labels are sanitized and limited to 64 characters.
The 20-second poll and existing agent events refresh them. Old-turn labels are
rejected, and a completed agent or session switch clears the previous label.
`minimal` privacy never publishes progress. Intent labels can contain task or
environment names, so use `minimal` if those should not be public.

### The logo and the badge

`largeImage` defaults to an `https://` image URL. Discord proxies and caches it, so the logos work without uploading art assets to the Discord application.

Point `clientId` at your own application and you can go back to asset keys: upload a logo under *Rich Presence → Art Assets* and set `largeImage` to its key.

`smallImage` is the badge in the logo's corner and is off by default. Set it to an uploaded asset key to show a badge. A badge is omitted when the large image is disabled.

### The party gauge

Discord renders `(3 of 5)` beside the status line: busy agents out of the panes Orca has reported a status for. It needs no configuration and carries no names, so it publishes at `full` and `minimal` alike, and disappears when nothing is busy — `(0 of 5)` reads as a broken party rather than as an idle fleet. The party id that accompanies it is random per worker and joinless: Rich Presence needs a join secret to put a **Join** button on your profile, which this plugin never sends.

### Publishing under your own Discord application

The name above the header belongs to the Discord application selected by `clientId`. This build uses **Orca ADE** by default. To use another name, rename an application you own in the Developer Portal, or select another application you own. Renaming the application does not change its id, so `clientId` can stay the same:

1. [Discord Developer Portal](https://discord.com/developers/applications) → **New Application**
2. Name it whatever the status should read as
3. Copy the **Application ID** from *General Information* into `clientId`
4. Optionally upload artwork under *Rich Presence → Art Assets* and set `largeImage` to its key. URL-based agent logos need no upload.

A Rich Presence application id is a public identifier — it travels in every client's IPC traffic and grants nothing on its own. The sensitive half is the OAuth client secret, which Rich Presence never needs and this plugin never asks for. That is why an id ships in the source.

### The settings file

Settings not covered by commands can be edited in the plugin's settings file. The plugin key depends on its installation source (`local.discord-presence` for a local folder, or `<repository-owner>.discord-presence` for a Git install):

| Platform | Path |
| --- | --- |
| Linux | `~/.config/Orca/plugins-data/<plugin-key>/settings.json` |
| macOS | `~/Library/Application Support/Orca/plugins-data/<plugin-key>/settings.json` |
| Windows | `%APPDATA%\Orca\plugins-data\<plugin-key>\settings.json` |

```json
{
  "enabled": true,
  "privacy": "minimal",
  "clientId": "1234567890123456789",
  "header": "{agent}",
  "largeImage": "orca",
  "largeText": "Orca",
  "smallImage": "",
  "smallText": ""
}
```

| Key | Default | Effect |
| --- | --- | --- |
| `enabled` | `true` | Publish at all |
| `privacy` | `"minimal"` | See [Privacy](#privacy) |
| `clientId` | Orca ADE application id | The Discord application to publish through |
| `header` | `"{agent}"` | Line one; takes `{agent}`, `{workspace}`, and `{branch}`; `""` hides it |
| `largeImage` | *(Orca logo URL)* | Asset key or `https://` image URL for the logo; `""` publishes no image |
| `largeText` | `"Orca"` | Tooltip when hovering the logo |
| `dynamicAgentImage` | `true` | Follow the latest agent's logo instead of the pinned one |
| `agentImages` | `{}` | Per-agent artwork: asset key or `https://` image URL |
| `agentStateDir` | *(resolved)* | Directory holding the host's `agent-hooks/` rows |
| `smallImage` | `""` *(off)* | Asset key or HTTPS image URL for the static corner badge |
| `workingSmallImage` | `""` *(off)* | Badge shown only while the displayed agent is `working`; falls back to `smallImage` otherwise |
| `smallText` | `""` | Tooltip when hovering the badge |

Every key is optional, and `""` means *off* rather than *default*. Restart Orca, or disable and re-enable the plugin, to pick the file up.

For an animated working badge, set `workingSmallImage` to a direct HTTPS GIF
or animated WebP URL. The large agent artwork is unchanged. At `full` privacy,
the badge follows the selected agent in the focused workspace, not other busy
workspaces. Waiting, blocked, and done agents use the static badge or no badge.
Discord plays the animation; the plugin does not send individual frames.

## The logo follows the agent

The plugin selects artwork from the most recent agent status update within the
focused workspace at `full`, or globally at `minimal`, and uses its name as hover text:

```text
┌──────────┐  Oh My Pi (OMP)
│  OMP     │  Vibing · 2 agents from 2 worktrees · 1 blocked   (3 of 5)
└──────────┘  00:14 elapsed
```

The next status update from OpenCode or OpenCode2 selects the OpenCode logo.
Opening or focusing a tab alone does not select its agent. Updates are coalesced
for 1.5 seconds and published no more than once every four seconds.

If the logo stays Orca, check `dynamicAgentImage` in the plugin's `settings.json`.
`false` pins the configured image, even after a plugin update. When it is `false`,
run **Discord Presence: Toggle Agent Logo** once to enable dynamic artwork.
Use **Reconnect** to publish immediately. If you edit the file instead, disable
and re-enable the plugin to load the changed setting.

### Where the agent id comes from

Orca's plugin events are a bounded four-field projection — `worktreeId`,
`paneKey`, `state`, `receivedAt` — and **drop agent identity**, so no event can
tell a plugin which agent is speaking. The host does persist it: every hook
event writes a row to `<userData>/agent-hooks/last-status.json`, keyed by pane
key, carrying the agent id in `payload.agentType` (with `agentPresence.agent`
and `source` as fallbacks). The plugin reads that file on each status change and
on the 20-second focus poll, and joins what it finds onto the panes it already
knows.

That file is a host implementation detail, not a contract, so the read is
defensive: absent, unreadable, oversized or reshaped all degrade to "no identity
known", which keeps the Orca logo and costs nothing else. If your `<userData>` is
somewhere unusual, set `agentStateDir`. Agent ids and fresh OMP progress labels
are extracted; `payload.prompt`, `lastAssistantMessage`, tool arguments, and
tool output are never copied into the presence.

### Artwork

| Setting | Default | Effect |
| --- | --- | --- |
| `dynamicAgentImage` | `true` | Follow the latest agent's logo |
| `agentImages` | `{}` | Per-agent artwork: asset key or `https://` image URL |
| `largeImage` | *(Orca logo URL)* | The pinned logo, used when the dynamic logo is off or an agent has no artwork |

Discord proxies an `https://` image URL once and caches it, so a URL and an
asset key published to the same application look the same afterwards. Five
agents ship with artwork, all verified to answer with an image content type:

| Agent | Default artwork |
| --- | --- |
| `opencode` · `opencode2` | `raw.githubusercontent.com/stablyai/orca/main/resources/opencode.webp` |
| `claude` | `raw.githubusercontent.com/stablyai/orca/main/resources/claude.webp` |
| `openclaude` | `raw.githubusercontent.com/stablyai/orca/main/resources/openclaude-logo.png` |
| `omp` | `https://omp.sh/og-image.png` |

An agent with no artwork of its own keeps `largeImage`, which is the safe
outcome: publishing an asset key your Discord application does not host renders
an empty square. Add your own under `agentImages`:

```json
{
  "agentImages": {
    "omp": "https://example.com/my-omp-logo.png",
    "codex": "codex-art"
  }
}
```

`agentImages` also wins over the built-ins, so a local upload to your own
application (Settings → Plugins → *your* application → Rich Presence → Art
Assets) replaces a URL with zero config elsewhere.

`largeImage: ""` still means "publish no image at all" and outranks the dynamic
logo; the agent hover text follows whichever image is published.

### Command

**Discord Presence: Toggle Agent Logo** pins the logo to `largeImage` or puts it
back on following the latest agent. **Show Connection Status** names the agent
whose artwork is live right now, which is the fastest way to see what the plugin
thinks is running.

## Capabilities requested

| Capability | Why |
| --- | --- |
| `workspace:read` | Focused workspace name and branch, for `full` privacy |
| `agent:read` | Agent status change events |
| `storage:own` | Fleet state survives worker restarts |
| `settings:own` | The plugin's own `enabled` / `privacy` / `clientId` / `header` / artwork keys |
| `notifications:show` | Command feedback |

`secrets:own` and `terminal:send` are deliberately **not** requested.

## Compatibility

The development manifest uses format 2 and requires Orca `>=1.4.246`.
Orca derives the plugin publisher from the installation source, so changing
from the legacy `lutica-canard.discord-presence` installation to a local
folder or a different Git owner creates a different settings and storage
location. Existing settings and elapsed time are not automatically transferred.

`orca-compatibility.json` records a historical v1 contract baseline, not a
verification of the migrated v2 manifest. Run `orca plugin validate .` to
check the current plugin manifest against the installed Orca host before release.
The CLI's catalog validation accepts only `orca-catalog.json`, not the legacy
`orca-marketplace.json` index.

## Known limitations

**The status is ephemeral by design.** Orca reaps a plugin worker after 5 minutes with no in-flight work (`PLUGIN_WORKER_IDLE_REAP_MS`) and re-forks it on the next event. A worker cannot keep itself alive — only host→worker traffic refreshes the idle clock. So the presence appears while your fleet is active, disappears after a few quiet minutes, and returns on the next agent event. Fleet state is persisted to plugin storage so nothing is lost across the gap, and statuses older than six hours are dropped rather than rehydrated as if still live.

**The focused workspace is polled.** The plugin checks `workspace.readContext` every 15 seconds and republishes changed details at `full`. Debouncing and Discord delivery add latency; **Show Connection Status** and **Reconnect** refresh the context immediately.

**Command arguments depend on the host.** **Set Header** accepts a string or `{ header }`, and **Cycle Privacy Level** a level or `{ privacy }`, when Orca passes an argument through. As of `1.4.192` no host path does: the palette and recorded shortcuts both invoke commands with no argument, even though the IPC carries one. Until that changes the cycles are the whole interface, and free-form headers go in the settings file.

**Linux socket discovery is heuristic.** Orca's worker environment is an allowlist that omits `XDG_RUNTIME_DIR`, so `/run/user/<uid>` is reconstructed from `process.getuid()`. Flatpak and Snap layouts are probed too.

**The agent id comes from a host implementation file.** No plugin event carries it, so it is read from `<userData>/agent-hooks/last-status.json`. Missing, oversized or reshaped all degrade to "no identity known" and the Orca logo stays, but an Orca that renames or stops writing that file would stop the logo following the agent — the presence itself would keep working. `agentStateDir` points elsewhere if the layout moves.

**The plugin API is EXPERIMENTAL upstream.** Orca's own docs promise no compatibility until `pluginApi` v1 freezes. Opening a local socket is possible today only because the capability model has no `net:*` kind yet — the source notes scoped kinds are planned. A future Orca may gate this, and the plugin would need a declared capability to keep working.

**Discord rate limits `SET_ACTIVITY`.** Updates are debounced (1.5s) with a 4s floor between publishes, and identical payloads are skipped entirely.

**The worker's own log is in Settings.** When **Show Connection Status** is not enough, Settings → Plugins → *View logs* shows what the worker logged — failed connects, capability denials, and rejected events all land there.

## Development

```bash
git clone https://github.com/aditya11201/orca-discord-presence.git
cd orca-discord-presence
npm install
npm run build      # tsc → dist/
npm test           # build + node --test
npm run typecheck  # no emit
```

Settings → Plugins → *Add development plugin* and pick the checkout directory to load it into Orca.

To watch a real publish against the Discord client on this machine:

```bash
node scripts/smoke-live.mjs            # the agent the file names as latest
node scripts/smoke-live.mjs omp        # force one agent's artwork
```

It connects to the real IPC socket, publishes one activity, and clears it three seconds later — which mutates your Discord profile for those three seconds, so it is deliberately outside `npm test`.

```text
orca-plugin.json            manifest (validated with `orca plugin validate .`)
orca-marketplace.json       marketplace index — lets this repo be its own source
orca-compatibility.json     reviewed Orca release and plugin-contract object ids
scripts/check-orca-compatibility.mjs
                            latest-release and main contract drift check
scripts/smoke-live.mjs      live publish against the running Discord client
src/main.mts                worker entry: activate/deactivate, commands, events
src/lib/orca-api.mts        hand-maintained types for Orca's plugin worker API
src/lib/presence-model.mts  pure state model — events in, activity payload out
src/lib/agent-identity.mts  agent id per pane, read from the host's status rows
src/lib/discord-ipc.mts     Rich Presence IPC client over node:net
src/lib/socket-path.mts     socket discovery across platforms and sandboxes
```

`dist/` **is committed on purpose.** Orca installs a plugin directory as-is with no build step on the host side, so the compiled entry has to be in the repository. CI fails the build when `dist/` and `src/` disagree.

Orca ships no types package for plugin authors, so `src/lib/orca-api.mts` transcribes the host's contracts (`plugin-host-api.ts`, `plugin-events.ts`, `plugin-capabilities.ts`). A type error there after an Orca upgrade is a real signal — read it before casting it away.

### Cutting a release

The repository's legacy index pins the committed v2 snapshot at
`50f63055ef98b062b18e3a9560997d5b90122ff9`; the install command above uses the
same immutable commit. The existing `v0.2.0` tag points to the earlier v1
manifest and must not be moved or reused.

For a later release, bump `package.json` and `orca-plugin.json` to a new,
unused version. Run `orca plugin validate .`, `npm test`, and
`npm run typecheck`, then review and publish the release under its matching
version tag. The GitHub workflow rebuilds the tag, checks for stale `dist/`,
runs `node --test`, verifies that the tag matches `orca-plugin.json`, and
creates the GitHub release. Once that reviewed tag exists, update
`orca-marketplace.json`'s `source.ref` and the install command's `--ref` above
to use it.

Keep `orca-marketplace.json` on the commit pin until then. Do not point it at a
moving branch.

## License

MIT. Original copyright © 2026 Lutica_CANARD; see [LICENSE](LICENSE).
