import { RAW_BODIES } from '../constants.ts'
import { errorOf, HttpError } from '../errors.ts'
import type {
  RouteApp,
  RouteConfig,
  RouteHandler,
  RouteMethod,
  RouteOptions,
  RouteReply,
  RouteRequest,
} from '../routes.ts'
import { acceptsRawBody, errorBody } from './access.ts'
import { parseJson, readBody } from './body.ts'
import * as constants from './constants.ts'

/** Fastify's default: the largest body a route reads unless it names its own. */
const BODY_LIMIT = 1024 * 1024
const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])

interface Route {
  readonly method: string
  readonly url: string
  readonly pattern: RegExp
  readonly keys: readonly string[]
  readonly config: RouteConfig
  readonly handler: RouteHandler
}

function compile(path: string): { pattern: RegExp; keys: string[] } {
  const keys: string[] = []
  const source = path
    .split('/')
    .map((segment) => {
      if (!segment.startsWith(':')) return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      keys.push(segment.slice(1))
      return '([^/]+)'
    })
    .join('/')
  return { pattern: new RegExp(`^${source}$`), keys }
}

function queryOf(params: URLSearchParams): Record<string, string | string[]> {
  const query: Record<string, string | string[]> = {}
  for (const [key, value] of params) {
    const held = query[key]
    query[key] = held === undefined ? value : Array.isArray(held) ? [...held, value] : [held, value]
  }
  return query
}

class WebReply implements RouteReply {
  statusCode = 200
  sent = false
  readonly headers = new Headers()
  payload: unknown = undefined

  status(code: number): this {
    this.statusCode = code
    return this
  }

  code(code: number): this {
    return this.status(code)
  }

  header(name: string, value: string | number): this {
    this.headers.set(name, String(value))
    return this
  }

  type(contentType: string): this {
    return this.header('content-type', contentType)
  }

  send(payload?: unknown): this {
    this.payload = payload
    this.sent = true
    return this
  }

  response(): Response {
    const { payload, headers, statusCode: status } = this
    if (payload === undefined || status === 204 || status === 304) {
      return new Response(null, { status, headers })
    }
    if (payload instanceof ReadableStream) return new Response(payload, { status, headers })
    if (payload instanceof Uint8Array) {
      if (!headers.has('content-type')) headers.set('content-type', 'application/octet-stream')
      return new Response(payload as Uint8Array<ArrayBuffer>, { status, headers })
    }
    if (typeof payload === 'string') {
      if (!headers.has('content-type')) headers.set('content-type', 'text/plain; charset=utf-8')
      return new Response(payload, { status, headers })
    }
    if (!headers.has('content-type')) headers.set('content-type', 'application/json; charset=utf-8')
    return new Response(JSON.stringify(payload), { status, headers })
  }
}

function refusal(method: string, url: string, error: unknown): Response {
  const failure = errorOf(error)
  const reply = new WebReply()
  for (const [name, value] of Object.entries(failure.headers)) reply.header(name, value)
  return reply
    .status(failure.status)
    .send(errorBody(method, url, failure))
    .response()
}

/**
 * The E2B routes on a web `Request`/`Response` host, reading bodies and
 * answering errors as the daemon's E2B listener does. Each request carries a
 * host value of type `C` its routes reach through `contextOf`.
 */
export class E2BRoutes<C> implements RouteApp {
  private readonly routes: Route[] = []
  private readonly contexts = new WeakMap<RouteRequest, C>()

  readonly get = this.method('GET')
  readonly post = this.method('POST')
  readonly put = this.method('PUT')
  readonly patch = this.method('PATCH')
  readonly delete = this.method('DELETE')

  route<S extends object>(options: RouteOptions<S>): void {
    const { method, url, handler, ...config } = options
    const { pattern, keys } = compile(url)
    for (const name of typeof method === 'string' ? [method] : method) {
      this.routes.push({
        method: name,
        url,
        pattern,
        keys,
        config,
        handler: handler as RouteHandler,
      })
    }
  }

  contextOf(request: RouteRequest): C {
    if (!this.contexts.has(request)) throw new Error('E2B route request has no host context')
    return this.contexts.get(request) as C
  }

  /** Answer `request` as `account` (null when the auth mode names none). */
  async fetch(request: Request, account: string | null, context: C): Promise<Response> {
    const url = new URL(request.url)
    const method = request.method === 'HEAD' ? 'GET' : request.method
    let found: [Route, Record<string, string>] | null
    try {
      found = this.match(method, url.pathname)
    } catch (error) {
      if (!(error instanceof URIError)) throw error
      return refusal(method, '', new HttpError('invalid_request', 'path is not percent-encoded'))
    }
    if (found === null) return refusal(method, '', new HttpError('not_found', 'not found'))
    const [route, params] = found
    const headers: Record<string, string> = {}
    for (const [name, value] of request.headers) headers[name] = value
    const base = {
      query: queryOf(url.searchParams),
      params,
      headers,
      url: url.pathname + url.search,
      method: request.method,
      ip: '',
      protocol: url.protocol.slice(0, -1),
      host: url.host,
      account,
      raw: (request.body ??
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close()
          },
        })) as unknown as AsyncIterable<Uint8Array>,
      closed: request.signal,
    }
    const reply = new WebReply()
    try {
      const req: RouteRequest = { ...base, body: await this.bodyOf(request, base, route) }
      this.contexts.set(req, context)
      const answer = await route.handler(req, reply)
      if (!reply.sent && answer !== undefined && answer !== reply) reply.send(answer)
    } catch (error) {
      return refusal(method, route.url, error)
    }
    return reply.response()
  }

  /**
   * The body read as JSON whatever its Content-Type says, as the daemon's
   * E2B listener reads one: left unread on a raw route or a raw upload the
   * route takes, and refused when a raw type reaches a unary route.
   */
  private async bodyOf(
    request: Request,
    base: Omit<RouteRequest, 'body'>,
    route: Route,
  ): Promise<unknown> {
    if (route.config.rawBody === true || !BODY_METHODS.has(request.method)) return undefined
    if (request.body === null) return undefined
    const media = (request.headers.get('content-type') ?? '').split(';', 1)[0]?.trim().toLowerCase()
    if (media !== undefined && (RAW_BODIES.test(media) || media === constants.CONNECT_STREAM)) {
      if (acceptsRawBody(request.method, route.url, media)) return undefined
      throw new HttpError('invalid_request', 'expected JSON on a unary E2B route', {
        headers: { connection: 'close' },
      })
    }
    const bytes = await readBody(
      { ...base, body: undefined },
      request.signal,
      route.config.bodyLimit ?? BODY_LIMIT,
    )
    return parseJson(bytes)
  }

  private method(name: string): RouteMethod {
    return (path: string, configOrHandler: RouteConfig | RouteHandler, handler?: RouteHandler) => {
      const [config, run] =
        handler === undefined
          ? [{}, configOrHandler as RouteHandler]
          : [configOrHandler as RouteConfig, handler]
      this.route({ method: name, url: path, ...config, handler: run })
    }
  }

  /** The route a path takes, a static segment winning over a parameter as Fastify's does. */
  private match(method: string, path: string): [Route, Record<string, string>] | null {
    let best: [Route, Record<string, string>] | null = null
    for (const route of this.routes) {
      if (route.method !== method) continue
      const hit = route.pattern.exec(path)
      if (hit === null) continue
      if (best !== null && best[0].keys.length <= route.keys.length) continue
      const params: Record<string, string> = {}
      route.keys.forEach((key, i) => {
        params[key] = decodeURIComponent(hit[i + 1] ?? '')
      })
      best = [route, params]
    }
    return best
  }
}
