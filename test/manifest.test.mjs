import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const manifest = JSON.parse(
  readFileSync(fileURLToPath(new URL('../orca-plugin.json', import.meta.url)), 'utf8')
)
const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')
)
const marketplace = JSON.parse(
  readFileSync(fileURLToPath(new URL('../orca-marketplace.json', import.meta.url)), 'utf8')
)

const marketplaceEntry = marketplace.plugins.find(
  (plugin) => plugin.id === `${marketplace.owner}.${manifest.id}`
)
test('the manifest entry point exists in the committed plugin tree', () => {
  assert.ok(
    existsSync(fileURLToPath(new URL(`../${manifest.main}`, import.meta.url))),
    `${manifest.main} is missing: run \`npm run build\``
  )
})

test('capabilities include required worker access without terminal sending', () => {
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
  assert.ok(!declared.has('terminal:send'))
})

test('no keybindings are contributed', () => {
  // A manifest keybinding binds consent to the plugin's file tree and can
  // disable another plugin's command when a chord collides. Users bind their
  // own chords under Settings → Shortcuts → Plugins.
  assert.deepEqual(manifest.contributes.keybindings ?? [], [])
})

test('marketplace pins this repository to the committed v2 snapshot', () => {
  assert.ok(marketplaceEntry, `no marketplace entry for ${manifest.id}`)
  assert.equal(marketplaceEntry.source.kind, 'git')
  assert.equal(marketplaceEntry.source.url, `${manifest.repository}.git`)
  assert.equal(marketplaceEntry.source.ref, '50f63055ef98b062b18e3a9560997d5b90122ff9')
})

test('package and plugin manifest versions agree', () => {
  assert.equal(pkg.version, manifest.version)
})

