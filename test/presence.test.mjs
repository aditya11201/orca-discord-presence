import assert from 'node:assert/strict'
import test from 'node:test'

import {
  activityCommandArgs,
  createFrameDecoder,
  encodeFrame,
  OP
} from '../dist/lib/discord-ipc.mjs'
import { candidateSocketPaths, posixRuntimeBases } from '../dist/lib/socket-path.mjs'
import {
  applyAgentIdentities,
  applyAgentStatus,
  applyWorktreeCreated,
  applyWorktreeRemoved,
  buildActivity,
  busyCount,
  createPresenceState,
  DEFAULT_HEADER,
  DEFAULT_LARGE_IMAGE,
  DEFAULT_LARGE_TEXT,
  deserializeState,
  describeActivity,
  describeWorkspaces,
  HEADER_PRESETS,
  isBusy,
  latestAgent,
  nextHeader,
  nextPrivacy,
  pruneStale,
  renderHeader,
  serializeState,
  STALE_STATUS_MS,
  summarize
} from '../dist/lib/presence-model.mjs'

test('encodeFrame writes an 8-byte little-endian header', () => {
  const frame = encodeFrame(OP.HANDSHAKE, { v: 1 })
  assert.equal(frame.readInt32LE(0), OP.HANDSHAKE)
  assert.equal(frame.readInt32LE(4), frame.length - 8)
  assert.deepEqual(JSON.parse(frame.subarray(8).toString('utf8')), { v: 1 })
})

test('clearing an activity keeps the explicit null on the Discord wire', () => {
  const payload = {
    cmd: 'SET_ACTIVITY',
    args: activityCommandArgs(null, 42)
  }
  const frame = encodeFrame(OP.FRAME, payload)
  assert.deepEqual(JSON.parse(frame.subarray(8).toString('utf8')), {
    cmd: 'SET_ACTIVITY',
    args: { pid: 42, activity: null }
  })
})

test('decoder reassembles a frame split across chunks', () => {
  const decode = createFrameDecoder()
  const frame = encodeFrame(OP.FRAME, { cmd: 'SET_ACTIVITY' })
  assert.deepEqual(decode(frame.subarray(0, 5)), [])
  assert.deepEqual(decode(frame.subarray(5, 11)), [])
  const done = decode(frame.subarray(11))
  assert.equal(done.length, 1)
  assert.equal(done[0].op, OP.FRAME)
  assert.deepEqual(done[0].data, { cmd: 'SET_ACTIVITY' })
})

test('decoder splits multiple frames coalesced into one chunk', () => {
  const decode = createFrameDecoder()
  const chunk = Buffer.concat([
    encodeFrame(OP.PING, { n: 1 }),
    encodeFrame(OP.FRAME, { evt: 'READY' })
  ])
  const frames = decode(chunk)
  assert.equal(frames.length, 2)
  assert.equal(frames[0].op, OP.PING)
  assert.equal(frames[1].data.evt, 'READY')
})

test('decoder rejects an implausible frame length instead of buffering forever', () => {
  const decode = createFrameDecoder()
  const bogus = Buffer.alloc(8)
  bogus.writeInt32LE(OP.FRAME, 0)
  bogus.writeInt32LE(64 * 1024 * 1024, 4)
  assert.throws(() => decode(bogus), /refusing frame/)
})

test('linux runtime bases include the uid path even without XDG_RUNTIME_DIR', () => {
  const bases = posixRuntimeBases({ env: { TMPDIR: '/tmp' }, uid: 1000 })
  assert.ok(bases.includes('/run/user/1000'), `missing uid base: ${bases.join(', ')}`)
})

test('candidate paths cover flatpak and snap layouts', () => {
  const paths = candidateSocketPaths({ platform: 'linux', env: {}, uid: 1000 })
  assert.ok(paths.includes('/run/user/1000/discord-ipc-0'))
  assert.ok(paths.includes('/run/user/1000/app/com.discordapp.Discord/discord-ipc-0'))
  assert.ok(paths.includes('/run/user/1000/snap.discord/discord-ipc-0'))
})

