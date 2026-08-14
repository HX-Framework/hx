# Security Policy

`hx` is a per-device background daemon that stores a device token
(`~/.let/hx/config.json`, mode `0600`), mints signed upload URLs, and mirrors
local AI session transcripts to a remote gateway. Because it auto-updates and
handles credentials, we take security reports seriously.

## Supported Versions

`hx` auto-updates to the newest released build (`hx update`). Only the latest
released version is supported; older versions cannot be pinned for security
fixes.

| Version        | Supported          |
| -------------- | ------------------ |
| latest release | :white_check_mark: |
| older releases | :x:                |

## Reporting a Vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Report privately through either channel:

- **Preferred:** GitHub Private Vulnerability Reporting — the "Report a
  vulnerability" button under this repository's **Security** tab
  (<https://github.com/hx-framework/hx/security/advisories/new>).
- **Email:** security@let.ai. If you would like to encrypt your report, ask for
  our current PGP key in your first (unencrypted) message and we will provide
  its fingerprint before you send any sensitive details.

Please include the affected version/commit, impact, and reproduction steps.
Findings against the self-update path, credential storage, or the
transcript-upload pipeline are prioritized.

## Response Targets

| Stage                              | Target                  |
| ---------------------------------- | ----------------------- |
| Acknowledge receipt                | within 2 business days  |
| Initial assessment / triage        | within 7 days           |
| Fix or coordinated-disclosure plan | within 90 days          |

## Scope

In scope: this repository's source and released binaries. Out of scope:
third-party dependencies (report upstream), social engineering, and physical
attacks. The gateway/host lives in `hx-fortress`; the wire protocol in
`hx-protocol`.

### Local web UI (`hx ui`)

`hx ui` serves the HX Client web app from the binary over plain HTTP. On a
normal host it binds `127.0.0.1` only. Inside a container it binds a wildcard
instead (`::`, dual-stack, with an IPv4-only `0.0.0.0` fallback) — the
container's loopback is unreachable from the host browser, so a published port
(`docker run -p`) needs a non-loopback listener to forward into, on either IP
family. The bind address is **not** the access boundary. The Host allowlist rejects
browser DNS-rebinding and any raw-container-IP request (403); a non-browser peer
on the same bridge can forge `Host: localhost` and reach the socket, but the
per-run bearer token — 256-bit, never sent to a peer — gates every data and
action endpoint, so such a peer gets only the data-free static shell and a
version string. Nothing crosses the container boundary unless the operator
publishes the port (an explicit gesture); note `docker run --network host`
shares the host netns, so the wildcard is then a real LAN bind (still token-gated).
Loopback is a browser-trusted origin, so no certificate is involved. The API is
gated by a per-run bearer token: the launch URL carries a key in the URL fragment
(never sent on the wire), the page exchanges it for a session token held in
`sessionStorage` and sent via a custom header — deliberately not a cookie,
since localhost cookies are shared across every port. The launch token is
reusable within a short TTL (not single-use — link previews, prefetch, and
multi-tab commonly fetch the link more than once); the TTL bounds how long a
token captured from the browser-opener argv on a shared multi-user host stays
valid, and the owner key that gates the instance-reuse handshake lives only in
the 0600 server-info file, never in a URL or argv. All requests
pass a Host allowlist (DNS-rebinding gate) and non-GET requests an Origin
check; responses carry a CSP whose `script-src` lists exact inline-script
hashes. The server reads daemon state and settings; it never serializes the
device token into any response, and `state.json` stays daemon-owned (mutating
maintenance actions stop the daemon first, exactly like the CLI). Findings
against this surface are in scope.

### Self-update trust model

`hx` updates itself by fetching a binary and its SHA-256 from the gateway's
download proxy over HTTPS (HTTP is permitted only for the loopback `--local`
dev gateway). The SHA-256 protects integrity in transit but not provenance:
today the trust chain is **the gateway's honesty plus TLS**, with no publisher
signature verified against a key pinned in the client. A compromised or
successfully impersonated gateway could therefore serve attacker bytes with a
matching checksum. Adding a pinned-key publisher signature over releases is
tracked hardening; see the trust-boundary note at the top of `src/update.ts`.

## Safe Harbor

We will not pursue legal action against researchers who act in good faith,
avoid privacy violations and service disruption, and give us a reasonable
opportunity to remediate before public disclosure.
