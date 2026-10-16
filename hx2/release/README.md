# hx2 release checks

What `.github/workflows/release-hx2.yml` uses to check a build before anyone can install it.

| File | What it does |
| --- | --- |
| `install-hx2.sh`, `install-hx2.ps1` | let.ai's installers for hx2, byte for byte as let.ai serves them at `/install-hx2.sh?channel=build` and `/install-hx2.ps1?channel=build`, for a let.ai at `http://127.0.0.1:47913`. |
| `serve.py` | Stands in for let.ai while the installers run: serves the two scripts, and the release files the way let.ai's download proxy serves a published hx2 build (allowlist, content types, the 404 when nothing is published). |
| `check-install.sh` | macOS and Linux: `curl … \| sh`, then checks the binary, `hx2 --version`, `config.json`, the PATH line and what was downloaded; installs again over it; uninstalls; checks that nothing of hx2 is left. First, with nothing published, the installer must say so and install nothing. |
| `check-install.ps1` | The same on Windows with `irm … \| iex`, in Windows PowerShell 5.1 and in PowerShell 7, plus both binaries' subsystems, the user PATH, the Apps & features entry and the ACL hx-home.ts puts on `~/.let/hx`. |
| `check-binaries.py` | Linux binaries need glibc 2.17 at most, as hx's do; Windows programs import no Visual C++ runtime DLL; the `-svc` builds are windowless. |

## Rendering the installers again

The two scripts come from `renderHxInstaller` in let.ai's `packages/hx-install-script`, rendered on
2026-10-17 with `{ client: "hx2" }`, the gateway `http://127.0.0.1:47913/_api/hx-gateway` and
`channel: "build"`. Render them again the same way whenever that package changes, so the checks run
the installers people actually get.

Until hx2 has its own `uninstall` command, the install checks remove what `hx uninstall` removes
(`src/uninstall.ts`) and check the same end state; once `hx2 uninstall` exists, they run it.
