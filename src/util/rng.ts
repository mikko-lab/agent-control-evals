import { createHash } from "node:crypto";

/**
 * Deterministic PRNG for corpus generation.
 *
 * Each stream is derived from sha256(seed || ":" || streamName). Numbers are
 * produced from successive sha256 blocks (counter mode), using only integer
 * arithmetic, so output is identical across Node versions, platforms and
 * locales. No Math.random, no wall clock, no crypto.randomUUID.
 */
export class Rng {
  private counter = 0;
  private buf: Buffer = Buffer.alloc(0);
  private off = 0;
  private readonly key: string;

  constructor(seed: string, stream: string) {
    this.key = `${seed}:${stream}`;
  }

  private refill(): void {
    this.buf = createHash("sha256").update(`${this.key}:${this.counter++}`).digest();
    this.off = 0;
  }

  /** Uniform 32-bit unsigned integer. */
  u32(): number {
    if (this.off + 4 > this.buf.length) this.refill();
    const v = this.buf.readUInt32BE(this.off);
    this.off += 4;
    return v;
  }

  /** Uniform integer in [min, max] (inclusive), rejection sampling (no modulo bias). */
  int(min: number, max: number): number {
    if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || max < min) {
      throw new Error(`Rng.int: invalid range [${min}, ${max}]`);
    }
    const span = max - min + 1;
    if (span > 0x1_0000_0000) {
      // Compose two draws for large spans (still integer-exact for spans < 2^53).
      const hi = this.int(0, Math.floor((span - 1) / 0x1_0000_0000));
      const lo = this.u32();
      const v = hi * 0x1_0000_0000 + lo;
      return v < span ? min + v : this.int(min, max);
    }
    const limit = Math.floor(0x1_0000_0000 / span) * span;
    for (;;) {
      const v = this.u32();
      if (v < limit) return min + (v % span);
    }
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error("Rng.pick: empty list");
    return items[this.int(0, items.length - 1)];
  }

  hex(bytes: number): string {
    let out = "";
    while (out.length < bytes * 2) out += this.u32().toString(16).padStart(8, "0");
    return out.slice(0, bytes * 2);
  }
}
