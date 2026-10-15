// Seeded pseudo-random numbers and text for the fixture generator.
//
// Every fixture the harness feeds a binary is generated, never copied from a
// real machine (hx is a public repository). The generator must produce the
// same tree for the same seed on every run, so both binaries see identical
// inputs: this is a small xoshiro128** with a string seed, plus a word list
// that reads like a transcript without being one.

export class Prng {
  private s: Uint32Array;

  constructor(seed: string) {
    // splitmix-style seeding from a string hash, so any seed text works.
    let h = 0x9e3779b9 ^ seed.length;
    for (let i = 0; i < seed.length; i++) {
      h = Math.imul(h ^ seed.charCodeAt(i), 0x85ebca6b);
      h ^= h >>> 13;
    }
    const s = new Uint32Array(4);
    for (let i = 0; i < 4; i++) {
      h = (h + 0x9e3779b9) | 0;
      let z = h;
      z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
      z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
      s[i] = (z ^ (z >>> 16)) >>> 0;
    }
    if (s.every((v) => v === 0)) s[0] = 1;
    this.s = s;
  }

  /** Uniform 32-bit unsigned integer. */
  u32(): number {
    const s = this.s;
    const result = Math.imul(rotl(Math.imul(s[1]!, 5), 7), 9) >>> 0;
    const t = s[1]! << 9;
    s[2]! ^= s[0]!;
    s[3]! ^= s[1]!;
    s[1]! ^= s[2]!;
    s[0]! ^= s[3]!;
    s[2]! ^= t;
    s[3] = rotl(s[3]!, 11);
    return result;
  }

  /** Uniform float in [0, 1). */
  float(): number {
    return this.u32() / 4294967296;
  }

  /** Uniform integer in [min, max]. */
  int(min: number, max: number): number {
    return min + Math.floor(this.float() * (max - min + 1));
  }

  pick<T>(items: readonly T[]): T {
    return items[this.int(0, items.length - 1)]!;
  }

  /** A UUID v4 drawn from this generator (not from crypto): reproducible. */
  uuid(): string {
    const hex = "0123456789abcdef";
    let out = "";
    for (let i = 0; i < 32; i++) {
      let n = this.int(0, 15);
      if (i === 12) n = 4;
      if (i === 16) n = (n & 0x3) | 0x8;
      out += hex[n];
      if (i === 7 || i === 11 || i === 15 || i === 19) out += "-";
    }
    return out;
  }

  /** `n` lowercase alphanumerics, the shape mkdtemp and ids use. */
  alnum(n: number): string {
    const a = "abcdefghijklmnopqrstuvwxyz0123456789";
    let out = "";
    for (let i = 0; i < n; i++) out += a[this.int(0, a.length - 1)];
    return out;
  }

  /** A sentence of `words` words from the fixture vocabulary. */
  sentence(words: number): string {
    const out: string[] = [];
    for (let i = 0; i < words; i++) out.push(this.pick(WORDS));
    const s = out.join(" ");
    return s.charAt(0).toUpperCase() + s.slice(1) + ".";
  }

  /** Several sentences, about `approxChars` characters long. */
  paragraph(approxChars: number): string {
    const parts: string[] = [];
    let len = 0;
    while (len < approxChars) {
      const s = this.sentence(this.int(4, 14));
      parts.push(s);
      len += s.length + 1;
    }
    return parts.join(" ");
  }
}

function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

// Plain words only: nothing here can be mistaken for a real transcript.
const WORDS = [
  "the", "build", "passes", "after", "the", "retry", "and", "the", "cache", "warms",
  "slowly", "before", "every", "deploy", "while", "tests", "run", "under", "load",
  "config", "value", "default", "branch", "commit", "merge", "review", "fix", "typo",
  "handler", "request", "response", "timeout", "socket", "buffer", "offset", "chunk",
  "upload", "commit", "verify", "state", "file", "watch", "poll", "tick", "pass",
  "session", "agent", "tool", "result", "input", "output", "error", "warning", "ok",
  "small", "large", "fast", "slow", "first", "last", "next", "previous", "same",
  "different", "again", "once", "twice", "never", "always", "sometimes", "mostly",
  "read", "write", "open", "close", "start", "stop", "restart", "pause", "resume",
];
