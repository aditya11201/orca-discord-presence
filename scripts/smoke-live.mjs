/**
 * Live smoke test: connects to the Discord IPC socket that is actually running
 * on this machine and publishes one activity, then clears it. Not part of the
 * suite — it mutates the user's Discord profile for a second or two.
 *
 * Run: node smoke-live.mjs
 */
import { DiscordPresenceClient } from '../dist/lib/discord-ipc.mjs'
import { DEFAULT_CLIENT_ID } from '../dist/main.mjs'
import { readAgentIdentities, resolveAgentImage } from '../dist/lib/agent-identity.mjs'
import { candidateSocketPaths } from '../dist/lib/socket-path.mjs'
import {
  createPresenceState,
  applyAgentStatus,
  applyAgentIdentities,
  DEFAULT_LARGE_IMAGE,
  latestAgent,
  buildActivity
} from '../dist/lib/presence-model.mjs'
import { statSync } from 'node:fs'

const candidates = candidateSocketPaths({
  platform: process.platform,
  env: process.env,
  uid: process.getuid?.()
})
const path = candidates.find((candidate) => {
  try {
    return process.platform === 'win32' || statSync(candidate).isSocket()
  } catch {
    return false
  }
})
if (!path) {
  console.log('no Discord IPC socket found; is Discord running?')
  process.exit(1)
}

const client = new DiscordPresenceClient({ clientId: DEFAULT_CLIENT_ID, log: () => {} })
await client.connect()
console.log('connected:', client.socketPath)

// Real agent identities from the running Orca install, joined onto a fake pane.
// An argument forces one agent id, which is how the OMP/default artwork paths
// get checked against the live proxy without waiting for that agent to run.
const forcedAgent = process.argv[2]
const identities = readAgentIdentities({})
console.log(
  'identities Orca reports:',
  [...identities.entries()].map(([, v]) => v.agent)
)

const state = createPresenceState()
applyAgentStatus(state, { paneKey: 'smoke', state: 'working', receivedAt: Date.now(), worktreeId: null })
const latestIdentity = forcedAgent
  ? { agent: forcedAgent, receivedAt: Date.now() }
  : ([...identities.values()][0] ?? { agent: 'omp', receivedAt: Date.now() })
applyAgentIdentities(state, new Map([['smoke', latestIdentity]]))
const latest = latestAgent(state)
const image = resolveAgentImage(latest.agent, { fallbackImage: DEFAULT_LARGE_IMAGE })

const activity = buildActivity({
  state,
  focus: { branch: 'main', displayName: 'smoke-test', terminals: [] },
  privacy: 'minimal',
  startedAt: Date.now(),
  agentImage: image,
  partyId: 'smoke'
})
console.log('publishing:', JSON.stringify({ details: activity.details, image: activity.assets?.large_image, text: activity.assets?.large_text }))
await client.setActivity(activity)
console.log('published — check your Discord profile, clearing in 3s')
await new Promise((r) => setTimeout(r, 3000))
await client.setActivity(null)
console.log('cleared')
await client.close()
