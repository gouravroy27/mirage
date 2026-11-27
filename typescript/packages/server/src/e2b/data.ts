import { DEFAULT_MAX_REQUEST_BODY_SIZE } from '@modelcontextprotocol/server'
import { closeQuietly } from '@struktoai/mirage-core/io/stream'
import { abortable } from '@struktoai/mirage-core/utils/abort'
import { concat } from '@struktoai/mirage-core/utils/bytes'
import { withCaller } from '@struktoai/mirage-core/workspace/files'
import { Session, type Workspace } from '@struktoai/mirage-core/workspace/workspace/workspace'
import { z } from '@struktoai/mirage-core/vfs/secrets'
import { HttpError } from '../errors.ts'
import { partEvents } from '../multipart.ts'
import type { RouteApp, RouteReply, RouteRequest } from '../routes.ts'
import { sandboxIdOf } from './access.ts'
import { bodyChunks, closeUnreadBody, readJsonBody, unaryContentType } from './body.ts'
import * as constants from './constants.ts'
import { CONNECT_STATUS, FileError, connectCode, fileError } from './errors.ts'
import { SandboxFiles } from './files.ts'
import { registerStart } from './process.ts'
import type { ActiveSandbox, DataAccess, DataHandler, DataSandbox, LiveProcess } from './types.ts'
import { E2BRoutes } from './web.ts'

const Path = z.object({ path: z.string() })
const FileQuery = Path.extend({ username: z.string().optional() })
const List = Path.extend({ depth: z.number().int().default(1) })
const Move = z.object({ source: z.string(), destination: z.string() })

function failure(reply: RouteReply, error: unknown, connect = false): RouteReply {
  if (error instanceof HttpError) {
    for (const [name, value] of Object.entries(error.headers)) reply.header(name, value)
    const code = connect ? connectCode(error.status) : error.status
    return reply.status(error.status).send({ code, message: error.message })
  }
  const mapped = fileError(error)
  if (mapped.code === 'internal') console.warn('sandbox file operation failed', error)
  const status =
    !connect && mapped.code === 'resource_exhausted' ? 507 : CONNECT_STATUS[mapped.code]
  return reply
    .status(status)
    .send({ code: connect ? mapped.code : status, message: mapped.message })
}

function queryPath(request: RouteRequest): string {
  const parsed = FileQuery.safeParse(request.query)
  if (!parsed.success || parsed.data.path === '' || parsed.data.path.includes('\0')) {
    throw new FileError('invalid_argument', 'one file path is required')
  }
  if (parsed.data.username !== undefined && parsed.data.username !== 'user') {
    throw new FileError('invalid_argument', 'only the default sandbox user is supported')
  }
  return parsed.data.path
}

async function* uploadBody(request: RouteRequest, signal: AbortSignal): AsyncGenerator<Uint8Array> {
  let size = 0
  for await (const chunk of bodyChunks(request, signal)) {
    size += chunk.byteLength
    if (size > constants.MAX_UPLOAD_BYTES)
      throw new HttpError('too_large', 'file upload is too large')
    yield chunk
  }
}

async function multipartFile(request: RouteRequest, signal: AbortSignal): Promise<Uint8Array> {
  const contentType = request.headers['content-type'] ?? ''
  if (contentType.split(';', 1)[0]?.trim().toLowerCase() !== 'multipart/form-data') {
    throw new FileError('invalid_argument', 'expected a multipart file upload')
  }
  let found = false
  const chunks: Uint8Array[] = []
  for await (const part of partEvents(uploadBody(request, signal), contentType)) {
    if (part.kind === 'begin') {
      if (found || part.name !== 'file') {
        throw new FileError('invalid_argument', 'expected one file part')
      }
      found = true
    } else if (part.kind === 'data') {
      chunks.push(part.data)
    }
  }
  if (!found) throw new FileError('invalid_argument', 'expected one file part')
  return concat(chunks)
}

