/**
 * Validates `orca-plugin.json` against the host's manifest rules, transcribed
 * from Orca's `plugin-manifest.ts`, `plugin-manifest-fields.ts` and
 * `plugin-capabilities.ts`. A manifest that fails these is rejected at discovery
 * time, which is a much worse place to find out than here.
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const manifest = JSON.parse(
  readFileSync(fileURLToPath(new URL('../orca-plugin.json', import.meta.url)), 'utf8')
)

const PLUGIN_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const COMMAND_ID_RE = /^[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*$/
const SEMVER_RE = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const ENGINE_RE = /^>=\d+\.\d+\.\d+$/

const CAPABILITY_KINDS = [
  'workspace:read',
  'terminal:send',
  'notifications:show',
  'storage:own',
  'agent:read',
  'settings:own'
]
const EVENT_NAMES = ['workspace.created', 'workspace.removed', 'agent.status.changed']

test('identity fields match the host id grammar', () => {
  assert.equal(manifest.manifestVersion, 2)
  assert.equal(manifest.execution, 'trusted-worker')
  assert.equal(manifest.pluginApi, 1)
  assert.match(manifest.id, PLUGIN_ID_RE)
  assert.ok(manifest.id.length <= 64)
  assert.match(manifest.version, SEMVER_RE)
  assert.match(manifest.engines.orca, ENGINE_RE)
  assert.ok(manifest.name.length >= 1 && manifest.name.length <= 256)
  assert.ok((manifest.description ?? '').length <= 4096)
})

test('main entry is a portable relative path that exists in the build output', () => {
  assert.equal(typeof manifest.main, 'string')
  assert.ok(!manifest.main.startsWith('/'))
  assert.ok(!manifest.main.includes('..'))
  assert.ok(!manifest.main.includes('\\'), 'use forward slashes so the path is portable')
  // Orca installs the plugin directory as-is — there is no build step on the
  // host side, so the compiled entry has to be committed and present.
  assert.ok(
    existsSync(fileURLToPath(new URL(`../${manifest.main}`, import.meta.url))),
    `${manifest.main} is missing — run \`npm run build\``
  )
})

test('every declared capability is a known kind', () => {
  for (const capability of manifest.capabilities) {
    assert.deepEqual(Object.keys(capability), ['kind'], 'capability objects are strict')
    assert.ok(CAPABILITY_KINDS.includes(capability.kind), `unknown kind: ${capability.kind}`)
  }
})

test('capabilities cover exactly what the worker calls', () => {
  const declared = new Set(manifest.capabilities.map((entry) => entry.kind))
  for (const required of [
    'workspace:read',
    'agent:read',
    'storage:own',
    'settings:own',
    'notifications:show'
  ]) {
    assert.ok(declared.has(required), `missing capability: ${required}`)
  }
  // Nothing the plugin does needs these, and asking for them would show up in
  // the consent dialog as an unexplained ask.
  assert.ok(!declared.has('secrets'))
  assert.ok(!declared.has('terminal:send'))
})

const COMMAND_CONTEXTS = ['global', 'worktree']

test('command ids are portable and match what main.mjs registers', async () => {
  for (const command of manifest.contributes.commands) {
    assert.match(command.id, COMMAND_ID_RE)
    assert.ok(command.title.length >= 1 && command.title.length <= 256)
    // `context` is optional upstream and defaults to `global`; declaring it
    // keeps the palette entry and any user-assigned shortcut unambiguous.
    assert.ok(
      COMMAND_CONTEXTS.includes(command.when),
      `command ${command.id} needs a declared context`
    )
  }
  const source = readFileSync(fileURLToPath(new URL('../src/main.mts', import.meta.url)), 'utf8')
  for (const command of manifest.contributes.commands) {
    assert.ok(
      source.includes(`'${command.id}'`),
      `manifest declares ${command.id} but main.mjs never registers it`
    )
  }
})

test('no keybindings are contributed', () => {
  // Why this is asserted rather than merely absent: `contributes.keybindings`
  // is instructional content upstream, so declaring even one binds consent to
  // the plugin's tree hash — every release would then land as "Needs review"
  // in Settings → Plugins, and a chord colliding with another plugin's
  // disables *both* plugins' commands. Users bind their own chord under
  // Settings → Shortcuts → Plugins instead, which costs neither.
  assert.deepEqual(manifest.contributes.keybindings ?? [], [])
})

test('subscribed events are all real host events', () => {
  const subscribed = manifest.contributes.events.map((entry) => entry.on)
  assert.equal(new Set(subscribed).size, subscribed.length, 'no duplicate subscriptions')
  for (const name of subscribed) {
    assert.ok(EVENT_NAMES.includes(name), `unknown event: ${name}`)
  }
})

// --- marketplace index -------------------------------------------------------
// Rules from `plugin-marketplace.ts`. This repo doubles as its own marketplace
// source, so a malformed index means nobody can install the plugin at all.

const marketplace = JSON.parse(
  readFileSync(fileURLToPath(new URL('../orca-marketplace.json', import.meta.url)), 'utf8')
)

const MARKETPLACE_OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/
const CATEGORY_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
/** `UNSUPPORTED_MARKETPLACE_CATEGORIES` — a listing carrying one is hidden. */
const UNSUPPORTED_CATEGORIES = ['themes', 'icons', 'icon-themes', 'terminal-themes', 'skills']

