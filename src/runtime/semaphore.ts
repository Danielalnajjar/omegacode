/** A minimal FIFO async semaphore: at most `limit` holders at once. */
export class Semaphore {
  private active = 0
  private readonly queue: Array<() => void> = []
  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError(`Semaphore limit must be a positive integer, got ${limit}`)
    }
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted()
    if (this.active < this.limit) {
      this.active++
      return this.makeRelease()
    }
    await new Promise<void>((resolve, reject) => {
      const wake = () => {
        signal?.removeEventListener("abort", abort)
        resolve()
      }
      const abort = () => {
        const index = this.queue.indexOf(wake)
        if (index >= 0) this.queue.splice(index, 1)
        signal?.removeEventListener("abort", abort)
        reject(signal?.reason)
      }
      this.queue.push(wake)
      signal?.addEventListener("abort", abort, { once: true })
    })
    // The waker hands off our slot without decrementing `active`, so we hold a reserved slot here.
    return this.makeRelease()
  }

  private makeRelease(): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      const next = this.queue.shift()
      if (next) {
        // Hand the slot directly to the next waiter — do NOT decrement `active`, or a fast-path
        // acquire() racing between here and the waiter's resume would over-admit past `limit`.
        next()
      } else {
        this.active--
      }
    }
  }

  async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const release = await this.acquire(signal)
    try {
      signal?.throwIfAborted()
      return await fn()
    } finally {
      release()
    }
  }
}
