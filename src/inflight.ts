/** Tracks background webhook work so shutdown and tests can wait for it. */
export class InFlight {
  private pending = 0;
  private waiters: Array<() => void> = [];

  track(promise: Promise<unknown>): void {
    this.pending += 1;
    promise.finally(() => {
      this.pending -= 1;
      if (this.pending === 0) {
        const waiters = this.waiters;
        this.waiters = [];
        for (const resolve of waiters) resolve();
      }
    });
  }

  idle(): Promise<void> {
    if (this.pending === 0) return Promise.resolve();
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }

  get size(): number {
    return this.pending;
  }
}
