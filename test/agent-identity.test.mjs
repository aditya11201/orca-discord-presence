import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DEFAULT_AGENT_IMAGE_SOURCES,
  AGENT_STATE_FILE_NAME,
  readAgentIdentities,
  readAgentImages,
  resolveAgentImage,
  resolveAgentStateFile,
  resolveUserDataDir
} from '../dist/lib/agent-identity.mjs'

/** Mirrors the host's `agent-hooks/last-status.json` layout for one pane row. */
function writeStatusFile(dir, entries) {
  const hooks = join(dir, 'agent-hooks')
  mkdirSync(hooks, { recursive: true })
  writeFileSync(
    join(hooks, AGENT_STATE_FILE_NAME),
    JSON.stringify({ version: 2, entries }),
    'utf8'
  )
  return join(hooks, AGENT_STATE_FILE_NAME)
}

/**
 * A row shaped like the one the host writes: Orca persists every hook event,
 * keyed by pane key, with the agent id in `payload.agentType`. Prompt and
 * assistant-message fields are deliberately present to prove this module never
 * copies them out.
 */
function row({ agent, source, presenceAgent, receivedAt, prompt }) {
  return {
    paneKey: 'pane-1',
    source: source ?? 'hook',
    ...(presenceAgent ? { agentPresence: { agent: presenceAgent } } : {}),
    worktreeId: 'wt-1',
    ...(prompt
      ? {
          payload: {
            state: 'done',
            prompt,
            lastAssistantMessage: 'a secret answer',
            agentType: agent,
            receivedAt
          }
        }
      : { payload: { state: 'done', agentType: agent, receivedAt } })
  }
}

test('resolveUserDataDir follows the platform conventions', () => {
  assert.equal(
    resolveUserDataDir('darwin', { HOME: '/Users/someone' }),
    '/Users/someone/Library/Application Support/Orca'
  )
  assert.equal(
    resolveUserDataDir('win32', { USERPROFILE: 'C:\\Users\\someone' }),
    join('C:\\Users\\someone', 'AppData', 'Roaming', 'Orca')
  )
  assert.equal(resolveUserDataDir('linux', { HOME: '/home/someone' }), '/home/someone/.config/Orca')
  assert.equal(
    resolveUserDataDir('linux', { HOME: '/home/someone', XDG_CONFIG_HOME: '/xdg' }),
    '/xdg/Orca'
  )
  // No HOME at all is a valid configuration: the caller gets null, not a throw.
  assert.equal(resolveUserDataDir('darwin', {}), null)
})

test('resolveUserDataDir honours an absolute override', () => {
  assert.equal(resolveUserDataDir('darwin', { HOME: '/nope' }, '/custom/state'), '/custom/state')
  // A relative or absent override falls back to platform resolution.
  assert.equal(resolveUserDataDir('darwin', { HOME: '/home/x' }, 'relative'), '/home/x/Library/Application Support/Orca')
})

test('readAgentIdentities maps pane keys to the agent id', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-identity-'))
  writeStatusFile(dir, {
    'pane-1': row({ agent: 'opencode', receivedAt: 1000 }),
    'pane-2': row({ agent: 'omp', receivedAt: 2000, prompt: 'private prompt text' })
  })
  const identities = readAgentIdentities({ agentStateDir: dir })
  assert.deepEqual([...identities.entries()], [
    ['pane-1', { agent: 'opencode', receivedAt: 1000 }],
    ['pane-2', { agent: 'omp', receivedAt: 2000 }]
  ])
  // The row's prompt and assistant message must not survive the read.
  const serialized = JSON.stringify(identities)
  assert.ok(!serialized.includes('private prompt text'))
  assert.ok(!serialized.includes('secret answer'))
})

test('readAgentIdentities falls back to source and agentPresence.agent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-identity-'))
  writeStatusFile(dir, {
    'pane-1': row({ agent: undefined, source: 'claude' }),
    'pane-2': row({ agent: undefined, source: 'hook', presenceAgent: 'codex' })
  })
  const identities = readAgentIdentities({ agentStateDir: dir })
  assert.equal(identities.get('pane-1')?.agent, 'claude')
  assert.equal(identities.get('pane-2')?.agent, 'codex')
})

