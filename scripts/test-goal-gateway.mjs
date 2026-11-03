import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'

// Run the actual HTTP route handlers against a synthetic desktop wire.
// No desktop runtime, model task, or saved device registry is touched.
const temporary = await mkdtemp(join(tmpdir(), 'goal-gateway-test-'))
const output = join(temporary, 'gateway.cjs')
const require = createRequire(import.meta.url)
await build({ entryPoints: ['src/gateway/mobile-gateway.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: output,
  plugins: [{ name: 'external-ws', setup(builder) { builder.onResolve({ filter: /^ws$/ }, () => ({ path: require.resolve('ws'), external: true })) } }],
})
const { MobileGateway } = await import(pathToFileURL(output).href)
const calls = []
let live = { id: 'goal-1', revision: 3, objective: 'Check the UI', phase: 'active', activation: 'disarmed' }
const stream = async function* (signal) {
  await new Promise(resolve => signal.aborted ? resolve() : signal.addEventListener('abort', resolve, { once: true }))
}
const gateway = new MobileGateway({ wireClient: {
  async call(endpoint, args) {
    calls.push({ endpoint, args })
    if (endpoint === 'schedule/catalog') return [{ id: 'task', status: 'active' }]
    if (endpoint === 'schedule/edit') return { id: 'task', status: args.request.patch?.active ? 'active' : 'paused' }
    if (endpoint === 'workspace/unarchiveSession') return { archivedSessionIds: [] }
    if (endpoint === 'goals/get') return live
    if (endpoint === 'goals/create') return { ref: { id: 'created', revision: 1 } }
    if (endpoint === 'goals/resume') return { ...live, revision: 4, activation: 'armed' }
    if (endpoint === 'goals/clear') return { id: 'goal-1', revision: 5 }
    throw new Error(`Unexpected endpoint: ${endpoint}`)
  },
  open(_endpoint, _args, signal) { return stream(signal) },
  openEvents(signal) { return stream(signal) },
} })
const credential = gateway.pairDevice('Goal route test')
const { url } = await gateway.start()
const request = (path, body, authenticated = true) => fetch(`${url}/v1/sessions/session%2Fa/goal/${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...(authenticated ? { authorization: `Bearer ${credential.deviceId}.${credential.accessToken}` } : {}) }, body: JSON.stringify(body),
})
try {
  assert.equal((await request('read', {}, false)).status, 401)
  assert.equal(calls.length, 0)
  assert.deepEqual((await (await request('read', {})).json()).data, { goal: live })
  live = undefined
  assert.deepEqual((await (await request('read', {})).json()).data, { goal: null })
  assert.equal((await request('create', { objective: '  ' })).status, 400)
  assert.deepEqual((await (await request('create', { objective: 'Finish the review' })).json()).data, { ref: { id: 'created', revision: 1 } })
  const resumed = (await (await request('resume', { ref: { id: 'goal-1', revision: 3 } })).json()).data
  assert.equal(resumed.activation, 'armed')
  assert.equal((await request('resume', { ref: { id: 'goal-1', revision: 0 } })).status, 400)
  assert.equal((await request('complete', {})).status, 404)
  assert.deepEqual((await (await request('clear', { ref: { id: 'goal-1', revision: 4 } })).json()).data, { id: 'goal-1', revision: 5 })
  assert.deepEqual(calls.map(call => call.endpoint), ['goals/get', 'goals/get', 'goals/create', 'goals/resume', 'goals/clear'])
  assert.deepEqual(calls[2].args, { agentId: 'session/a', request: { objective: 'Finish the review' } })
  assert.deepEqual(calls[3].args, { agentId: 'session/a', ref: { id: 'goal-1', revision: 3 } })
  const post = (path, body) => fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${credential.deviceId}.${credential.accessToken}` }, body: JSON.stringify(body) })
  assert.deepEqual((await (await post('/v1/schedules/catalog', {})).json()).data, { items: [{ id: 'task', status: 'active' }] })
  assert.equal((await post('/v1/schedules/task/pause', {})).status, 400)
  assert.equal((await post('/v1/schedules/task/run', {})).status, 404)
  assert.equal((await post('/v1/schedules/task/pause', { expectedUpdatedAt: null })).status, 200)
  assert.deepEqual(calls.at(-1), { endpoint: 'schedule/edit', args: { request: { id: 'task', action: 'update', patch: { active: false }, expectedUpdatedAt: null } } })
  assert.equal((await post('/v1/sessions/session%2Fa/unarchive', {})).status, 200)
  assert.deepEqual(calls.at(-1), { endpoint: 'workspace/unarchiveSession', args: { request: { sessionId: 'session/a' } } })
  console.log('Goal Gateway routes: authentication, validation, live activation, create and CAS forwarding passed.')
} finally { await gateway.stop(); await rm(temporary, { recursive: true, force: true }) }