function withFiles<T>(
  lease: ActiveSandbox,
  closed: AbortSignal,
  operation: (files: SandboxFiles, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  return lease.runFile(closed, async (signal) => {
    await lease.ws.ensureSessionsLoaded()
    const session = new Session(lease.ws, null)
    signal.throwIfAborted()
    lease.checkFiles()
    return operation(new SandboxFiles(withCaller(session.vfs, { fileSignal: signal })), signal)
  })
}

function downloadOf(
  lease: ActiveSandbox,
  path: string,
  closed: AbortSignal,
): Promise<ReadableStream<Uint8Array>> {
  const canceled = new AbortController()
  const connection = AbortSignal.any([closed, canceled.signal])
  return new Promise((resolve, reject) => {
    const running = withFiles(lease, connection, async (files, signal) => {
      const source = await files.read(path)
      const cursor = source[Symbol.asyncIterator]()
      let finish = (): void => undefined
      const finished = new Promise<void>((done) => {
        finish = done
      })
      let pulling: Promise<IteratorResult<Uint8Array>> | undefined
      let stop: (() => void) | undefined
      try {
        lease.checkFiles()
        signal.throwIfAborted()
        resolve(
          new ReadableStream({
            start(controller) {
              stop = () => {
                controller.error(signal.reason)
                finish()
              }
              signal.addEventListener('abort', stop, { once: true })
            },
            async pull(controller) {
              try {
                lease.checkFiles()
                pulling = cursor.next()
                const next = await pulling
                if (signal.aborted) return
                if (next.done === true) {
                  controller.close()
                  finish()
                } else {
                  controller.enqueue(next.value)
                }
              } catch (error) {
                finish()
                throw error
              } finally {
                pulling = undefined
              }
            },
            cancel(reason) {
              canceled.abort(reason)
              finish()
            },
          }),
        )
        await finished
      } finally {
        if (stop !== undefined) signal.removeEventListener('abort', stop)
        await Promise.allSettled([pulling, closeQuietly(cursor)])
      }
    })
    void running.catch(reject)
  })
}

/**
 * The routes that run against one sandbox's workspace: health, the command
 * stream, upload, download and the filesystem calls. Each finds its sandbox
 * through `access`, which refuses a request it does not admit.
 */
export function registerData(app: RouteApp, access: DataAccess): void {
  registerStart(app, access)
  app.get(constants.HEALTH, (req, reply) => {
    try {
      access.sandbox(req)
    } catch (error) {
      if (!(error instanceof HttpError)) throw error
      if (error.code === 'unauthorized') return reply.status(502).send()
      return reply.status(error.status).send({ code: error.status, message: error.message })
    }
    return reply.status(204).send()
  })
  app.get(constants.FILES, async (request, reply) => {
    try {
      const lease = access.sandbox(request)
      const body = await downloadOf(lease, queryPath(request), request.closed)
      return reply.type('application/octet-stream').header('Cache-Control', 'no-store').send(body)
    } catch (error) {
      return failure(reply, error)
    }
  })

  app.post(constants.FILES, async (request, reply) => {
    try {
      const lease = access.sandbox(request)
      if (Object.keys(request.headers).some((name) => name.startsWith('x-metadata-'))) {
        throw new FileError('unimplemented', 'file metadata is unsupported')
      }
      const path = queryPath(request)
      const data = await multipartFile(request, AbortSignal.any([lease.revoked, request.closed]))
      return await withFiles(lease, request.closed, async (files) => [
        await files.write(path, data),
      ])
    } catch (error) {
      closeUnreadBody(request, reply)
      return failure(reply, error)
    }
  })

  for (const method of constants.METHODS) {
    app.post(constants.RPC_PREFIX + method, { rawBody: true }, async (request, reply) => {
      try {
        const lease = access.sandbox(request)
        unaryContentType(request, constants.CONNECT_STREAM)
        const body = await readJsonBody(
          request,
          AbortSignal.any([lease.revoked, request.closed]),
          DEFAULT_MAX_REQUEST_BODY_SIZE,
        )
        lease.checkFiles()
        if (method === 'Move') {
          const parsed = Move.safeParse(body)
          if (!parsed.success) {
            throw new FileError('invalid_argument', 'expected source and destination paths')
          }
          const { source, destination } = parsed.data
          return await withFiles(lease, request.closed, async (files) => ({
            entry: await files.move(source, destination),
          }))
        }
        if (method === 'ListDir') {
          const parsed = List.safeParse(body)
          if (!parsed.success) {
            throw new FileError('invalid_argument', 'expected a file path and list depth')
          }
          return await withFiles(lease, request.closed, async (files) => ({
            entries: await files.listDir(parsed.data.path, parsed.data.depth),
          }))
        }
        const parsed = Path.safeParse(body)
        if (!parsed.success) throw new FileError('invalid_argument', 'expected a file path')
        return await withFiles(lease, request.closed, async (files) => {
          const { path } = parsed.data
          if (method === 'Stat') return { entry: await files.stat(path) }
          if (method === 'MakeDir') await files.mkdir(path)
          else await files.remove(path)
          return {}
        })
      } catch (error) {
        closeUnreadBody(request, reply)
        return failure(reply, error, true)
      }
    })
  }

  for (const url of constants.UNSUPPORTED_RPC_PATHS) {
    app.post(url, (request, reply) => {
      closeUnreadBody(request, reply)
      try {
        access.sandbox(request)
      } catch (error) {
        return failure(reply, error, true)
      }
      return failure(
        reply,
        new FileError('unimplemented', 'E2B data operation is unsupported by Mirage'),
        true,
      )
    })
  }
}

/**
 * One sandbox for one web request, once the host has checked its access. Its
 * workspace outlives the request, so nothing here revokes it; a command it
 * starts is not kept for the process control routes.
 */
class RequestSandbox implements ActiveSandbox {
  readonly processes = new Map<number, LiveProcess>()
  readonly revoked = new AbortController().signal

  constructor(
    readonly id: string,
    readonly ws: Workspace,
    readonly envVars: Readonly<Record<string, string>>,
  ) {}

  accepting(): boolean {
    return true
  }

  live(): boolean {
    return true
  }

  checkFiles(): void {
    this.revoked.throwIfAborted()
  }

  async runFile<T>(closed: AbortSignal, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    closed.throwIfAborted()
    const result = await abortable(run(closed), closed)
    closed.throwIfAborted()
    return result
  }
}

const WEB = new E2BRoutes<ActiveSandbox>()
registerData(WEB, {
  sandbox: (request) => WEB.contextOf(request),
  draining: () => false,
  transport: (body) => body,
})

/**
 * Answer one data request against `sandbox`, after `checkSandboxAccess` let
 * it through. Process control is not served: its routes answer 404.
 */
export const dataRoutes: DataHandler = (request: Request, sandbox: DataSandbox) =>
  WEB.fetch(
    request,
    null,
    new RequestSandbox(
      sandboxIdOf(Object.fromEntries(request.headers)) ?? '',
      sandbox.workspace,
      sandbox.envVars,
    ),
  )