test('windows candidates are named pipes', () => {
  const paths = candidateSocketPaths({ platform: 'win32' })
  assert.equal(paths.length, 10)
  assert.equal(paths[0], '\\\\?\\pipe\\discord-ipc-0')
})

test('summarize counts panes by state and distinct busy worktrees', () => {
  const state = createPresenceState()
  applyAgentStatus(state, { paneKey: 'a', worktreeId: 'w1', state: 'working', receivedAt: 1 })
  applyAgentStatus(state, { paneKey: 'b', worktreeId: 'w2', state: 'working', receivedAt: 1 })
  applyAgentStatus(state, { paneKey: 'c', worktreeId: 'w2', state: 'blocked', receivedAt: 1 })
  applyAgentStatus(state, { paneKey: 'd', worktreeId: null, state: 'done', receivedAt: 1 })
  const summary = summarize(state)
  assert.equal(summary.working, 2)
  assert.equal(summary.blocked, 1)
  assert.equal(summary.done, 1)
  assert.equal(summary.activeWorktrees, 2)
})

test('a later status for the same pane replaces the earlier one', () => {
  const state = createPresenceState()
  applyAgentStatus(state, { paneKey: 'a', worktreeId: 'w1', state: 'working', receivedAt: 1 })
  applyAgentStatus(state, { paneKey: 'a', worktreeId: 'w1', state: 'done', receivedAt: 2 })
  assert.equal(summarize(state).working, 0)
  assert.equal(summarize(state).done, 1)
})

test('unknown states are ignored rather than counted', () => {
  const state = createPresenceState()
  applyAgentStatus(state, { paneKey: 'a', worktreeId: 'w1', state: 'exploded', receivedAt: 1 })
  assert.equal(summarize(state).panes, 0)
})

test('removing a worktree drops its panes', () => {
  const state = createPresenceState()
  applyWorktreeCreated(state, { worktreeId: 'w1', path: '/repos/app', branch: 'main' })
  applyAgentStatus(state, { paneKey: 'a', worktreeId: 'w1', state: 'working', receivedAt: 1 })
  applyWorktreeRemoved(state, { worktreeId: 'w1', path: '/repos/app' })
  assert.equal(summarize(state).panes, 0)
  assert.equal(summarize(state).worktrees, 0)
})

test('stale statuses are pruned', () => {
  const now = 1_000_000_000
  const state = createPresenceState()
  applyAgentStatus(state, { paneKey: 'fresh', worktreeId: 'w', state: 'working', receivedAt: now })
  applyAgentStatus(state, {
    paneKey: 'old',
    worktreeId: 'w',
    state: 'working',
    receivedAt: now - STALE_STATUS_MS - 1
  })
  pruneStale(state, now)
  assert.equal(summarize(state).working, 1)
})

test('state round-trips through storage serialization', () => {
  const state = createPresenceState()
  applyWorktreeCreated(state, { worktreeId: 'w1', path: '/repos/app', branch: 'feat/x' })
  applyAgentStatus(state, { paneKey: 'a', worktreeId: 'w1', state: 'blocked', receivedAt: 7 })
  const restored = deserializeState(JSON.parse(JSON.stringify(serializeState(state))))
  assert.deepEqual(summarize(restored), summarize(state))
  assert.equal(restored.worktrees.get('w1').branch, 'feat/x')
})

test('deserialize tolerates garbage', () => {
  assert.equal(summarize(deserializeState(null)).panes, 0)
  assert.equal(summarize(deserializeState({ panes: { a: 'nope' } })).panes, 0)
  assert.equal(summarize(deserializeState({ worktrees: 5 })).worktrees, 0)
})

