export interface BreakerOptions {
  threshold: number;
  cooldownMs: number;
  probe: number;
  now?: () => number;
}

export class CircuitBreaker {
  private failures = 0;
  private openedAt: number | null = null;
  private probesGranted = 0;
  private readonly threshold: number;
  private readonly cooldownMs: number;
  private readonly probe: number;
  private readonly now: () => number;

  constructor(options: BreakerOptions) {
    this.threshold = options.threshold;
    this.cooldownMs = options.cooldownMs;
    this.probe = options.probe;
    this.now = options.now ?? Date.now;
  }

  get open(): boolean {
    return this.openedAt !== null;
  }

  get consecutiveFailures(): number {
    return this.failures;
  }

  canRequest(): boolean {
    if (this.openedAt === null) return true;
    if (this.now() - this.openedAt < this.cooldownMs) return false;
    if (this.probesGranted >= this.probe) return false;
    this.probesGranted += 1;
    return true;
  }

  onSuccess(): void {
    this.failures = 0;
    this.openedAt = null;
    this.probesGranted = 0;
  }

  onFailure(): void {
    this.failures += 1;
    if (this.openedAt === null) {
      if (this.failures >= this.threshold) {
        this.openedAt = this.now();
        this.probesGranted = 0;
      }
      return;
    }
    // A failed probe restarts the cooldown; the breaker stays open.
    this.openedAt = this.now();
    this.probesGranted = 0;
  }
}
