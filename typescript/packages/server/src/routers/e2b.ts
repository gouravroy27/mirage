import { Readable } from 'node:stream'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'
import type { ResourceStore } from '@struktoai/mirage-core/resources/base'
import { ResourceError } from '@struktoai/mirage-core/resources/errors'
import type { JsonValue } from '@struktoai/mirage-core/types'
import { isDataRequest, isLifecycleRequest } from '../e2b/access.ts'
import * as constants from '../e2b/constants.ts'
import { registerData } from '../e2b/data.ts'
import { registerLifecycle } from '../e2b/lifecycle.ts'
import { registerControl } from '../e2b/process.ts'
import type { Sandboxes, SandboxLease } from '../e2b/sandbox.ts'
import type { DataAccess, LeaseRequest } from '../e2b/types.ts'
import { HttpError } from '../errors.ts'
import type { WorkspaceEntry } from '../registry.ts'
import type { RouteApp, RouteRequest } from '../routes.ts'
import { storeRefusal } from './templates.ts'
import { createEphemeralWorkspace, type WorkspaceRoutesDeps } from './workspaces.ts'

export function sandboxAccount(
  sandboxes: Sandboxes | null,
  headers: Parameters<Sandboxes['requireAccess']>[0],
): string | null {
  return sandboxAccess(sandboxes, headers)?.entry.owner ?? null
}

function sandboxAccess(
  sandboxes: Sandboxes | null,
  headers: Parameters<Sandboxes['requireAccess']>[0],
): SandboxLease | null {
  try {
    return sandboxes?.requireAccess(headers) ?? null
  } catch (error) {
    if (!(error instanceof HttpError)) throw error
    console.debug('sandbox access could not be verified:', error.message)
    return null
  }
}

export function sandboxWorkspace(
  sandboxes: Sandboxes | null,
  path: string,
  request: Pick<RouteRequest, 'method' | 'params' | 'account'> & {
    headers: Parameters<Sandboxes['requireAccess']>[0]
  },
): string | null {
  if (sandboxes === null) return null
  if (isDataRequest(request.method, path)) {
    return sandboxAccess(sandboxes, request.headers)?.entry.id ?? null
  }
  const { params } = request
  if (
    !isLifecycleRequest(request.method, path) ||
    typeof params !== 'object' ||
    params === null ||
    !('id' in params) ||
    typeof params.id !== 'string'
  ) {
    return null
  }
  return sandboxes.owned(params.id, request.account)?.entry.id ?? null
}

/**
 * Build a new sandbox's workspace: the server's `base` template when it
 * keeps one, else a writable home over a read-only root.
 */
export function sandboxWorkspaces(
  deps: WorkspaceRoutesDeps & { resources: ResourceStore },
): (request: LeaseRequest) => Promise<WorkspaceEntry> {
  return async ({ owner }) => {
    let config: Record<string, JsonValue> = {
      mode: 'read',
      mounts: { [constants.HOME]: { vfs: 'ram', mode: 'write' } },
      env: { HOME: constants.HOME },
    }
    if (!deps.registry.accountsRequired) {
      try {
        config = (await deps.resources.getTemplate(constants.BASE_TEMPLATE)).config
      } catch (error) {
        if (!(error instanceof ResourceError)) throw error
        if (error.code !== 'not_found') throw storeRefusal(error)
        console.debug('using the built-in E2B base:', error.message)
      }
    }
    const entry = await createEphemeralWorkspace(deps, owner, config)
    if (deps.registry.draining) {
      await deps.registry.remove(entry.id)
      throw new HttpError('shutting_down', 'server is shutting down')
    }
    return entry
  }
}

function nodeCommandStream(body: ReadableStream<Uint8Array>, stalled: AbortSignal): Readable {
  const stream = Readable.fromWeb(body as NodeReadableStream<Uint8Array>)
  stalled.addEventListener('abort', () => stream.destroy(), { once: true })
  return stream
}

/** The daemon's E2B routes: lifecycle, data and process control over `sandboxes`. */
export function router(
  app: RouteApp,
  deps: Pick<WorkspaceRoutesDeps, 'registry'> & { sandboxes: Sandboxes },
): void {
  const { sandboxes, registry } = deps
  const access: DataAccess = {
    sandbox: (request) => sandboxes.requireAccess(request.headers),
    draining: () => registry.draining,
    transport: nodeCommandStream,
  }
  registerLifecycle(app, sandboxes)
  registerData(app, access)
  registerControl(app, access)
}
