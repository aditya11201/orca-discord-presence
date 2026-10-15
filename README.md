# Orca Discord Presence

Publishes your [Orca](https://github.com/stablyai/orca) agent fleet's activity to Discord, with the latest agent's name and artwork.

```text
┌──────┐  Orca · OpenCode 2                                 ← minimal (default)
│ logo │  2 agents working · 1 blocked · across 2 worktrees   (3 of 5)
└──────┘  00:14 elapsed

┌──────┐  Orca · OpenCode 2 · checkout-service · feat/ipc     ← full
│ logo │  2 agents working · 1 blocked · in checkout-service, web   (3 of 5)
└──────┘  00:14 elapsed
```

Line one is the **header**, and it is yours to set. Line two is the fleet, ending in Discord's own party gauge: busy agents out of the agents Orca has announced. The timer measures the current stretch of work, not how long Orca has been open.

An agent counts as busy while it is `working`, `blocked`, or `waiting` — Orca renders the last two identically, as "agent needs user attention", so a fleet sitting on permission prompts keeps the timer running instead of reading as idle.

TypeScript, no runtime dependencies — the Discord Rich Presence IPC protocol is spoken directly over `node:net`.

## Requirements

- Orca `>= 1.4.0` with the plugin system enabled (Settings → Plugins) — last verified against Orca `1.4.192`, see [Compatibility](#compatibility)
- The Discord **desktop** app running on the same machine (the web client exposes no local IPC socket)

Nothing else. The plugin ships with a Discord application id and starts publishing as soon as an agent does something.

## Install

Settings → Plugins → *Add marketplace*, paste the URL, and accept the consent dialog:

```text
https://github.com/LuticaCANARD/orca-discord-presence.git#v0.2.0
```

The `#v0.2.0` matters: without it Orca reads the index off `main`, which moves. The dialog lists the [capabilities](#capabilities-requested) below. To hack on the plugin instead, see [Development](#development).

## Privacy

**The default is `minimal`, and that is deliberate.** Branch names routinely carry ticket ids and client names, and a status that published them the moment you enabled the plugin would be a bad default.

| Level | Published |
| --- | --- |
| `full` | Header, focused workspace, branch, agent counts, and the workspaces agents are working in |
| `minimal` *(default)* | Header and agent counts. Busy worktrees are counted, never named; `{workspace}` and `{branch}` in the header blank out |
| `off` | Nothing; the status is cleared |

Cycle levels with the **Cycle Privacy Level** command. The `minimal` masking is not a convention — tests assert that no project, branch, or workspace name reaches the payload at that level.

Workspace names come from the worktree's directory name, falling back to its branch. Only worktrees Orca announced while the plugin was running can be named, so a `full` status degrades to `across 2 worktrees` rather than going blank, and long lists collapse to `in api, cli, docs +2`.

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

  `Orca · {agent}` → `{workspace}` → `{workspace} · {branch}` → *hidden* → `Orca · {agent}` → …

`{workspace}` and `{branch}` are resolved at publish time, not frozen into the setting, and that distinction is the whole point. A header of `checkout-service` keeps publishing that name after a drop to `minimal`; `{workspace}` blanks out and falls back to `Orca`. A token that resolves to nothing takes its separator with it, so the line never trails a stray middle dot.

`{agent}` shows the latest agent's display name, such as `OpenCode 2` or
`Oh My Pi (OMP)`. It follows the same pane as the dynamic logo and remains
available at `minimal` privacy or with artwork disabled. If no identity is
known, the agent segment disappears and the default header reads `Orca`.
Custom headers are preserved; include `{agent}` to make them agent-aware.

### The logo and the badge

`largeImage` defaults to **an `https://` image URL**, not an asset key — Discord proxies the URL once, caches it, and renders it like uploaded art. That is deliberate: the shipped application hosts **no** artwork, so an earlier default of the key `orca` rendered Discord's missing-asset placeholder (a question mark) on a fresh install.

Point `clientId` at your own application and you can go back to asset keys: upload a logo under *Rich Presence → Art Assets* and set `largeImage` to its key.

`smallImage` is the badge in the logo's corner, and it is **off by default** — neither the shipped application nor the dynamic agent artwork hosts a badge, so a default would publish an empty square. Upload one to your own application and name its key to turn it on; a badge with no logo to sit on is dropped rather than published alone.

### The party gauge

Discord renders `(3 of 5)` beside the status line: busy agents out of the panes Orca has reported a status for. It needs no configuration and carries no names, so it publishes at `full` and `minimal` alike, and disappears when nothing is busy — `(0 of 5)` reads as a broken party rather than as an idle fleet. The party id that accompanies it is random per worker and joinless: Rich Presence needs a join secret to put a **Join** button on your profile, which this plugin never sends.

### Publishing under your own Discord application

The line *above* the header reads *"Playing \<application name\>"*, and that name belongs to the Discord application, not to this plugin — Rich Presence IPC has no field for it. That is what `header` exists for: it is the topmost line a plugin can control. To change the *"Playing …"* line itself, publish through an application of your own:

1. [Discord Developer Portal](https://discord.com/developers/applications) → **New Application**
2. Name it whatever the status should read as
3. Copy the **Application ID** from *General Information* into `clientId`
4. Upload artwork under *Rich Presence → Art Assets*, then set `largeImage` to its key

A Rich Presence application id is a public identifier — it travels in every client's IPC traffic and grants nothing on its own. The sensitive half is the OAuth client secret, which Rich Presence never needs and this plugin never asks for. That is why an id ships in the source.

### The settings file

Orca has no UI for per-plugin settings yet, so anything the commands do not cover is written by hand:

| Platform | Path |
| --- | --- |
| Linux | `~/.config/Orca/plugins-data/lutica-canard.discord-presence/settings.json` |
| macOS | `~/Library/Application Support/Orca/plugins-data/lutica-canard.discord-presence/settings.json` |
| Windows | `%APPDATA%\Orca\plugins-data\lutica-canard.discord-presence\settings.json` |

```json
{
  "enabled": true,
  "privacy": "minimal",
  "clientId": "1234567890123456789",
  "header": "Orca · {agent}",
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
| `clientId` | shipped id | The Discord application to publish through |
| `header` | `"Orca · {agent}"` | Line one; takes `{agent}`, `{workspace}`, and `{branch}`; `""` hides it |
| `largeImage` | *(Orca logo URL)* | Asset key or `https://` image URL for the logo; `""` publishes no image |
| `largeText` | `"Orca"` | Tooltip when hovering the logo |
| `dynamicAgentImage` | `true` | Follow the latest agent's logo instead of the pinned one |
| `agentImages` | `{}` | Per-agent artwork: asset key or `https://` image URL |
| `agentStateDir` | *(resolved)* | Directory holding the host's `agent-hooks/` rows |
| `smallImage` | `""` *(off)* | Art asset key for the badge in the logo's corner |
| `smallText` | `""` | Tooltip when hovering the badge |

Every key is optional, and `""` means *off* rather than *default*. Restart Orca, or disable and re-enable the plugin, to pick the file up.

## The logo follows the agent

The plugin selects the logo from the most recent agent status update, per pane
rather than per worktree, and uses the agent's name as the hover text:

```text
┌──────────┐  Orca · Oh My Pi (OMP)
│  OMP     │  2 agents working · 1 blocked · across 2 worktrees   (3 of 5)
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
on the 30-second focus poll, and joins what it finds onto the panes it already
knows.

That file is a host implementation detail, not a contract, so the read is
defensive: absent, unreadable, oversized or reshaped all degrade to "no identity
known", which keeps the Orca logo and costs nothing else. If your `<userData>` is
somewhere unusual, set `agentStateDir`. Only the agent id is ever extracted —
`payload.prompt` and `lastAssistantMessage` are never copied, logged or
published.

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
| `events:subscribe` | Worktree lifecycle and agent status changes — the data being published |
| `storage` | Fleet state survives worker reaps (see below) |
| `settings:own` | The plugin's own `enabled` / `privacy` / `clientId` / `header` / artwork keys |
| `notifications:show` | Command feedback |

`secrets` and `terminal:send` are deliberately **not** requested.

## Compatibility

Checked on 2026-08-30 against every stable desktop release after the previous `v1.4.185` checkpoint: [`v1.4.186`](https://github.com/stablyai/orca/releases/tag/v1.4.186), [`v1.4.187`](https://github.com/stablyai/orca/releases/tag/v1.4.187), [`v1.4.188`](https://github.com/stablyai/orca/releases/tag/v1.4.188), [`v1.4.190`](https://github.com/stablyai/orca/releases/tag/v1.4.190), [`v1.4.191`](https://github.com/stablyai/orca/releases/tag/v1.4.191), and the latest [`v1.4.192`](https://github.com/stablyai/orca/releases/tag/v1.4.192). There was no stable `v1.4.189` release.

Those releases substantially improved agent-status correctness, worktree identity across hosts, remote/SSH recovery, terminal sessions, native chat, automations, and WSL behavior. The presence benefits from the corrected events automatically. Orca also added an internal `workingMode: "monitoring"`, but the plugin event remains a deliberately bounded four-field projection, so this plugin cannot distinguish foreground work from background monitoring yet.

The ten upstream files this plugin depends on are byte-identical at `v1.4.185`, `v1.4.192`, and Orca `main` commit `d607a63670d504763262daa9df335baac4eea8be` observed on 2026-08-30. `main` still carries its independent `1.4.178-rc.2` package version, so source identity—not that package number—is the useful comparison. The engine floor stays `>=1.4.0`: no public plugin contract used here has moved since the plugin system landed.

Re-read upstream and found unchanged — these are the contracts `src/lib/orca-api.mts` transcribes:

| Upstream contract | State |
| --- | --- |
| Host API v0 method table (`plugin-host-api.ts`) | 13 methods, all still `experimental`; `workspace.readContext` still returns `{ branch, displayName, terminals }` |
| Event set (`plugin-events.ts`) | Still the three worktree/agent events — no focus-change event |
| Capability kinds (`plugin-capabilities.ts`) | Still seven unscoped kinds; still no `net:*` |
| Agent states (`agent-status-types.ts`) | Still `working` / `blocked` / `waiting` / `done`; new internal monitoring and per-turn fields do not reach the plugin event payload |
| Worker environment (`plugin-worker-env.ts`) | Still an allowlist without `XDG_RUNTIME_DIR` |
| Idle reap (`plugin-host-protocol.ts`) | Still 5 minutes |
| Settings and storage location | Still `<userData>/plugins-data/<publisher>.<id>/` |
| Manifest and marketplace schemas | Unchanged; `commands[].context` is declared here |

`orca-compatibility.json` records the reviewed Git blob ids. The read-only **Orca compatibility** workflow checks the latest stable release and `main` every Monday; it fails on any new stable version—even if the files are unchanged—or on contract drift in either ref, forcing this section and the handwritten API types to be reviewed. Run the same check locally with `npm run check:orca-compatibility` (network access to the public GitHub API is required).

Contribution kinds the manifest could carry and deliberately does not:

- **`keybindings`** — see [Shortcuts](#shortcuts).
- **`panels`** — a sandboxed panel may call only `workspace.readContext`, `terminal.sendText`, and `notifications.show`. Plugin storage and settings are worker-only, so a presence panel could not read what the plugin is publishing; there is nothing to render yet.
- **`languagePacks`, `vmRecipes`, `agents`** — content packs for other kinds of plugin.
- **`icon`** — the host validates it, but nothing surfaces it in the plugin list yet.

## Known limitations

**The status is ephemeral by design.** Orca reaps a plugin worker after 5 minutes with no in-flight work (`PLUGIN_WORKER_IDLE_REAP_MS`) and re-forks it on the next event. A worker cannot keep itself alive — only host→worker traffic refreshes the idle clock. So the presence appears while your fleet is active, disappears after a few quiet minutes, and returns on the next agent event. Fleet state is persisted to plugin storage so nothing is lost across the gap, and statuses older than six hours are dropped rather than rehydrated as if still live.

**The focused workspace is polled, not pushed.** Orca emits no focus-change event, so `full` privacy refreshes and republishes the workspace and branch every 30 seconds. **Show Connection Status** and **Reconnect** refresh it immediately.

**Command arguments depend on the host.** **Set Header** accepts a string or `{ header }`, and **Cycle Privacy Level** a level or `{ privacy }`, when Orca passes an argument through. As of `1.4.192` no host path does: the palette and recorded shortcuts both invoke commands with no argument, even though the IPC carries one. Until that changes the cycles are the whole interface, and free-form headers go in the settings file.

**Linux socket discovery is heuristic.** Orca's worker environment is an allowlist that omits `XDG_RUNTIME_DIR`, so `/run/user/<uid>` is reconstructed from `process.getuid()`. Flatpak and Snap layouts are probed too.

**The agent id comes from a host implementation file.** No plugin event carries it, so it is read from `<userData>/agent-hooks/last-status.json`. Missing, oversized or reshaped all degrade to "no identity known" and the Orca logo stays, but an Orca that renames or stops writing that file would stop the logo following the agent — the presence itself would keep working. `agentStateDir` points elsewhere if the layout moves.

**The plugin API is EXPERIMENTAL upstream.** Orca's own docs promise no compatibility until `pluginApi` v1 freezes. Opening a local socket is possible today only because the capability model has no `net:*` kind yet — the source notes scoped kinds are planned. A future Orca may gate this, and the plugin would need a declared capability to keep working.

**Discord rate limits `SET_ACTIVITY`.** Updates are debounced (1.5s) with a 4s floor between publishes, and identical payloads are skipped entirely.

**The worker's own log is in Settings.** When **Show Connection Status** is not enough, Settings → Plugins → *View logs* shows what the worker logged — failed connects, capability denials, and rejected events all land there.

## Development

```bash
git clone https://github.com/LuticaCANARD/orca-discord-presence.git
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
orca-plugin.json            manifest (validated against the host schema by a test)
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

Four places carry the version, and a test fails if they disagree:

1. `package.json` → `version`
2. `orca-plugin.json` → `version`
3. `orca-marketplace.json` → `plugins[].source.ref` (as `v<version>`)
4. `README.md` → the install URL's `#v<version>` fragment

Then `npm run build`, commit, and push a matching tag:

```bash
git tag v0.1.0 && git push origin v0.1.0
```

The release workflow re-runs typecheck, build, the stale-`dist/` check and the tests, verifies the tag matches the manifest, and publishes a GitHub release.

The marketplace listing pins a **release tag**, not `main` — a branch ref would re-resolve to whatever HEAD happens to be on the next marketplace refresh, quietly moving users onto unreleased commits. A test enforces that the ref is a tag and that it matches the manifest version.

## License

MIT