test('describeActivity reads naturally at each fleet size', () => {
  const state = createPresenceState()
  assert.equal(describeActivity(summarize(state)), 'No agents running')

  applyAgentStatus(state, { paneKey: 'a', worktreeId: 'w1', state: 'done', receivedAt: 1 })
  assert.equal(describeActivity(summarize(state)), 'Fleet idle')

  applyAgentStatus(state, { paneKey: 'b', worktreeId: 'w1', state: 'working', receivedAt: 1 })
  assert.equal(describeActivity(summarize(state)), '1 agent working')

  applyAgentStatus(state, { paneKey: 'c', worktreeId: 'w2', state: 'working', receivedAt: 1 })
  assert.equal(describeActivity(summarize(state)), '2 agents working · across 2 worktrees')

  applyAgentStatus(state, { paneKey: 'd', worktreeId: 'w2', state: 'blocked', receivedAt: 1 })
  assert.equal(describeActivity(summarize(state)), '2 agents working · 1 blocked · across 2 worktrees')

  applyAgentStatus(state, { paneKey: 'e', worktreeId: 'w2', state: 'waiting', receivedAt: 1 })
  assert.equal(
    describeActivity(summarize(state)),
    '2 agents working · 1 blocked · 1 waiting · across 2 worktrees'
  )
})

test('a fleet waiting on the user is not idle', () => {
  // Orca maps `waiting` and `blocked` alike onto "agent needs user attention",
  // so a fleet sitting on permission prompts must not read as "Fleet idle".
  const state = createPresenceState()
  applyAgentStatus(state, { paneKey: 'a', worktreeId: 'w1', state: 'waiting', receivedAt: 1 })
  const summary = summarize(state)
  assert.equal(isBusy(summary), true)
  assert.equal(busyCount(summary), 1)
  assert.equal(describeActivity(summary), '1 waiting')

  applyAgentStatus(state, { paneKey: 'a', worktreeId: 'w1', state: 'done', receivedAt: 1 })
  assert.equal(isBusy(summarize(state)), false)
})

test('the party size gauges busy agents against the fleet', () => {
  const state = createPresenceState()
  applyAgentStatus(state, { paneKey: 'a', worktreeId: 'w1', state: 'working', receivedAt: 1 })
  applyAgentStatus(state, { paneKey: 'b', worktreeId: 'w1', state: 'waiting', receivedAt: 1 })
  applyAgentStatus(state, { paneKey: 'c', worktreeId: 'w2', state: 'done', receivedAt: 1 })

  const activity = buildActivity({ state, focus: null, privacy: 'minimal', partyId: 'party-1' })
  assert.deepEqual(activity.party, { id: 'party-1', size: [2, 3] })

  // Counts are not names: the gauge is published at every level that publishes
  // at all, and carries nothing `minimal` masks.
  const full = buildActivity({ state, focus: null, privacy: 'full', partyId: 'party-1' })
  assert.deepEqual(full.party, activity.party)

  // Without an id Discord still gets a size; the id is only a party handle.
  assert.deepEqual(buildActivity({ state, focus: null, privacy: 'minimal' }).party, { size: [2, 3] })
})

test('an idle fleet publishes no party at all', () => {
  const state = createPresenceState()
  assert.equal(buildActivity({ state, focus: null, privacy: 'minimal' }).party, undefined)

  applyAgentStatus(state, { paneKey: 'a', worktreeId: 'w1', state: 'done', receivedAt: 1 })
  // `(0 of 1)` would read as a broken party rather than as an idle fleet.
  assert.equal(buildActivity({ state, focus: null, privacy: 'minimal' }).party, undefined)
})

test('a badge is published only when one is configured, and needs a logo', () => {
  const state = createPresenceState()
  applyAgentStatus(state, { paneKey: 'a', worktreeId: 'w1', state: 'working', receivedAt: 1 })
  const input = { state, focus: null, privacy: 'minimal' }

  // Nothing configured: the shipped application hosts no badge artwork, so
  // publishing a key would render an empty square.
  assert.equal(buildActivity(input).assets.small_image, undefined)

  const badged = buildActivity({ ...input, assets: { smallImage: 'busy', smallText: 'Fleet busy' } })
  assert.equal(badged.assets.small_image, 'busy')
  assert.equal(badged.assets.small_text, 'Fleet busy')

  // A badge without a logo has nothing to sit on and is dropped.
  const noLogo = buildActivity({ ...input, assets: { largeImage: '', smallImage: 'busy' } })
  assert.equal(noLogo.assets, undefined)
})

