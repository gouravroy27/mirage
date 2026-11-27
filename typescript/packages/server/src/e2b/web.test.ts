import { MountMode } from '@struktoai/mirage-core/types'
import { RAMVFS } from '@struktoai/mirage-core/vfs/ram/ram'
import { Workspace } from '@struktoai/mirage-core/workspace/workspace/workspace'
import { afterEach, expect, it } from 'vitest'
import {
  checkSandboxAccess,
  dataRoutes,
  type Lease,
  type LeaseRequest,
  type LeaseStore,
  lifecycleRoutes,
} from './index.ts'

const ORIGIN = 'http://sandbox.test'
const CONNECT_JSON = 'application/connect+json'

class FakeLeases implements LeaseStore {
  readonly leases = new Map<string, Lease>()
  readonly workspaces = new Map<string, Workspace>()

  create(request: LeaseRequest): Promise<Lease> {
    const sandboxId = `sandbox-${String(this.leases.size + 1)}`
    const lease: Lease = {
      sandboxId,
      workspace: sandboxId,
      owner: request.owner,
      accessToken: `token-${sandboxId}`,
      envVars: request.envVars,
    }
    this.leases.set(sandboxId, lease)
    this.workspaces.set(
      sandboxId,
      new Workspace({ '/home/user': new RAMVFS() }, { mode: MountMode.WRITE }),
    )
    return Promise.resolve(lease)
  }

  get(sandboxId: string): Promise<Lease | null> {
    return Promise.resolve(this.leases.get(sandboxId) ?? null)
  }

  extend(sandboxId: string, owner: string | null): Promise<Lease | null> {
    return Promise.resolve(this.owned(sandboxId, owner))
  }

  setTimeout(sandboxId: string, owner: string | null): Promise<Lease | null> {
    return Promise.resolve(this.owned(sandboxId, owner))
  }

  revoke(sandboxId: string, owner: string | null): Promise<Lease | null> {
    const lease = this.owned(sandboxId, owner)
    if (lease !== null) this.leases.delete(sandboxId)
    return Promise.resolve(lease)
  }

  private owned(sandboxId: string, owner: string | null): Lease | null {
    const lease = this.leases.get(sandboxId)
    return lease?.owner === owner ? lease : null
  }
}

const stores: FakeLeases[] = []

afterEach(async () => {
  for (const store of stores.splice(0)) {
    await Promise.all([...store.workspaces.values()].map((ws) => ws.close()))
  }
})

/** Serve one data request as a host would: look the lease up, check it, then run it. */
async function serve(store: FakeLeases, request: Request): Promise<Response> {
  const lease = await store.get(request.headers.get('e2b-sandbox-id') ?? '')
  const refused = checkSandboxAccess(request, lease)
  if (refused !== null) return refused
  const workspace = lease === null ? undefined : store.workspaces.get(lease.sandboxId)
  if (lease === null || workspace === undefined)
    throw new Error('access check let a gone sandbox through')
  return dataRoutes(request, { workspace, envVars: lease.envVars })
}

function sandboxHeaders(lease: { sandboxID: string; envdAccessToken: string }) {
  return {
    'e2b-sandbox-id': lease.sandboxID,
    'e2b-sandbox-port': '49983',
    'x-access-token': lease.envdAccessToken,
  }
}

function startFrame(line: string): Uint8Array<ArrayBuffer> {
  const payload = new TextEncoder().encode(
    JSON.stringify({ process: { cmd: '/bin/bash', args: ['-l', '-c', line] } }),
  )
  const frame = new Uint8Array(5 + payload.byteLength)
  new DataView(frame.buffer).setUint32(1, payload.byteLength)
  frame.set(payload, 5)
  return frame
}

interface Frame {
  flags: number
  payload: { event?: { data?: { stdout?: string }; end?: { exitCode: number } } }
}

function framesOf(body: Uint8Array): Frame[] {
  const frames: Frame[] = []
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength)
  for (let offset = 0; offset < body.byteLength;) {
    const end = offset + 5 + view.getUint32(offset + 1)
    frames.push({
      flags: view.getUint8(offset),
      payload: JSON.parse(
        new TextDecoder().decode(body.subarray(offset + 5, end)),
      ) as Frame['payload'],
    })
    offset = end
  }
  return frames
}

it('serves create, a command, a stat and health through web requests only', async () => {
  const store = new FakeLeases()
  stores.push(store)
  const lifecycle = lifecycleRoutes({ leases: store })

  const created = await lifecycle(
    new Request(`${ORIGIN}/v2/sandboxes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ timeout: 60, envVars: { GREETING: 'hello' } }),
    }),
    { owner: 'alice' },
  )
  expect(created.status).toBe(201)
  const sandbox = (await created.json()) as { sandboxID: string; envdAccessToken: string }
  expect(store.leases.get(sandbox.sandboxID)?.owner).toBe('alice')
  const headers = sandboxHeaders(sandbox)

  const health = await serve(store, new Request(`${ORIGIN}/health`, { headers }))
  expect(health.status).toBe(204)

  const command = await serve(
    store,
    new Request(`${ORIGIN}/process.Process/Start`, {
      method: 'POST',
      headers: { ...headers, 'content-type': CONNECT_JSON },
      body: startFrame('printf %s "$GREETING" > greeting.txt && cat greeting.txt'),
    }),
  )
  expect(command.status).toBe(200)
  expect(command.headers.get('content-type')).toBe(CONNECT_JSON)
  const frames = framesOf(new Uint8Array(await command.arrayBuffer()))
  const stdout = frames
    .map((frame) => frame.payload.event?.data?.stdout)
    .filter((chunk) => chunk !== undefined)
    .map((chunk) => atob(chunk))
    .join('')
  expect(stdout).toBe('hello')
  expect(frames.at(-2)?.payload.event?.end?.exitCode).toBe(0)
  expect(frames.at(-1)).toEqual({ flags: 2, payload: {} })

  const stat = await serve(
    store,
    new Request(`${ORIGIN}/filesystem.Filesystem/Stat`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'greeting.txt' }),
    }),
  )
  expect(stat.status).toBe(200)
  expect(await stat.json()).toMatchObject({
    entry: { name: 'greeting.txt', type: 'FILE_TYPE_FILE', path: '/home/user/greeting.txt' },
  })

  const missing = await serve(
    store,
    new Request(`${ORIGIN}/health`, { headers: { ...headers, 'e2b-sandbox-id': 'missing' } }),
  )
  expect(missing.status).toBe(502)

  const forged = await serve(
    store,
    new Request(`${ORIGIN}/filesystem.Filesystem/Stat`, {
      method: 'POST',
      headers: { ...headers, 'x-access-token': 'forged', 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'greeting.txt' }),
    }),
  )
  expect(forged.status).toBe(401)
  expect(await forged.json()).toMatchObject({ code: 'unauthenticated' })
})
