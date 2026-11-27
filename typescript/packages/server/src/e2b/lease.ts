import type { Workspace } from '@struktoai/mirage-core/workspace/workspace/workspace'

/** Who asks for a lifecycle operation; null when the auth mode names no account. */
export interface Caller {
  readonly owner: string | null
}

/**
 * One live sandbox as a host stores it. The sandbox id is what the E2B SDK
 * sends back in `E2B-Sandbox-Id`; `workspace` is the Mirage workspace it
 * runs in, the same id on the daemon.
 */
export interface Lease extends Caller {
  readonly sandboxId: string
  readonly workspace: string
  readonly accessToken: string
  readonly envVars: Readonly<Record<string, string>>
}

export interface LeaseRequest extends Caller {
  readonly envVars: Readonly<Record<string, string>>
  /** Seconds until the sandbox expires. */
  readonly timeout: number
}

/**
 * Where a host keeps its sandboxes: the one thing that differs between the
 * daemon (in memory, with timers) and a hosted deployment (durable storage).
 * Each store owns expiry: `get` answers live leases only. A method that takes
 * an owner answers null when the sandbox is gone or belongs to someone else,
 * which the lifecycle routes answer as 404.
 */
export interface LeaseStore {
  /** Make the sandbox's workspace and its lease. */
  create(request: LeaseRequest): Promise<Lease>
  get(sandboxId: string): Promise<Lease | null>
  /** Reconnect: keep the later of the current expiry and `timeout` seconds from now. */
  extend(sandboxId: string, owner: string | null, timeout: number): Promise<Lease | null>
  /** Expire `timeout` seconds from now; 0 revokes access at once. */
  setTimeout(sandboxId: string, owner: string | null, timeout: number): Promise<Lease | null>
  /** Delete the sandbox and its workspace. */
  revoke(sandboxId: string, owner: string | null): Promise<Lease | null>
}

/**
 * Create, connect, set timeout and delete, on web `Request`/`Response`.
 * Owns the request schemas, the lease rules and the SDK's response shape.
 */
export type LifecycleHandler = (request: Request, caller: Caller) => Promise<Response>

/**
 * The refusal for a data request, or null when it may proceed: 400 for bad
 * routing headers, 401 for a missing, expired or wrong token, 502 instead
 * of 401 on `/health`, and 204 for a live health check.
 */
export type AccessCheck = (request: Request, lease: Lease | null) => Response | null

/** The one workspace a data request runs against, after its access check. */
export interface DataSandbox {
  readonly workspace: Workspace
  readonly envVars: Readonly<Record<string, string>>
}

/** Command stream, upload, download, stat, list, mkdir, move and remove. */
export type DataHandler = (request: Request, sandbox: DataSandbox) => Promise<Response>
