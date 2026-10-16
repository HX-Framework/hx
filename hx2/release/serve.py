"""A stand-in for let.ai while the release workflow runs hx2's installers.

It serves the two installer scripts at /install-hx2.sh and /install-hx2.ps1,
and the release files at /_api/hx-gateway/download/<asset> the way let.ai's
download proxy serves a published hx2 build: the same asset allowlist, the
same content types and headers, a 400 for a name outside the allowlist, and a
404 for the version file when nothing is published (--empty). Each request is
appended to --log as one line, `GET <path>?<query> <status>`, for the checks
to read back.

Usage: python3 serve.py --port 47913 --scripts <dir> --log <file>
                        (--release <dir> | --empty)
"""

import argparse
import http.server
import os
import re
import threading

# downloads.ts releaseTargetForAsset, the hx2 line.
ASSET = re.compile(
    r"^(hx2-(darwin|linux)-(arm64|x64)|hx2-windows-(x64|arm64)(-svc)?)(\.gz|\.sha256|\.sig)?$|^hx2-version$"
)
DOWNLOAD = "/_api/hx-gateway/download/"
SCRIPTS = ("/install-hx2.sh", "/install-hx2.ps1")


def make_handler(args, log_lock):
    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, fmt, *a):
            pass

        def record(self, status):
            with log_lock, open(args.log, "a", encoding="utf-8") as f:
                f.write(f"GET {self.path} {status}\n")

        def reply(self, status, body, content_type="text/plain; charset=utf-8", headers=()):
            self.send_response(status)
            self.send_header("content-type", content_type)
            self.send_header("content-length", str(len(body)))
            for k, v in headers:
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(body)
            self.record(status)

        def do_GET(self):
            path = self.path.split("?", 1)[0]
            if path in SCRIPTS:
                with open(os.path.join(args.scripts, path.lstrip("/")), "rb") as f:
                    return self.reply(200, f.read())
            if not path.startswith(DOWNLOAD):
                return self.reply(404, b"Not found")
            asset = path[len(DOWNLOAD):]
            if not ASSET.match(asset):
                return self.reply(
                    400,
                    f"invalid asset name: {asset}\nexpected: an hx, hx2 or hx-fortress release asset\n".encode(),
                )
            if args.empty:
                return self.reply(404, b"hx download proxy: no hx2 build has been published yet.\n")
            file = os.path.join(args.release, asset)
            if not os.path.isfile(file):
                return self.reply(
                    404,
                    f"hx download proxy: asset '{asset}' not present in release 'builds/hx2-test'.\n".encode(),
                )
            with open(file, "rb") as f:
                body = f.read()
            if asset.endswith((".sha256", ".sig", "-version")):
                content_type = "text/plain; charset=utf-8"
            elif asset.endswith(".gz"):
                content_type = "application/gzip"
            else:
                content_type = "application/octet-stream"
            return self.reply(
                200,
                body,
                content_type,
                [
                    ("content-disposition", f'attachment; filename="{asset}"'),
                    ("cache-control", "public, max-age=300"),
                ],
            )

    return Handler


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--port", type=int, required=True)
    p.add_argument("--scripts", required=True)
    p.add_argument("--log", required=True)
    p.add_argument("--release")
    p.add_argument("--empty", action="store_true")
    args = p.parse_args()
    if not args.empty and not args.release:
        p.error("--release or --empty")
    server = http.server.ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(args, threading.Lock()))
    server.serve_forever()


if __name__ == "__main__":
    main()
