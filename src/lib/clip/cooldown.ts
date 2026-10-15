/**
 * A process-local cooldown gate.
 *
 * Used to pause Instagram resolution after the platform rate-limits us. The
 * resolve path fans out hard — a session GET plus several GraphQL POSTs per
 * attempt, and the client retries the whole thing too — so continuing to hammer
 * a limiter that has already tripped keeps it tripped and turns one failed post
 * into every post failing for minutes. While the cooldown is active callers
 * fail fast instead of spending more requests, letting the limit reset.
 */
export class Cooldown {
  private until = 0;

  /** True while the cooldown window is still in effect. */
  active(now: number = Date.now()): boolean {
    return now < this.until;
  }

  /** Milliseconds left in the window (0 when inactive). */
  remainingMs(now: number = Date.now()): number {
    return Math.max(0, this.until - now);
  }

  /** Extend the window to at least `ms` from `now`; never shortens it. */
  trip(ms: number, now: number = Date.now()): void {
    this.until = Math.max(this.until, now + ms);
  }

  clear(): void {
    this.until = 0;
  }
}
