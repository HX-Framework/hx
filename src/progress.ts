// Terminal download progress bar for `hx update`, matching the look of the
// `curl … | sh` installer (packages/hx-install-script/src/index.ts): a dim
// label, a blue block-glyph bar, and a percent, redrawn in place as bytes
// arrive — Downloading → Unpacking → Verifying → 100%.
//
// Like install.sh, we only animate when stderr is a real TTY. Piped or
// redirected runs (CI, `hx update > log`, `2>file`) get plain one-line
// breadcrumbs instead, with no carriage-return cruft. Everything goes to
// stderr so whatever the caller reads off stdout stays clean.
//
// The glyphs (█░ vs #-), the blue accent (256-colour 39), the 24-cell width,
// and the indeterminate "sliding block" pulse are all carried over verbatim
// from the installer so the two surfaces look identical.

const BAR_WIDTH = 24;

export class ProgressBar {
  private readonly out: NodeJS.WriteStream;
  private readonly tty: boolean;
  private readonly glyphFull: string;
  private readonly glyphEmpty: string;
  // ANSI control strings — empty when not a TTY so the same templates render
  // as plain text (they're only ever written under `if (this.tty)` anyway).
  private readonly esc: string;
  private readonly cr: string;
  private readonly clr: string;
  private readonly dim: string;
  private readonly acc: string;
  private readonly rst: string;
  private cursorHidden = false;
  // Throttle: skip a redraw when the rendered (label, percent) hasn't changed,
  // so a 24 MB download repaints ~once per percent rather than once per chunk.
  private lastKey = "";

  constructor(out: NodeJS.WriteStream = process.stderr) {
    this.out = out;
    this.tty = Boolean(out.isTTY);

    // Block-glyph bar on a UTF-8 locale; ASCII fallback otherwise — same
    // detection install.sh does off LC_ALL / LC_CTYPE / LANG.
    const locale = process.env.LC_ALL ?? process.env.LC_CTYPE ?? process.env.LANG ?? "";
    const utf8 = /utf-?8/i.test(locale);
    this.glyphFull = utf8 ? "█" : "#";
    this.glyphEmpty = utf8 ? "░" : "-";

    if (this.tty) {
      this.esc = "\x1b";
      this.cr = "\r";
      this.clr = "\x1b[K";
      this.dim = "\x1b[2m";
      this.acc = "\x1b[38;5;39m";
      this.rst = "\x1b[0m";
    } else {
      this.esc = this.cr = this.clr = this.dim = this.acc = this.rst = "";
    }
  }

  /** Whether this bar animates (stderr is a TTY). */
  get isTTY(): boolean {
    return this.tty;
  }

  /**
   * Plain one-line breadcrumb for the non-TTY path (CI / piped / redirected).
   * No-op on a TTY, where the animated bar carries the same information.
   */
  status(msg: string): void {
    if (this.tty) return;
    this.out.write(`  ${msg}\n`);
  }

  /** Determinate bar: dim label + blue bar + percent, redrawn in place. */
  draw(pct: number, label: string): void {
    if (!this.tty) return;
    const p = clampPct(pct);
    const key = `${label}:${p}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    const filled = Math.floor((p * BAR_WIDTH) / 100);
    const bar = this.glyphFull.repeat(filled) + this.glyphEmpty.repeat(BAR_WIDTH - filled);
    this.out.write(
      `${this.cr}  ${this.dim}${label.padEnd(11)}${this.rst} ` +
        `${this.acc}${bar}${this.rst} ${String(p).padStart(3, " ")}%${this.clr}`,
    );
  }

  /**
   * Indeterminate sliding block, for the brief window before Content-Length is
   * known (the download proxy normally sets it, so this rarely shows). Each
   * call advances the block by one cell; pass a monotonically rising `frame`.
   */
  pulse(label: string, frame: number): void {
    if (!this.tty) return;
    this.lastKey = ""; // force the next determinate draw to repaint
    const win = 5;
    const pos = ((frame % BAR_WIDTH) + BAR_WIDTH) % BAR_WIDTH;
    let bar = "";
    for (let i = 0; i < BAR_WIDTH; i++) {
      const rel = (i - pos + BAR_WIDTH) % BAR_WIDTH;
      bar += rel < win ? this.glyphFull : this.glyphEmpty;
    }
    this.out.write(
      `${this.cr}  ${this.dim}${label.padEnd(11)}${this.rst} ${this.acc}${bar}${this.rst}${this.clr}`,
    );
  }

  /** Wipe the current line — used to clear a half-drawn bar on error. */
  clearLine(): void {
    if (!this.tty) return;
    this.lastKey = "";
    this.out.write(`${this.cr}${this.clr}`);
  }

  /** Finish: drop to a fresh line so subsequent output starts clean. */
  end(): void {
    if (this.tty) this.out.write("\n");
    this.lastKey = "";
  }

  hideCursor(): void {
    if (this.tty && !this.cursorHidden) {
      this.out.write(`${this.esc}[?25l`);
      this.cursorHidden = true;
    }
  }

  showCursor(): void {
    if (this.tty && this.cursorHidden) {
      this.out.write(`${this.esc}[?25h`);
      this.cursorHidden = false;
    }
  }
}

function clampPct(pct: number): number {
  if (!Number.isFinite(pct) || pct < 0) return 0;
  if (pct > 100) return 100;
  return Math.floor(pct);
}