test('minimal privacy publishes no project or branch name', () => {
  const state = createPresenceState()
  applyWorktreeCreated(state, { worktreeId: 'w1', path: '/repos/secret-client', branch: 'feat/acme-migration' })
  applyAgentStatus(state, { paneKey: 'a', worktreeId: 'w1', state: 'working', receivedAt: 1 })
  const activity = buildActivity({
    state,
    focus: { displayName: 'secret-client', branch: 'feat/acme-migration' },
    privacy: 'minimal',
    startedAt: 1000
  })
  const encoded = JSON.stringify(activity)
  assert.ok(!encoded.includes('secret-client'), encoded)
  assert.ok(!encoded.includes('acme'), encoded)
  assert.equal(activity.state, '1 agent working')
})

test('full privacy publishes header, project and branch', () => {
  const state = createPresenceState()
  applyAgentStatus(state, { paneKey: 'a', worktreeId: 'w1', state: 'working', receivedAt: 1 })
  const activity = buildActivity({
    state,
    focus: { displayName: 'checkout-service', branch: 'main' },
    privacy: 'full',
    header: 'Fleet',
    startedAt: 1000
  })
  assert.equal(activity.details, 'Fleet · checkout-service · main')
  assert.equal(activity.timestamps.start, 1000)
})

test('a project matching the header is not repeated', () => {
  const state = createPresenceState()
  const activity = buildActivity({
    state,
    focus: { displayName: 'orca', branch: 'main' },
    privacy: 'full',
    startedAt: 0
  })
  assert.equal(activity.details, 'Orca · main')
})

test('header tokens resolve at full privacy', () => {
  const state = createPresenceState()
  const context = {
    focus: { displayName: 'checkout-service', branch: 'feat/ipc' },
    state,
    privacy: 'full'
  }
  assert.equal(renderHeader('{workspace}', context), 'checkout-service')
  assert.equal(renderHeader('{workspace} · {branch}', context), 'checkout-service · feat/ipc')
  assert.equal(renderHeader('Orca — {workspace}', context), 'Orca — checkout-service')
})

test('header tokens blank out at minimal, taking their separators with them', () => {
  const state = createPresenceState()
  const context = {
    focus: { displayName: 'secret-client', branch: 'feat/acme' },
    state,
    privacy: 'minimal'
  }
  assert.equal(renderHeader('Orca · {workspace}', context), 'Orca')

  const activity = buildActivity({
    state,
    focus: context.focus,
    privacy: 'minimal',
    header: '{workspace} · {branch}'
  })
  const encoded = JSON.stringify(activity)
  assert.ok(!encoded.includes('secret-client'), encoded)
  assert.ok(!encoded.includes('acme'), encoded)
})

test('agent headers follow the latest pane without depending on artwork', () => {
  const state = createPresenceState()
  const input = {
    state,
    focus: { displayName: 'secret-client', branch: 'feat/private' },
    privacy: 'minimal',
    assets: { largeImage: '' }
  }
  assert.equal(buildActivity(input).details, 'Orca')

  applyAgentStatus(state, agentStatus('omp-pane', 'working', 100))
  applyAgentIdentities(state, new Map([['omp-pane', { agent: 'omp', receivedAt: 100 }]]))
  assert.equal(buildActivity(input).details, 'Orca · Oh My Pi (OMP)')

  applyAgentStatus(state, agentStatus('opencode-pane', 'working', 200))
  applyAgentIdentities(
    state,
    new Map([['opencode-pane', { agent: 'opencode2', receivedAt: 200 }]])
  )
  assert.equal(buildActivity(input).details, 'Orca · OpenCode 2')
  assert.equal(buildActivity(input).state, '2 agents working')
  assert.equal(
    buildActivity({ ...input, header: 'Using {agent} · {workspace} · {branch}' }).details,
    'Using OpenCode 2'
  )
  assert.equal(buildActivity({ ...input, header: '' }).details, undefined)

  applyAgentStatus(state, agentStatus('omp-pane', 'working', 300))
  assert.equal(buildActivity(input).details, 'Orca · Oh My Pi (OMP)')
})