test('readAgentIdentities degrades to empty on every failure mode', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-identity-'))
  // Missing file: the normal state before the first agent runs.
  assert.equal(readAgentIdentities({ agentStateDir: dir }).size, 0)
  // Malformed JSON.
  writeStatusFile(dir, {}) && writeFileSync(join(dir, 'agent-hooks', AGENT_STATE_FILE_NAME), '{oops')
  assert.equal(readAgentIdentities({ agentStateDir: dir }).size, 0)
  // Oversized file.
  const big = mkdtempSync(join(tmpdir(), 'agent-identity-'))
  writeStatusFile(big, {})
  writeFileSync(join(big, 'agent-hooks', AGENT_STATE_FILE_NAME), 'x'.repeat(64), 'utf8')
  assert.equal(readAgentIdentities({ agentStateDir: big, maxBytes: 32 }).size, 0)
  // Rows without any agent id are skipped rather than published as "".
  const blank = mkdtempSync(join(tmpdir(), 'agent-identity-'))
  writeStatusFile(blank, { 'pane-1': { payload: { state: 'done' } } })
  assert.equal(readAgentIdentities({ agentStateDir: blank }).size, 0)
})

test('readAgentIdentities caps the number of rows', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-identity-'))
  const entries = {}
  for (let i = 0; i < 20; i++) {
    entries[`pane-${i}`] = row({ agent: 'opencode', receivedAt: i })
  }
  writeStatusFile(dir, entries)
  const identities = readAgentIdentities({ agentStateDir: dir, maxEntries: 5 })
  assert.equal(identities.size, 5)
})

test('resolveAgentImage prefers the override, then the built-in source, then the fallback', () => {
  const agentImages = { omp: 'https://example.com/my-omp.png' }
  assert.equal(
    resolveAgentImage('omp', { agentImages, fallbackImage: 'orca' }).key,
    'https://example.com/my-omp.png'
  )
  // A built-in source is only used when no override names that agent.
  assert.equal(
    resolveAgentImage('opencode', { agentImages, fallbackImage: 'orca' }).key,
    DEFAULT_AGENT_IMAGE_SOURCES['opencode']
  )
  // An unmapped agent keeps the fallback: publishing an asset key the Discord
  // application does not host would render an empty square.
  assert.deepEqual(resolveAgentImage('some-new-agent', { agentImages, fallbackImage: 'orca' }), {
    key: 'orca',
    text: 'some-new-agent'
  })
})

test('a rejected override falls through to the next source', () => {
  // A file path or a non-image URL would be sent to Discord as-is and rejected,
  // so it is ignored rather than published.
  assert.equal(
    resolveAgentImage('omp', { agentImages: { omp: '/tmp/logo.png' } }).key,
    DEFAULT_AGENT_IMAGE_SOURCES['omp']
  )
  assert.equal(
    resolveAgentImage('omp', { agentImages: { omp: 'https://example.com/logo.svg' } }).key,
    DEFAULT_AGENT_IMAGE_SOURCES['omp']
  )
  // For an agent with no built-in source, the rejected override lands on the
  // configured fallback rather than on a key nothing hosts.
  assert.deepEqual(
    resolveAgentImage('shepherd', { agentImages: { shepherd: '/tmp/x.png' }, fallbackImage: 'orca' }),
    { key: 'orca', text: 'shepherd' }
  )
})

test('readAgentImages keeps only usable entries', () => {
  assert.deepEqual(
    readAgentImages({
      omp: 'https://example.com/omp.png',
      opencode: 'my-asset',
      claude: 'https://example.com/claude.svg',
      broken: 42,
      nested: { deep: 'https://example.com/x.png' }
    }),
    { omp: 'https://example.com/omp.png', opencode: 'my-asset' }
  )
})

test('resolveAgentStateFile joins the host state path', () => {
  assert.equal(resolveAgentStateFile('/custom'), '/custom/agent-hooks/last-status.json')
  const home = process.env['HOME']
  if (typeof home === 'string' && home) {
    assert.equal(
      resolveAgentStateFile(undefined),
      join(home, 'Library', 'Application Support', 'Orca', 'agent-hooks', 'last-status.json')
    )
  }
})

test('every built-in image source is an https image url', () => {
  for (const [agent, url] of Object.entries(DEFAULT_AGENT_IMAGE_SOURCES)) {
    assert.match(url, /^https:\/\/\S+\.(?:png|jpe?g|gif|webp)$/i, `${agent} -> ${url}`)
  }
})
