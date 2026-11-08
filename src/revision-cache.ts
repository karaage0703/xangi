/** Short-lived index: explicit invalidation is immediate; expiry repairs missed file events. */
export class RevisionCache<T> {
  private value: T | undefined;
  private expires = 0;
  constructor(private readonly ttlMs = 1000) {}
  invalidate(): void {
    this.value = undefined;
  }
  get(build: () => T): T {
    if (this.value === undefined || Date.now() >= this.expires) {
      this.value = build();
      this.expires = Date.now() + this.ttlMs;
    }
    return this.value;
  }
}