test('a token header does not repeat the project it already names', () => {
  const state = createPresenceState()
  const activity = buildActivity({
    state,
    focus: { displayName: 'checkout-service', branch: 'feat/ipc' },
    privacy: 'full',
    header: '{workspace}'
  })
  assert.equal(activity.details, 'checkout-service · feat/ipc')
})

test('an empty header stays empty rather than falling back', () => {
  const state = createPresenceState()
  const context = { focus: null, state, privacy: 'full' }
  assert.equal(renderHeader('', context), '')
  assert.equal(renderHeader('   ', context), '')
})

test('the header cycle walks the presets and reaches "hidden"', () => {
  const seen = []
  let header = DEFAULT_HEADER
  for (let step = 0; step < HEADER_PRESETS.length; step += 1) {
    header = nextHeader(header)
    seen.push(header)
  }
  assert.deepEqual(seen, [...HEADER_PRESETS.slice(1), HEADER_PRESETS[0]])
  // A hand-written header is not in the cycle, so it restarts from the top.
  assert.equal(nextHeader('My Fleet'), HEADER_PRESETS[0])
})

test('the header is configurable and can be turned off with a blank string', () => {
  const state = createPresenceState()
  applyAgentStatus(state, { paneKey: 'a', worktreeId: 'w1', state: 'working', receivedAt: 1 })

  const renamed = buildActivity({ state, focus: null, privacy: 'minimal', header: 'Fleet' })
  assert.equal(renamed.details, 'Fleet')

  const off = buildActivity({ state, focus: null, privacy: 'minimal', header: '' })
  assert.equal(off.details, undefined)
  assert.equal(off.state, '1 agent working')

  const withProject = buildActivity({
    state,
    focus: { displayName: 'app', branch: 'main' },
    privacy: 'full',
    header: ''
  })
  assert.equal(withProject.details, 'app · main')
})

test('the Orca logo is published without any configuration', () => {
  const activity = buildActivity({ state: createPresenceState(), focus: null, privacy: 'minimal' })
  assert.equal(activity.assets.large_image, DEFAULT_LARGE_IMAGE)
  assert.equal(activity.assets.large_text, DEFAULT_LARGE_TEXT)
})

test('configured artwork overrides the logo, and a blank key drops it', () => {
  const state = createPresenceState()
  const custom = buildActivity({
    state,
    focus: null,
    privacy: 'minimal',
    assets: { largeImage: 'my-art', largeText: 'My Fleet' }
  })
  assert.equal(custom.assets.large_image, 'my-art')
  assert.equal(custom.assets.large_text, 'My Fleet')

  const bare = buildActivity({
    state,
    focus: null,
    privacy: 'minimal',
    assets: { largeImage: '' }
  })
  assert.equal(bare.assets, undefined)
})

test('full privacy names the workspaces the agents are working in', () => {
  const state = createPresenceState()
  applyWorktreeCreated(state, { worktreeId: 'w1', path: '/repos/api', branch: 'main' })
  applyWorktreeCreated(state, { worktreeId: 'w2', path: '/repos/web', branch: 'feat/x' })
  applyAgentStatus(state, { paneKey: 'a', worktreeId: 'w1', state: 'working', receivedAt: 1 })
  applyAgentStatus(state, { paneKey: 'b', worktreeId: 'w2', state: 'working', receivedAt: 1 })

  assert.deepEqual(describeWorkspaces(state), ['api', 'web'])
  const activity = buildActivity({
    state,
    focus: { displayName: 'api', branch: 'main' },
    privacy: 'full'
  })
  assert.equal(activity.state, '2 agents working · in api, web')
})

