import { ABORT_JOIN_MS, abortable, settledWithin } from '@struktoai/mirage-core/utils/abort'
import { SYSTEM_IDS } from '@struktoai/mirage-core/utils/ids'
import { toHex } from '@struktoai/mirage-core/utils/hex'
import type { Workspace } from '@struktoai/mirage-core/workspace/workspace/workspace'
import type { WorkspaceEntry, WorkspaceRegistry } from '../registry.ts'
import { type AccessHeaders, sandboxIdOf, verifyAccess } from './access.ts'
import { SandboxNotRunning } from './errors.ts'
import type { ActiveSandbox, Lease, LeaseRequest, LeaseStore, LiveProcess } from './types.ts'

const MAX_TIMER_DELAY_MS = 2 ** 31 - 1

export class SandboxLease implements Lease, ActiveSandbox {
  timer?: ReturnType<typeof setTimeout>
  readonly processes = new Map<number, LiveProcess>()
  private readonly revocation = new AbortController()
  private readonly files = new Set<Promise<unknown>>()

  constructor(
    readonly entry: WorkspaceEntry,
    readonly accessToken: string,
    readonly envVars: Readonly<Record<string, string>>,
    public expiresAt: number,
  ) {}

  get id(): string {
    return this.entry.id
  }

  get sandboxId(): string {
    return this.entry.id
  }

  get workspace(): string {
    return this.entry.id
  }

  get owner(): string | null {
    return this.entry.owner
  }

  get ws(): Workspace {
    return this.entry.runner.ws
  }

  get revoked(): AbortSignal {
    return this.revocation.signal
  }

  accepting(): boolean {
    return this.entry.acceptingJobs
  }

  live(): boolean {
    return this.entry.acceptingJobs && this.expiresAt > performance.now()
  }

  checkFiles(): void {
    if (this.revoked.aborted || !this.live()) throw new SandboxNotRunning()
  }

  async runFile<T>(closed: AbortSignal, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.checkFiles()
    const signal = AbortSignal.any([this.revoked, closed])
    signal.throwIfAborted()
    const operation = run(signal)
    // The request can leave early, while teardown still owns the backend operation.
    this.files.add(operation)
    void operation
      .finally(() => {
        this.files.delete(operation)
      })
      .catch((error: unknown) => {
        if (signal.aborted && error !== signal.reason) {
          console.debug('sandbox file operation ended after cancellation:', error)
        }
      })
    try {
      const result = await abortable(operation, signal)
      signal.throwIfAborted()
      return result
    } catch (error) {
      signal.throwIfAborted()
      throw error
    }
  }

  async stopFiles(): Promise<void> {
    this.revocation.abort(new SandboxNotRunning())
    if (!(await settledWithin(Promise.allSettled(this.files), ABORT_JOIN_MS / 1000))) {
      console.debug(`sandbox ${this.entry.id} still has file operations after cancellation`)
    }
  }
}

/**
 * The daemon's lease store: leases in memory, each expired by a timer, over
 * workspaces in the daemon's registry. `open` builds a new sandbox's
 * workspace.
 */
export class Sandboxes implements LeaseStore {
  private readonly leases = new Map<string, SandboxLease>()
  private readonly removing = new Set<Promise<WorkspaceEntry>>()

  constructor(
    private readonly registry: WorkspaceRegistry,
    private readonly open: (request: LeaseRequest) => Promise<WorkspaceEntry>,
  ) {}

  async create(request: LeaseRequest): Promise<SandboxLease> {
    const entry = await this.open(request)
    const lease = new SandboxLease(
      entry,
      toHex(SYSTEM_IDS.secureBytes(32)),
      request.envVars,
      performance.now() + request.timeout * 1000,
    )
    this.leases.set(entry.id, lease)
    this.schedule(lease)
    entry.beforeStop = async () => {
      this.forget(lease)
      await lease.stopFiles()
    }
    return lease
  }

  get(id: string): Promise<SandboxLease | null> {
    return Promise.resolve(this.active(id))
  }

  extend(id: string, owner: string | null, timeout: number): Promise<SandboxLease | null> {
    const lease = this.owned(id, owner)
    if (lease !== null) {
      lease.expiresAt = Math.max(lease.expiresAt, performance.now() + timeout * 1000)
      this.schedule(lease)
    }
    return Promise.resolve(lease)
  }

  setTimeout(id: string, owner: string | null, timeout: number): Promise<SandboxLease | null> {
    const lease = this.owned(id, owner)
    if (lease !== null) {
      lease.expiresAt = performance.now() + timeout * 1000
      this.schedule(lease)
    }
    return Promise.resolve(lease)
  }

  async revoke(id: string, owner: string | null): Promise<SandboxLease | null> {
    const lease = this.owned(id, owner)
    if (lease !== null) await this.remove(lease)
    return lease
  }

  requireAccess(headers: AccessHeaders): SandboxLease {
    const id = sandboxIdOf(headers)
    const lease = id === null ? null : this.active(id)
    verifyAccess(headers, lease)
    return lease
  }

  async close(): Promise<void> {
    for (const lease of this.leases.values()) this.expire(lease)
    await Promise.allSettled(this.removing)
  }

  owned(id: string, account: string | null): SandboxLease | null {
    const lease = this.active(id)
    return lease !== null && this.registry.visible(id, account) === lease.entry ? lease : null
  }

  private active(id: string): SandboxLease | null {
    const lease = this.leases.get(id)
    if (lease === undefined) return null
    if (!this.isRegistered(lease)) {
      this.forget(lease)
      return null
    }
    if (lease.expiresAt <= performance.now()) {
      this.expire(lease)
      return null
    }
    return lease
  }

  private isRegistered(lease: SandboxLease): boolean {
    const { entry } = lease
    return entry.acceptingJobs && this.registry.visible(entry.id, entry.owner) === entry
  }

  private forget(lease: SandboxLease): void {
    clearTimeout(lease.timer)
    if (this.leases.get(lease.entry.id) === lease) this.leases.delete(lease.entry.id)
  }

  private async remove(lease: SandboxLease): Promise<void> {
    this.forget(lease)
    if (!this.isRegistered(lease)) return
    const removal = this.registry.remove(lease.entry.id)
    this.removing.add(removal)
    try {
      await removal
    } finally {
      this.removing.delete(removal)
    }
  }

  private expire(lease: SandboxLease): void {
    void this.remove(lease).catch((error: unknown) => {
      console.error(`removing sandbox ${lease.entry.id}:`, error)
    })
  }

  private schedule(lease: SandboxLease): void {
    clearTimeout(lease.timer)
    lease.timer = setTimeout(
      () => {
        if (this.leases.get(lease.entry.id) !== lease) return
        if (!this.isRegistered(lease)) this.forget(lease)
        else if (lease.expiresAt <= performance.now()) this.expire(lease)
        else this.schedule(lease)
      },
      Math.min(MAX_TIMER_DELAY_MS, Math.ceil(lease.expiresAt - performance.now())),
    )
  }
}

/** The in-memory lease store over `registry`, building each workspace with `open`. */
export function memoryLeases(
  registry: WorkspaceRegistry,
  open: (request: LeaseRequest) => Promise<WorkspaceEntry>,
): Sandboxes {
  return new Sandboxes(registry, open)
}