test('marketplace index matches the host schema', () => {
  assert.deepEqual(Object.keys(marketplace).sort(), ['name', 'owner', 'plugins'], 'strict object')
  assert.ok(marketplace.name.length >= 1 && marketplace.name.length <= 256)
  assert.match(marketplace.owner, MARKETPLACE_OWNER_RE)
  assert.ok(Array.isArray(marketplace.plugins) && marketplace.plugins.length >= 1)

  const ids = marketplace.plugins.map((entry) => entry.id)
  assert.equal(new Set(ids).size, ids.length, 'no duplicate plugin ids')
})

test('marketplace entry points at this plugin over an allowed git URL', () => {
  const entry = marketplace.plugins.find(
    (plugin) => plugin.id.endsWith(`.${manifest.id}`)
  )
  assert.ok(entry, `no marketplace entry for ${manifest.id}`)
  assert.equal(entry.source.kind, 'git')
  // `isAllowedPluginGitUrl`: HTTPS or SSH only.
  assert.ok(
    entry.source.url.startsWith('https://') || entry.source.url.startsWith('ssh://') ||
      entry.source.url.startsWith('git@'),
    `git URL must use HTTPS or SSH: ${entry.source.url}`
  )
  // A named ref is required; the host resolves it to an exact commit at install.
  assert.ok(entry.source.ref.length >= 1)
  assert.equal(entry.source.url, `${manifest.repository}.git`, 'index and manifest disagree on the repo')
})

test('the marketplace ref pins a tag, not a moving branch', () => {
  const entry = marketplace.plugins.find(
    (plugin) => plugin.id.endsWith(`.${manifest.id}`)
  )
  // A branch ref re-resolves to whatever HEAD happens to be on the next
  // marketplace refresh, so users would silently drift onto unreleased commits.
  assert.match(
    entry.source.ref,
    /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/,
    `ref "${entry.source.ref}" must be a version tag`
  )
})

test('manifest, package, and release tag agree on the version', () => {
  const pkg = JSON.parse(
    readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')
  )
  const entry = marketplace.plugins.find(
    (plugin) => plugin.id.endsWith(`.${manifest.id}`)
  )
  // Three places to bump; forgetting one ships a tag whose contents disagree
  // with what the marketplace claims to be installing.
  assert.equal(pkg.version, manifest.version, 'package.json and orca-plugin.json disagree')
  assert.equal(entry.source.ref, `v${manifest.version}`, 'marketplace ref lags the manifest version')
})

test('the README tells users to pin the released tag', () => {
  const readme = readFileSync(fileURLToPath(new URL('../README.md', import.meta.url)), 'utf8')
  const entry = marketplace.plugins.find(
    (plugin) => plugin.id.endsWith(`.${manifest.id}`)
  )
  // Without the fragment Orca reads the index off the default branch, so a
  // README that lags the release quietly installs unreleased commits.
  const pinned = `${entry.source.url}#v${manifest.version}`
  assert.ok(readme.includes(pinned), `README should tell users to paste ${pinned}`)
})

test('marketplace categories are supported slugs', () => {
  for (const entry of marketplace.plugins) {
    for (const category of entry.categories ?? []) {
      assert.match(category, CATEGORY_RE)
      assert.ok(
        !UNSUPPORTED_CATEGORIES.includes(category),
        `category "${category}" makes the listing invisible in Orca`
      )
    }
  }
})
