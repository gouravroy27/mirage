import { z } from '@struktoai/mirage-core/vfs/secrets'
import { HttpError } from '../errors.ts'
import { MAX_REQUEST_PART } from '../multipart.ts'
import type { RouteApp, RouteReply } from '../routes.ts'
import * as constants from './constants.ts'
import type { Lease, LeaseStore } from './types.ts'

const Timeout = z.number().int().positive().default(constants.DEFAULT_TIMEOUT)
const CreateSandboxRequest = z.looseObject({
  templateID: z.string().default(constants.BASE_TEMPLATE),
  timeout: Timeout,
  envVars: z.record(z.string(), z.string()).default({}),
})
const ConnectSandboxRequest = z.looseObject({ timeout: Timeout })
const SetSandboxTimeoutRequest = z.object({
  timeout: z
    .number()
    .int()
    .nonnegative()
    .max(2 ** 31 - 1),
})

const InertCreateOptions = z.strictObject({
  metadata: z.strictObject({}).optional(),
  allow_internet_access: z.literal(true).optional(),
  autoPause: z.literal(false).optional(),
  autoResume: z.strictObject({ enabled: z.literal(false) }).optional(),
})

interface SandboxParams {
  id: string
}

function unsupportedCreateOption(options: Record<string, unknown>): string | undefined {
  const result = InertCreateOptions.safeParse(options)
  if (result.success) return undefined
  const first = result.error.issues[0]
  if (first?.path[0] !== undefined) return String(first.path[0])
  if (first?.code === 'unrecognized_keys') return first.keys[0] ?? 'unknown'
  return 'unknown'
}

function unsupportedLifecycle(reply: RouteReply, message: string): RouteReply {
  return reply.status(501).send({ code: 501, message })
}

function present(lease: Lease) {
  return {
    sandboxID: lease.sandboxId,
    templateID: constants.BASE_TEMPLATE,
    clientID: lease.sandboxId,
    envdVersion: constants.ENVD_VERSION,
    envdAccessToken: lease.accessToken,
  }
}

function missingSandbox(): HttpError {
  return new HttpError('not_found', 'sandbox not found')
}

/**
 * Create, connect, set timeout and delete, over `leases`; the lifecycle
 * routes E2B serves but Mirage does not answer 501. A sandbox another
 * account owns answers as one that does not exist.
 */
export function registerLifecycle(app: RouteApp, leases: LeaseStore): void {
  app.post(constants.CREATE, { bodyLimit: MAX_REQUEST_PART }, async (req, reply) => {
    const input = CreateSandboxRequest.safeParse(req.body === undefined ? {} : req.body)
    if (!input.success) throw new HttpError('invalid_request', 'invalid sandbox create request')
    const { templateID, timeout, envVars, ...options } = input.data
    const unsupported =
      req.headers['idempotency-key'] === undefined
        ? unsupportedCreateOption(options)
        : 'Idempotency-Key'
    if (unsupported !== undefined) {
      return unsupportedLifecycle(reply, `sandbox create option is unsupported: ${unsupported}`)
    }
    if (templateID !== constants.BASE_TEMPLATE) {
      throw new HttpError('not_found', 'sandbox template not found')
    }
    const lease = await leases.create({ owner: req.account, envVars, timeout })
    void reply.status(201)
    return present(lease)
  })
  app.post<{ Params: SandboxParams }>(
    constants.CONNECT,
    { bodyLimit: MAX_REQUEST_PART },
    async (req, reply) => {
      const input = ConnectSandboxRequest.safeParse(req.body === undefined ? {} : req.body)
      if (!input.success) throw new HttpError('invalid_request', 'invalid sandbox connect request')
      const { timeout, ...options } = input.data
      const invalid = Object.entries(options).find(
        ([name, value]) => name !== 'memory' || value !== true,
      )
      if (invalid !== undefined) {
        return unsupportedLifecycle(reply, `sandbox connect option is unsupported: ${invalid[0]}`)
      }
      const lease = await leases.extend(req.params.id, req.account, timeout)
      if (lease === null) throw missingSandbox()
      return present(lease)
    },
  )
  app.post<{ Params: SandboxParams }>(
    constants.SET_TIMEOUT,
    { bodyLimit: MAX_REQUEST_PART },
    async (req, reply) => {
      const input = SetSandboxTimeoutRequest.safeParse(req.body)
      if (!input.success) throw new HttpError('invalid_request', 'invalid sandbox timeout request')
      if ((await leases.setTimeout(req.params.id, req.account, input.data.timeout)) === null)
        throw missingSandbox()
      return reply.status(204).send()
    },
  )
  app.delete<{ Params: SandboxParams }>(constants.KILL, async (req, reply) => {
    if ((await leases.revoke(req.params.id, req.account)) === null) throw missingSandbox()
    return reply.status(204).send()
  })
  for (const [method, url] of constants.UNSUPPORTED_LIFECYCLE_ROUTES) {
    app.route({
      method,
      url,
      handler: (_req, reply) =>
        unsupportedLifecycle(reply, 'E2B sandbox operation is unsupported by Mirage'),
    })
  }
}

