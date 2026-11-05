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
await build({
  entryPoints: ['src/gateway/mobile-gateway.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: output,
  plugins: [
    {
      name: 'external-ws',
      setup(builder) {
        builder.onResolve({ filter: /^ws$/ }, () => ({ path: require.resolve('ws'), external: true }))
      },
    },
  ],
})
const { MobileGateway } = await import(pathToFileURL(output).href)
const calls = []
let live = { id: 'goal-1', revision: 3, objective: 'Check the UI', phase: 'active', activation: 'disarmed' }
const stream = async function* (signal) {
  await new Promise(resolve => (signal.aborted ? resolve() : signal.addEventListener('abort', resolve, { once: true })))
}
const workspaceStream = async function* (signal) {
  yield {
    type: 'baseline',
    value: {
      items: [{ workspaceId: 'w1', title: 'Project', sessionIds: ['session/a'] }],
      archivedSessionIds: [],
      pinnedSessionIds: [],
    },
  }
  yield { type: 'pinned', pinnedSessionIds: ['session/a'] }
  await new Promise(resolve => (signal.aborted ? resolve() : signal.addEventListener('abort', resolve, { once: true })))
}
const jobListStream = async function* (signal) {
  yield { type: 'rows', jobs: [{ id: 'job/1', status: 'running', title: 'Build' }] }
  await new Promise(resolve => (signal.aborted ? resolve() : signal.addEventListener('abort', resolve, { once: true })))
}
const stateStream = async function* (signal) {
  yield {
    cursor: 4,
    active: true,
    running: true,
    queue: [{ id: 'q1', placement: 'queued', content: 'Next' }],
    pendingInput: [],
  }
  await new Promise(resolve => (signal.aborted ? resolve() : signal.addEventListener('abort', resolve, { once: true })))
}
const gateway = new MobileGateway({
  wireClient: {
    async call(endpoint, args) {
      calls.push({ endpoint, args })
      if (endpoint === 'schedule/catalog') return [{ id: 'task', status: 'active' }]
      if (endpoint === 'schedule/edit') return { id: 'task', status: args.request.patch?.active ? 'active' : 'paused' }
      if (endpoint === 'schedule/create') return { ...args.request, id: 'created', status: 'active' }
      if (endpoint === 'schedule/run') return { id: args.request.id, status: 'active' }
      if (endpoint === 'schedule/view') return { id: args.request.id, status: 'active', title: 'Nightly review' }
      if (endpoint === 'schedule/history') return { id: args.request.id, items: [], limit: args.request.limit }
      if (endpoint === 'job/kill') return { outcome: 'requested' }
      if (endpoint === 'workspace/pinSession') return { pinnedSessionIds: ['session/a'] }
      if (endpoint === 'workspace/unpinSession') return { pinnedSessionIds: [] }
      if (endpoint === 'workspace/create')
        return { created: true, workspace: { workspaceId: 'w1', path: args.request.path } }
      if (endpoint === 'workspace/unarchiveSession') return { archivedSessionIds: [] }
      if (endpoint === 'session/list') return { items: [{ sessionId: 'session/a', running: false }] }
      if (endpoint === 'session/state')
        return {
          cursor: 4,
          active: true,
          running: true,
          queue: [{ id: 'q1', placement: 'queued', content: 'Next' }],
          pendingInput: [],
        }
      if (endpoint === 'session/projections')
        return {
          kind: 'value',
          seq: 9,
          values: {
            subagentCatalog: [
              { id: 'child/1', mode: 'continuable', label: 'Reviewer' },
              { id: 'child/2', mode: 'external' },
            ],
          },
        }
      if (endpoint === 'subagents/interruptByUser') return { interrupted: true }
      if (endpoint === 'goals/get') return live
      if (endpoint === 'goals/create') return { ref: { id: 'created', revision: 1 } }
      if (endpoint === 'goals/resume') return { ...live, revision: 4, activation: 'armed' }
      if (endpoint === 'goals/clear') return { id: 'goal-1', revision: 5 }
      if (endpoint === 'account/getProfile') return { contact: 'l***@example.com', name: 'Phone Owner' }
      if (endpoint === 'account/getBalance') return { bonusWallets: [], currency: 'CNY' }
      if (endpoint === 'commands/list')
        return [
          { description: 'Show or leave plan mode', name: 'plan' },
          { description: 'Switch the access preset', input: { hint: 'preset', kind: 'text' }, name: 'permission' },
        ]
      throw new Error(`Unexpected endpoint: ${endpoint}`)
    },
    open(endpoint, _args, signal) {
      if (endpoint === 'workspace/follow') return workspaceStream(signal)
      if (endpoint === 'job/list') return jobListStream(signal)
      if (endpoint === 'session/observeState') return stateStream(signal)
      return stream(signal)
    },
    openEvents(signal) {
      return stream(signal)
    },
  },
})
const credential = gateway.pairDevice('Goal route test')
const { url } = await gateway.start()
const request = (path, body, authenticated = true) =>
  fetch(`${url}/v1/sessions/session%2Fa/goal/${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(authenticated ? { authorization: `Bearer ${credential.deviceId}.${credential.accessToken}` } : {}),
    },
    body: JSON.stringify(body),
  })
try {
  assert.equal((await request('read', {}, false)).status, 401)
  assert.equal(calls.length, 0)
  assert.deepEqual((await (await request('read', {})).json()).data, { goal: live })
  live = undefined
  assert.deepEqual((await (await request('read', {})).json()).data, { goal: null })
  assert.equal((await request('create', { objective: '  ' })).status, 400)
  assert.deepEqual((await (await request('create', { objective: 'Finish the review' })).json()).data, {
    ref: { id: 'created', revision: 1 },
  })
  const resumed = (await (await request('resume', { ref: { id: 'goal-1', revision: 3 } })).json()).data
  assert.equal(resumed.activation, 'armed')
  assert.equal((await request('resume', { ref: { id: 'goal-1', revision: 0 } })).status, 400)
  assert.equal((await request('complete', {})).status, 404)
  assert.deepEqual((await (await request('clear', { ref: { id: 'goal-1', revision: 4 } })).json()).data, {
    id: 'goal-1',
    revision: 5,
  })
  assert.deepEqual(
    calls.map(call => call.endpoint),
    ['goals/get', 'goals/get', 'goals/create', 'goals/resume', 'goals/clear'],
  )
  assert.deepEqual(calls[2].args, { agentId: 'session/a', request: { objective: 'Finish the review' } })
  assert.deepEqual(calls[3].args, { agentId: 'session/a', ref: { id: 'goal-1', revision: 3 } })
  const post = (path, body, authenticated = true) =>
    fetch(`${url}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(authenticated ? { authorization: `Bearer ${credential.deviceId}.${credential.accessToken}` } : {}),
      },
      body: JSON.stringify(body),
    })
  assert.deepEqual((await (await post('/v1/schedules/catalog', {})).json()).data, {
    items: [{ id: 'task', status: 'active' }],
  })
  assert.equal((await post('/v1/schedules/task/pause', {})).status, 400)
  assert.equal((await post('/v1/schedules/task/pause', { expectedUpdatedAt: 7 })).status, 400)
  assert.equal((await post('/v1/schedules/task/pause', { expectedUpdatedAt: null })).status, 200)
  assert.deepEqual(calls.at(-1), {
    endpoint: 'schedule/edit',
    args: { request: { id: 'task', action: 'update', patch: { active: false }, expectedUpdatedAt: null } },
  })
  assert.deepEqual((await (await post('/v1/sessions/session%2Fa/commands', {})).json()).data, {
    items: [
      { description: 'Show or leave plan mode', name: 'plan' },
      { description: 'Switch the access preset', input: { hint: 'preset', kind: 'text' }, name: 'permission' },
    ],
  })
  assert.deepEqual(calls.at(-1), { endpoint: 'commands/list', args: { agentId: 'session/a' } })
  assert.equal((await post('/v1/sessions/session%2Fa/commands', {}, false)).status, 401)
  const client = { locale: 'zh-CN', timezoneOffsetSeconds: -28800, version: '0.1.0' }
  assert.deepEqual((await (await post('/v1/account/profile', { client })).json()).data, {
    contact: 'l***@example.com',
    name: 'Phone Owner',
  })
  assert.deepEqual(calls.at(-1), { endpoint: 'account/getProfile', args: { client } })
  assert.deepEqual((await (await post('/v1/account/balance', { client })).json()).data, {
    bonusWallets: [],
    currency: 'CNY',
  })
  assert.deepEqual(calls.at(-1), { endpoint: 'account/getBalance', args: { client } })
  // The client metadata is a required, validated argument.
  assert.equal((await post('/v1/account/profile', {})).status, 400)
  assert.equal((await post('/v1/account/profile', { client: { version: '0.1.0' } })).status, 400)
  // Account writes never cross this gateway, so unknown account routes stay 404.
  assert.equal((await post('/v1/account/signOut', { client })).status, 404)
  assert.equal((await post('/v1/account/startSignIn', { client })).status, 404)
  // Schedule create/run/view/history forward the Host's own request shapes.
  const createRequest = {
    prompt: 'Review the diff',
    target: { kind: 'new' },
    timing: { kind: 'every', every_seconds: 3600 },
    title: 'Nightly review',
  }
  assert.equal((await post('/v1/schedules/create', { request: { ...createRequest, title: '   ' } })).status, 400)
  assert.equal((await post('/v1/schedules/create', { request: { ...createRequest, timing: undefined } })).status, 400)
  assert.deepEqual((await (await post('/v1/schedules/create', { request: createRequest })).json()).data, {
    id: 'created',
    status: 'active',
    title: 'Nightly review',
    prompt: 'Review the diff',
    target: { kind: 'new' },
    timing: { kind: 'every', every_seconds: 3600 },
  })
  assert.deepEqual(calls.at(-1).args, { request: createRequest })
  assert.deepEqual((await (await post('/v1/schedules/task/run', {})).json()).data, { id: 'task', status: 'active' })
  assert.deepEqual(calls.at(-1), { endpoint: 'schedule/run', args: { request: { id: 'task' } } })
  assert.deepEqual((await (await post('/v1/schedules/task/view', {})).json()).data, {
    id: 'task',
    status: 'active',
    title: 'Nightly review',
  })
  assert.deepEqual(calls.at(-1), { endpoint: 'schedule/view', args: { request: { id: 'task' } } })
  assert.equal((await post('/v1/schedules/task/history', {})).status, 400)
  assert.deepEqual(
    (await (await post('/v1/schedules/task/history', { request: { limit: 20, before: 'm1' } })).json()).data,
    {
      id: 'task',
      items: [],
      limit: 20,
    },
  )
  assert.deepEqual(calls.at(-1), {
    endpoint: 'schedule/history',
    args: { request: { id: 'task', limit: 20, before: 'm1' } },
  })
  // A visible background job must also be stoppable.
  assert.deepEqual((await (await post('/v1/sessions/session%2Fa/jobs/job%2F1/kill', {})).json()).data, {
    outcome: 'requested',
  })
  assert.deepEqual(calls.at(-1), {
    endpoint: 'job/kill',
    args: { request: { sessionId: 'session/a', jobId: 'job/1' } },
  })
  // Pin and unpin carry only the Session id, and create carries a path.
  assert.deepEqual((await (await post('/v1/sessions/session%2Fa/pin', {})).json()).data, {
    pinnedSessionIds: ['session/a'],
  })
  assert.deepEqual(calls.at(-1), { endpoint: 'workspace/pinSession', args: { request: { sessionId: 'session/a' } } })
  assert.deepEqual((await (await post('/v1/sessions/session%2Fa/unpin', {})).json()).data, { pinnedSessionIds: [] })
  assert.deepEqual(calls.at(-1), { endpoint: 'workspace/unpinSession', args: { request: { sessionId: 'session/a' } } })
  assert.equal((await post('/v1/workspaces/create', {})).status, 400)
  assert.deepEqual((await (await post('/v1/workspaces/create', { path: '/tmp/project' })).json()).data, {
    created: true,
    workspace: { workspaceId: 'w1', path: '/tmp/project' },
  })
  assert.deepEqual(calls.at(-1), { endpoint: 'workspace/create', args: { request: { path: '/tmp/project' } } })
  // The workspace follow stream must publish its pinned set on the list route.
  // The follow streams are started as void promises; let their opening frames
  // land before reading the cached workspace state.
  await post('/v1/sessions/list', {})
  await new Promise(resolve => setTimeout(resolve, 10))
  const listed = await (await post('/v1/sessions/list', {})).json()
  const list = listed.data
  assert.deepEqual(list.pinnedSessionIds, ['session/a'])
  assert.equal(list.workspaces[0].title, 'Project')
  assert.equal((await post('/v1/sessions/session%2Fa/unarchive', {})).status, 200)
  assert.deepEqual(calls.at(-1), {
    endpoint: 'workspace/unarchiveSession',
    args: { request: { sessionId: 'session/a' } },
  })
  // Queue and job snapshots fall back to a fresh Host read when no follow
  // stream has cached one, so polling REST clients still see live data.
  assert.deepEqual((await (await post('/v1/sessions/session%2Fa/queue', {})).json()).data, {
    items: [{ id: 'q1', placement: 'queued', content: 'Next' }],
  })
  assert.deepEqual(calls.at(-1), { endpoint: 'session/state', args: { request: { sessionId: 'session/a' } } })
  assert.deepEqual((await (await post('/v1/sessions/session%2Fa/jobs', {})).json()).data, {
    items: [{ id: 'job/1', status: 'running', title: 'Build' }],
  })
  // The subagent roster is derived from the parent's catalog projection; a
  // mode the phone cannot render degrades to a diagnostic row.
  assert.deepEqual((await (await post('/v1/sessions/session%2Fa/subagents', {})).json()).data, {
    entries: [
      {
        kind: 'child',
        id: 'child/1',
        mode: 'continuable',
        activity: 'inactive',
        hasChildren: false,
        label: 'Reviewer',
      },
      { kind: 'diagnostic', id: 'child/2', reason: 'unsupported' },
    ],
    parentAvailable: true,
  })
  assert.deepEqual(calls.at(-2), { endpoint: 'session/projections', args: { request: { sessionId: 'session/a' } } })
  assert.deepEqual(
    (await (await post('/v1/sessions/session%2Fa/subagents/child%2F1/interrupt', { mode: 'continuable' })).json()).data,
    {
      interrupted: true,
    },
  )
  assert.deepEqual(calls.at(-1), {
    endpoint: 'subagents/interruptByUser',
    args: { childSessionId: 'child/1' },
  })
  assert.equal((await post('/v1/sessions/session%2Fa/subagents/child%2F1/interrupt', { mode: 'one-shot' })).status, 400)
  console.log('Goal Gateway routes: authentication, validation, live activation, create and CAS forwarding passed.')
} finally {
  await gateway.stop()
  await rm(temporary, { recursive: true, force: true })
}