test('a worktree without a path falls back to its branch as a name', () => {
  const state = createPresenceState()
  applyWorktreeCreated(state, { worktreeId: 'w1', path: '', branch: 'feat/ipc' })
  applyAgentStatus(state, { paneKey: 'a', worktreeId: 'w1', state: 'working', receivedAt: 1 })
  assert.deepEqual(describeWorkspaces(state), ['feat/ipc'])
})

test('an unnamed worktree degrades to the worktree count', () => {
  // No `worktree.created` was seen for these, so only their ids are known.
  const state = createPresenceState()
  applyAgentStatus(state, { paneKey: 'a', worktreeId: 'w1', state: 'working', receivedAt: 1 })
  applyAgentStatus(state, { paneKey: 'b', worktreeId: 'w2', state: 'working', receivedAt: 1 })
  const activity = buildActivity({ state, focus: null, privacy: 'full' })
  assert.equal(activity.state, '2 agents working · across 2 worktrees')
})

test('a long workspace list collapses into a remainder count', () => {
  const state = createPresenceState()
  for (const name of ['api', 'web', 'infra', 'docs', 'cli']) {
    applyWorktreeCreated(state, { worktreeId: name, path: `/repos/${name}`, branch: 'main' })
    applyAgentStatus(state, { paneKey: name, worktreeId: name, state: 'working', receivedAt: 1 })
  }
  const activity = buildActivity({ state, focus: null, privacy: 'full' })
  assert.equal(activity.state, '5 agents working · in api, cli, docs +2')
})

test('minimal privacy keeps workspace names out of the status line', () => {
  const state = createPresenceState()
  applyWorktreeCreated(state, { worktreeId: 'w1', path: '/repos/secret-client', branch: 'main' })
  applyAgentStatus(state, { paneKey: 'a', worktreeId: 'w1', state: 'working', receivedAt: 1 })
  const activity = buildActivity({ state, focus: null, privacy: 'minimal' })
  assert.ok(!JSON.stringify(activity).includes('secret-client'))
  assert.equal(activity.state, '1 agent working')
})

test('off privacy publishes nothing at all', () => {
  const state = createPresenceState()
  applyAgentStatus(state, { paneKey: 'a', worktreeId: 'w1', state: 'working', receivedAt: 1 })
  assert.equal(buildActivity({ state, focus: null, privacy: 'off', startedAt: 1 }), null)
})

test('full privacy degrades when the host has no focus context', () => {
  const state = createPresenceState()
  applyWorktreeCreated(state, { worktreeId: 'w1', path: '/repos/app', branch: 'main' })
  const activity = buildActivity({ state, focus: null, privacy: 'full', header: '', startedAt: 0 })
  assert.equal(activity.details, 'app')
  assert.equal(activity.timestamps, undefined)
})

test('over-long fields are clamped to what Discord accepts', () => {
  const state = createPresenceState()
  const activity = buildActivity({
    state,
    focus: { displayName: 'x'.repeat(200), branch: 'y'.repeat(200) },
    privacy: 'full',
    startedAt: 0
  })
  assert.ok(activity.details.length <= 128, String(activity.details.length))
})

test('privacy cycles through every level and returns', () => {
  assert.equal(nextPrivacy('full'), 'minimal')
  assert.equal(nextPrivacy('minimal'), 'off')
  assert.equal(nextPrivacy('off'), 'full')
})

// ---------------------------------------------------------------- agent logo

function agentStatus(paneKey, state, receivedAt) {
  return { paneKey, state, receivedAt, worktreeId: null }
}

test('an agent identity survives a status update on the same pane', () => {
  const state = createPresenceState()
  applyAgentStatus(state, agentStatus('pane-1', 'working', 1))
  applyAgentIdentities(state, new Map([['pane-1', { agent: 'omp', receivedAt: 1 }]]))
  // A later status update for the same pane must not clear the identity.
  applyAgentStatus(state, agentStatus('pane-1', 'done', 2))
  assert.equal(state.panes.get('pane-1')?.agent, 'omp')
})

