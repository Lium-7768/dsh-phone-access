import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'

// Drives the real gateway route handlers against a synthetic desktop wire, so the reading
// records' projection and the acknowledgement round trip are exercised without a running
// desktop, a saved device registry, or a real session.
const temporary = await mkdtemp(join(tmpdir(), 'read-state-gateway-test-'))
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
/** Records the Host would report; the test replaces this to move them. */
let records = [
  { sessionId: 'session%2Fa', completedTurn: 5, failed: false, readTurn: 2, manualUnread: false },
  { sessionId: 'session%2Fb', completedTurn: 9, failed: true, readTurn: 9, manualUnread: true },
]

const idle = signal =>
  new Promise(resolve => (signal.aborted ? resolve() : signal.addEventListener('abort', resolve, { once: true })))

/** Frames the subscription has yet to deliver; the test pushes into it. */
const readStateFrames = []
const readStateStream = async function* (signal) {
  yield { type: 'baseline', items: records.map(record => ({ ...record })) }
  while (!signal.aborted) {
    const next = readStateFrames.shift()
    if (next === undefined) {
      await new Promise(resolve => setTimeout(resolve, 10))
      continue
    }
    yield next
  }
}

/** Delivers one frame and lets the gateway apply it. */
const pushReadState = async frame => {
  readStateFrames.push(frame)
  await new Promise(resolve => setTimeout(resolve, 80))
}
const workspaceStream = async function* (signal) {
  yield { type: 'baseline', value: { items: [], archivedSessionIds: [], pinnedSessionIds: [] } }
  await idle(signal)
}

const gateway = new MobileGateway({
  wireClient: {
    async call(endpoint, args) {
      calls.push({ endpoint, args })
      if (endpoint === 'session/list')
        return { items: [{ sessionId: 'session%2Fa' }, { sessionId: 'session%2Fb' }, { sessionId: 'session%2Fc' }] }
      if (endpoint === 'sessionStatus/mark') return undefined
      throw new Error(`Unexpected endpoint: ${endpoint}`)
    },
    open(endpoint, _args, signal) {
      if (endpoint === 'sessionStatus/follow') return readStateStream(signal)
      if (endpoint === 'workspace/follow') return workspaceStream(signal)
      // Every other subscription idles until the gateway stops.
      return (async function* () {
        await idle(signal)
      })()
    },
    openEvents(signal) {
      return (async function* () {
        await idle(signal)
      })()
    },
  },
})

const credential = gateway.pairDevice('Read state route test')
const { url } = await gateway.start()
const post = (path, body, authenticated = true) =>
  fetch(`${url}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(authenticated ? { authorization: `Bearer ${credential.deviceId}.${credential.accessToken}` } : {}),
    },
    body: JSON.stringify(body),
  })

let failures = 0
const check = async (name, body) => {
  try {
    await body()
    process.stdout.write(`  ok  ${name}\n`)
  } catch (error) {
    failures += 1
    process.stderr.write(`  FAIL ${name}\n${String(error)}\n`)
  }
}

try {
  // The baseline has to be consumed before the list can project it.
  await new Promise(resolve => setTimeout(resolve, 120))

  await check('the list carries the Host unread mark, derived not counted', async () => {
    const body = await (await post('/v1/sessions/list', {})).json()
    const byId = new Map(body.data.items.map(item => [item.sessionId, item]))
    // readTurn 2 < completedTurn 5, so the Host calls it unread.
    assert.equal(byId.get('session%2Fa').completionUnread, true)
    // Both sides read, but the reader marked it unread by hand; the manual mark wins.
    assert.equal(byId.get('session%2Fb').completionUnread, true)
    assert.equal(byId.get('session%2Fb').completionFailed, true)
    // No record for this Session: it reports no unread flag at all rather than a guess.
    assert.equal(byId.get('session%2Fc').completionUnread, undefined)
  })

  await check('a row the Host considers read reports unread false, not absent', async () => {
    // The Host acknowledges the turn it had reported as unread; the change arrives on the
    // follow stream the way a desktop acknowledgement does.
    await pushReadState({
      type: 'changed',
      state: { sessionId: 'session%2Fa', completedTurn: 5, failed: false, readTurn: 5, manualUnread: false },
    })
    const body = await (await post('/v1/sessions/list', {})).json()
    const row = body.data.items.find(item => item.sessionId === 'session%2Fa')
    assert.equal(row.completionUnread, false)
  })

  await check('acknowledging forwards the completed turn to the Host', async () => {
    calls.length = 0
    const response = await post('/v1/sessions/read-state', { sessionId: 'session%2Fa', read: true })
    assert.equal(response.status, 200)
    const mark = calls.find(call => call.endpoint === 'sessionStatus/mark')
    assert.ok(mark, 'the gateway must write the Host record rather than a local copy')
    assert.deepEqual(mark.args, { sessionId: 'session%2Fa', action: { type: 'acknowledge', throughTurn: 5 } })
  })

  await check('marking unread asks for the manual reminder, not an acknowledgement', async () => {
    calls.length = 0
    await post('/v1/sessions/read-state', { sessionId: 'session%2Fb', read: false })
    const mark = calls.find(call => call.endpoint === 'sessionStatus/mark')
    assert.deepEqual(mark.args, { sessionId: 'session%2Fb', action: { type: 'unread' } })
  })

  await check('the route needs a paired device', async () => {
    assert.equal((await post('/v1/sessions/read-state', { sessionId: 'session%2Fa' }, false)).status, 401)
  })
} finally {
  await gateway.stop().catch(() => undefined)
}

// A desktop that predates the reading service answers the subscription with a rejection.
// The gateway must report it once and stop, rather than retrying a stream that can never
// open and recording a credential per attempt.
let opens = 0
const legacy = new MobileGateway({
  wireClient: {
    async call(endpoint) {
      if (endpoint === 'session/list') return { items: [{ sessionId: 'session%2Fa' }] }
      throw new Error(`Unexpected endpoint: ${endpoint}`)
    },
    open(endpoint, _args, signal) {
      // Only the reading stream is rejected; the rest of the Host is healthy, which is
      // exactly the rc.2 shape this test stands in for.
      if (endpoint === 'sessionStatus/follow') {
        opens += 1
        const error = new Error('Unknown method sessionStatus/follow')
        Object.assign(error, { code: 'upstream-rejected', upstreamCode: 'unknown-method' })
        throw error
      }
      return (async function* () {
        await idle(signal)
      })()
    },
    openEvents(signal) {
      return (async function* () {
        await idle(signal)
      })()
    },
  },
})
const legacyCredential = legacy.pairDevice('Legacy host test')
const legacyUrl = (await legacy.start()).url
try {
  await new Promise(resolve => setTimeout(resolve, 200))
  await check('a Host without reading records is asked once, not on a backoff', async () => {
    assert.equal(opens, 1)
    // The list still answers; it simply carries no unread flag.
    const body = await (
      await fetch(`${legacyUrl}/v1/sessions/list`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${legacyCredential.deviceId}.${legacyCredential.accessToken}`,
        },
        body: '{}',
      })
    ).json()
    assert.equal(body.data.items[0].completionUnread, undefined)
  })
} finally {
  await legacy.stop().catch(() => undefined)
  await rm(temporary, { recursive: true, force: true })
}

if (failures > 0) {
  process.stderr.write(`\n${failures} read-state check(s) failed\n`)
  process.exit(1)
}
process.stdout.write('\nread-state gateway checks passed\n')
