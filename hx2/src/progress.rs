//! The download progress bar of `hx update` (src/progress.ts): the look of
//! the `curl … | sh` installer on stderr, animated only on a TTY; piped runs
//! get one plain breadcrumb per phase.

use std::io::Write;

const BAR_WIDTH: usize = 24;

pub struct ProgressBar {
    tty: bool,
    full: &'static str,
    empty: &'static str,
    cursor_hidden: bool,
    last_key: String,
}

fn write_err(s: &str) {
    let stderr = std::io::stderr();
    let mut h = stderr.lock();
    let _ = h.write_all(s.as_bytes());
    let _ = h.flush();
    crate::logs::tee_write(true, s.as_bytes());
}

fn clamp_pct(pct: f64) -> u32 {
    if !pct.is_finite() || pct < 0.0 {
        return 0;
    }
    if pct > 100.0 {
        return 100;
    }
    pct.floor() as u32
}

fn pad_end(s: &str, w: usize) -> String {
    let l = s.encode_utf16().count();
    if l >= w {
        s.to_string()
    } else {
        format!("{}{}", s, " ".repeat(w - l))
    }
}

impl ProgressBar {
    pub fn new() -> ProgressBar {
        let utf8 = crate::connect::is_utf8_locale();
        ProgressBar {
            tty: crate::connect::stderr_is_tty(),
            full: if utf8 { "█" } else { "#" },
            empty: if utf8 { "░" } else { "-" },
            cursor_hidden: false,
            last_key: String::new(),
        }
    }

    fn dim(&self) -> &'static str {
        if self.tty {
            "\x1b[2m"
        } else {
            ""
        }
    }

    fn acc(&self) -> &'static str {
        if self.tty {
            "\x1b[38;5;39m"
        } else {
            ""
        }
    }

    fn rst(&self) -> &'static str {
        if self.tty {
            "\x1b[0m"
        } else {
            ""
        }
    }

    /// A plain breadcrumb for the non-TTY path; nothing on a TTY.
    pub fn status(&self, msg: &str) {
        if self.tty {
            return;
        }
        write_err(&format!("  {}\n", msg));
    }

    /// Dim label, blue bar, percent, redrawn in place.
    pub fn draw(&mut self, pct: f64, label: &str) {
        if !self.tty {
            return;
        }
        let p = clamp_pct(pct);
        let key = format!("{}:{}", label, p);
        if key == self.last_key {
            return;
        }
        self.last_key = key;
        let filled = (p as usize * BAR_WIDTH) / 100;
        let bar = format!("{}{}", self.full.repeat(filled), self.empty.repeat(BAR_WIDTH - filled));
        write_err(&format!("\r  {}{}{} {}{}{} {:>3}%\x1b[K", self.dim(), pad_end(label, 11), self.rst(), self.acc(), bar, self.rst(), p));
    }

    /// The indeterminate sliding block, one cell per call.
    pub fn pulse(&mut self, label: &str, frame: i64) {
        if !self.tty {
            return;
        }
        self.last_key.clear();
        let win = 5i64;
        let w = BAR_WIDTH as i64;
        let pos = ((frame % w) + w) % w;
        let mut bar = String::new();
        for i in 0..w {
            let rel = (i - pos + w) % w;
            bar.push_str(if rel < win { self.full } else { self.empty });
        }
        write_err(&format!("\r  {}{}{} {}{}{}\x1b[K", self.dim(), pad_end(label, 11), self.rst(), self.acc(), bar, self.rst()));
    }

    pub fn clear_line(&mut self) {
        if !self.tty {
            return;
        }
        self.last_key.clear();
        write_err("\r\x1b[K");
    }

    pub fn end(&mut self) {
        if self.tty {
            write_err("\n");
        }
        self.last_key.clear();
    }

    pub fn hide_cursor(&mut self) {
        if self.tty && !self.cursor_hidden {
            write_err("\x1b[?25l");
            self.cursor_hidden = true;
        }
    }

    pub fn show_cursor(&mut self) {
        if self.tty && self.cursor_hidden {
            write_err("\x1b[?25h");
            self.cursor_hidden = false;
        }
    }
}