test('identities for panes Orca never projected are not adopted', () => {
  const state = createPresenceState()
  applyAgentIdentities(
    state,
    new Map([
      ['pane-1', { agent: 'omp', receivedAt: 1 }],
      ['pane-unknown', { agent: 'opencode', receivedAt: 2 }]
    ])
  )
  assert.equal(state.panes.size, 0)
})

test('the agent identity round-trips through storage', () => {
  const state = createPresenceState()
  applyAgentStatus(state, agentStatus('pane-1', 'working', 10))
  applyAgentIdentities(state, new Map([['pane-1', { agent: 'opencode', receivedAt: 10 }]]))
  const restored = deserializeState(serializeState(state))
  assert.equal(restored.panes.get('pane-1')?.agent, 'opencode')
})

test('latestAgent picks the most recent pane and is deterministic on ties', () => {
  const state = createPresenceState()
  applyAgentStatus(state, agentStatus('pane-a', 'done', 100))
  applyAgentStatus(state, agentStatus('pane-b', 'working', 200))
  applyAgentIdentities(
    state,
    new Map([
      ['pane-a', { agent: 'omp', receivedAt: 100 }],
      ['pane-b', { agent: 'opencode', receivedAt: 200 }]
    ])
  )
  assert.deepEqual(latestAgent(state), { paneKey: 'pane-b', agent: 'opencode', receivedAt: 200 })

  const tied = createPresenceState()
  for (const paneKey of ['pane-z', 'pane-a']) {
    applyAgentStatus(tied, agentStatus(paneKey, 'working', 50))
    applyAgentIdentities(tied, new Map([[paneKey, { agent: 'omp', receivedAt: 50 }]]))
  }
  assert.equal(latestAgent(tied)?.paneKey, 'pane-a')
})

test('latestAgent ignores panes the host gave no identity for', () => {
  const state = createPresenceState()
  applyAgentStatus(state, agentStatus('pane-a', 'working', 500))
  assert.equal(latestAgent(state), null)
})

test('the dynamic logo replaces the default and sets its hover text', () => {
  const state = createPresenceState()
  applyAgentStatus(state, agentStatus('pane-1', 'working', 10))
  applyAgentIdentities(state, new Map([['pane-1', { agent: 'omp', receivedAt: 10 }]]))
  const base = {
    state,
    focus: null,
    privacy: 'minimal',
    startedAt: 0
  }
  const dynamic = buildActivity({
    ...base,
    agentImage: { key: 'https://omp.sh/og-image.png', text: 'OMP' }
  })
  assert.equal(dynamic.assets.large_image, 'https://omp.sh/og-image.png')
  assert.equal(dynamic.assets.large_text, 'OMP')

  const pinned = buildActivity(base)
  assert.equal(pinned.assets.large_image, DEFAULT_LARGE_IMAGE)
  assert.equal(pinned.assets.large_text, DEFAULT_LARGE_TEXT)
})

test('an explicitly empty largeImage suppresses the dynamic logo', () => {
  const state = createPresenceState()
  applyAgentStatus(state, agentStatus('pane-1', 'working', 10))
  applyAgentIdentities(state, new Map([['pane-1', { agent: 'omp', receivedAt: 10 }]]))
  const activity = buildActivity({
    state,
    focus: null,
    privacy: 'minimal',
    agentImage: { key: 'https://omp.sh/og-image.png', text: 'OMP' },
    assets: { largeImage: '' }
  })
  assert.equal(activity.assets, undefined)
})

test('the dynamic logo survives a privacy drop to off', () => {
  const state = createPresenceState()
  applyAgentStatus(state, agentStatus('pane-1', 'working', 10))
  applyAgentIdentities(state, new Map([['pane-1', { agent: 'omp', receivedAt: 10 }]]))
  assert.equal(
    buildActivity({
      state,
      focus: null,
      privacy: 'off',
      agentImage: { key: 'omp-art', text: 'OMP' }
    }),
    null
  )
})
