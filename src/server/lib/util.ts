export const LAMPORTS_PER_SOL = 1_000_000_000;
export const TOKEN_DECIMALS = 6;
export const TOKEN_UNIT = 10 ** TOKEN_DECIMALS;

export const now = (): number => Date.now();
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export const lamportsToSol = (l: bigint | number): number => Number(l) / LAMPORTS_PER_SOL;
export const solToLamports = (s: number): bigint => BigInt(Math.floor(s * LAMPORTS_PER_SOL));

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export function round(v: number, digits = 6): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

export function pctChange(from: number, to: number): number {
  if (from === 0) return 0;
  return ((to - from) / from) * 100;
}

export function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}

export function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

/** Token bucket used to keep RPC/HTTP providers under their documented rate limits. */
export class RateLimiter {
  private tokens: number;
  private last = Date.now();
  private queue: Array<() => void> = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly ratePerSec: number,
    private readonly burst = Math.max(1, Math.ceil(ratePerSec)),
  ) {
    this.tokens = burst;
  }

  private refill() {
    const t = Date.now();
    this.tokens = Math.min(this.burst, this.tokens + ((t - this.last) / 1000) * this.ratePerSec);
    this.last = t;
  }

  acquire(): Promise<void> {
    return new Promise((resolve) => {
      this.queue.push(resolve);
      this.drain();
    });
  }

  get pending(): number {
    return this.queue.length;
  }

  private drain() {
    this.refill();
    while (this.queue.length && this.tokens >= 1) {
      this.tokens -= 1;
      this.queue.shift()!();
    }
    if (this.queue.length && !this.timer) {
      const wait = Math.ceil(((1 - this.tokens) / this.ratePerSec) * 1000);
      this.timer = setTimeout(() => {
        this.timer = null;
        this.drain();
      }, Math.max(5, wait));
    }
  }
}

/** Fixed-capacity FIFO buffer. */
export class Ring<T> {
  private items: T[] = [];
  constructor(private readonly capacity: number) {}
  push(item: T) {
    this.items.push(item);
    if (this.items.length > this.capacity) this.items.splice(0, this.items.length - this.capacity);
  }
  toArray(): T[] {
    return this.items;
  }
  get length() {
    return this.items.length;
  }
  last(): T | undefined {
    return this.items[this.items.length - 1];
  }
  prune(keep: (t: T) => boolean) {
    const idx = this.items.findIndex(keep);
    if (idx === -1) this.items = [];
    else if (idx > 0) this.items = this.items.slice(idx);
  }
}

export function utcDay(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}
