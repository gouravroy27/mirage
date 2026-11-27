import { HttpError } from '../errors.ts'
import * as constants from './constants.ts'
import { connectCode, SandboxNotRunning } from './errors.ts'
import { isProcessRequest, isProcessStart } from './process.ts'
import type { Lease } from './types.ts'

export type AccessHeaders = Readonly<Record<string, string | readonly string[] | undefined>>

export function isLifecycleRequest(method: string, path: string): boolean {
  return (
    (method === 'POST' &&
      (path === constants.CREATE ||
        path === constants.CONNECT ||
        path === constants.SET_TIMEOUT)) ||
    (method === 'DELETE' && path === constants.KILL) ||
    constants.UNSUPPORTED_LIFECYCLE_ROUTES.some(
      ([verb, route]) => method === verb && path === route,
    )
  )
}

export function isDataRequest(method: string, path: string): boolean {
  return (
    (method === 'GET' && (path === constants.HEALTH || path === constants.FILES)) ||
    (method === 'POST' && (path === constants.FILES || constants.RPC_PATHS.has(path))) ||
    isProcessRequest(method, path)
  )
}

export function acceptsRawBody(method: string, path: string, contentType: string): boolean {
  if (contentType === constants.CONNECT_STREAM) {
    return (
      isProcessStart(method, path) ||
      (method === 'POST' && constants.UNSUPPORTED_RPC_PATHS.includes(path))
    )
  }
  return method === 'POST' && path === constants.FILES
}

/** An error's answer on `route`: a Connect code on a data route, the status elsewhere. */
export function errorBody(method: string, route: string, error: HttpError) {
  return {
    code: isDataRequest(method, route) ? connectCode(error.status) : error.status,
    message: error.message,
  }
}

/** Whether two tokens match, in time that depends only on their length. */
function sameToken(expected: string, presented: string): boolean {
  const left = new TextEncoder().encode(expected)
  const right = new TextEncoder().encode(presented)
  if (left.length !== right.length) return false
  let difference = 0
  left.forEach((byte, i) => {
    difference |= byte ^ (right[i] ?? 0)
  })
  return difference === 0
}

/** The sandbox a data request's routing headers name, or null. */
export function sandboxIdOf(headers: AccessHeaders): string | null {
  const id = headers['e2b-sandbox-id']
  if (typeof id !== 'string' || id === '' || headers['e2b-sandbox-port'] !== constants.ENVD_PORT) {
    return null
  }
  return id
}

/** Refuse a data request that `lease`, the live lease its headers name, does not admit. */
export function verifyAccess<L extends Lease>(
  headers: AccessHeaders,
  lease: L | null,
): asserts lease is L {
  const id = sandboxIdOf(headers)
  if (id === null) throw new HttpError('invalid_request', 'invalid sandbox routing headers')
  const token = headers['x-access-token']
  if (typeof token !== 'string' || token === '') {
    throw new HttpError('unauthorized', 'invalid sandbox access token')
  }
  if (lease?.sandboxId !== id) throw new SandboxNotRunning()
  if (!sameToken(lease.accessToken, token)) {
    throw new HttpError('unauthorized', 'invalid sandbox access token')
  }
  const authorization = headers.authorization
  if (
    typeof authorization === 'string' &&
    /^basic /i.test(authorization) &&
    authorization.slice(6) !== 'dXNlcjo='
  ) {
    throw new HttpError('invalid_request', 'only the default sandbox user is supported')
  }
}

export function headersOf(request: Request): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const [name, value] of request.headers) headers[name] = value
  return headers
}

/**
 * The answer that refuses a data request, or null when it may proceed: the
 * daemon's own answers, so every host refuses alike. A live health check
 * answers 204; one the daemon would refuse with 401 answers 502, as E2B's
 * proxy does for a sandbox that is gone.
 */
export function checkSandboxAccess(request: Request, lease: Lease | null): Response | null {
  const path = new URL(request.url).pathname
  const health = path === constants.HEALTH
  try {
    verifyAccess(headersOf(request), lease)
  } catch (error) {
    if (!(error instanceof HttpError)) throw error
    if (health && error.code === 'unauthorized') return new Response(null, { status: 502 })
    const code = health || path === constants.FILES ? error.status : connectCode(error.status)
    return Response.json({ code, message: error.message }, { status: error.status })
  }
  return health ? new Response(null, { status: 204 }) : null
}
