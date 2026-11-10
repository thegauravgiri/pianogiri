"""PianoGiri YouTube audio service.

GET /audio?url=<youtube link>  -> streams the best audio-only track (m4a when available)
GET /health                    -> {"ok": true}

Only browsers on ALLOWED_ORIGINS may call it (CORS + Origin check), each IP gets
RATE_LIMIT requests per hour, and videos longer than MAX_SECONDS are refused.
The browser does the audio-to-MIDI conversion; this service only fetches audio.
"""

import json
import os
import re
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, quote, urlparse

PORT = int(os.environ.get("PORT", "8080"))
ALLOWED_ORIGINS = {o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "https://piano.gauravgiri.com.np").split(",") if o.strip()}
MAX_SECONDS = int(os.environ.get("MAX_SECONDS", "480"))
RATE_LIMIT = int(os.environ.get("RATE_LIMIT", "12"))
COOKIES = os.environ.get("YTDLP_COOKIES", "")  # optional Netscape cookies.txt content (store in Secret Manager)
FORMAT = "bestaudio[ext=m4a]/bestaudio"
YOUTUBE_RE = re.compile(r"^https?://(www\.|m\.|music\.)?(youtube\.com/(watch\?|shorts/|live/)|youtu\.be/)[\w\-?=&%./]+$", re.I)

_cookie_file = None
if COOKIES:
    _cookie_file = tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False)
    _cookie_file.write(COOKIES)
    _cookie_file.close()

_hits: dict[str, list[float]] = {}
_hits_lock = threading.Lock()


def rate_limited(ip: str) -> bool:
    now = time.time()
    with _hits_lock:
        recent = [t for t in _hits.get(ip, []) if now - t < 3600]
        limited = len(recent) >= RATE_LIMIT
        if not limited:
            recent.append(now)
        _hits[ip] = recent
        return limited


def base_args() -> list[str]:
    args = ["yt-dlp", "--no-playlist", "--no-warnings", "--quiet", "-f", FORMAT]
    if _cookie_file:
        args += ["--cookies", _cookie_file.name]
    return args


def classify_error(stderr: str) -> tuple[int, str, str]:
    text = stderr.lower()
    if "sign in to confirm" in text or "not a bot" in text or "http error 429" in text:
        return 503, "blocked", "YouTube is temporarily blocking our server. Try again later, or upload an audio file instead."
    if "private video" in text or "members-only" in text or "sign in to confirm your age" in text:
        return 403, "restricted", "This video is private, members-only or age-restricted."
    if "unavailable" in text or "does not exist" in text:
        return 404, "unavailable", "That video isn't available."
    return 502, "failed", "Couldn't get audio for that video."


class Handler(BaseHTTPRequestHandler):
    server_version = "pianogiri-yt/1.0"

    def log_message(self, fmt, *args):
        # Log method, path and status only. Query strings (the YouTube link) are never logged.
        status = args[1] if len(args) > 1 else "-"
        print(f"{self.client_ip()} {self.command} {urlparse(self.path).path} {status}", flush=True)

    def client_ip(self) -> str:
        forwarded = self.headers.get("X-Forwarded-For", "")
        return forwarded.split(",")[0].strip() or self.client_address[0]

    def cors(self):
        origin = self.headers.get("Origin", "")
        if origin in ALLOWED_ORIGINS:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Expose-Headers", "X-Title, X-Duration")

    def send_json(self, status: int, payload: dict):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.cors()
        self.send_header("Access-Control-Allow-Methods", "GET")
        self.send_header("Access-Control-Max-Age", "86400")
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/health":  # Cloud Run reserves paths ending in "z"
            return self.send_json(200, {"ok": True})
        if parsed.path != "/audio":
            return self.send_json(404, {"error": "not_found"})

        if self.headers.get("Origin", "") not in ALLOWED_ORIGINS:
            return self.send_json(403, {"error": "origin", "message": "This service only works from PianoGiri."})
        if rate_limited(self.client_ip()):
            return self.send_json(429, {"error": "rate_limited", "message": "Too many YouTube imports. Try again in an hour."})

        url = (parse_qs(parsed.query).get("url") or [""])[0].strip()
        if not YOUTUBE_RE.match(url):
            return self.send_json(400, {"error": "bad_url", "message": "That doesn't look like a YouTube video link."})

        # Step 1: resolve metadata and the audio format once.
        try:
            info_proc = subprocess.run(base_args() + ["-J", url], capture_output=True, text=True, timeout=60)
        except subprocess.TimeoutExpired:
            return self.send_json(504, {"error": "timeout", "message": "YouTube took too long to respond."})
        if info_proc.returncode != 0:
            status, code, message = classify_error(info_proc.stderr)
            print(f"yt-dlp info error: {info_proc.stderr.strip()[:500]}", flush=True)
            return self.send_json(status, {"error": code, "message": message})

        info = json.loads(info_proc.stdout)
        if info.get("is_live"):
            return self.send_json(400, {"error": "live", "message": "Live streams can't be imported."})
        duration = int(info.get("duration") or 0)
        if duration > MAX_SECONDS:
            return self.send_json(413, {"error": "too_long", "message": f"Videos up to {MAX_SECONDS // 60} minutes are supported."})

        ext = info.get("ext") or "m4a"
        content_type = {"m4a": "audio/mp4", "webm": "audio/webm", "mp3": "audio/mpeg", "opus": "audio/ogg"}.get(ext, "application/octet-stream")

        # Step 2: stream the already-resolved format without re-extracting.
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
            json.dump(info, f)
            info_path = f.name
        proc = subprocess.Popen(base_args() + ["--load-info-json", info_path, "-o", "-"], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        killer = threading.Timer(240, proc.kill)
        killer.start()
        try:
            first = proc.stdout.read(64 * 1024)
            if not first:
                proc.wait()
                status, code, message = classify_error(proc.stderr.read().decode(errors="replace"))
                return self.send_json(status, {"error": code, "message": message})

            self.send_response(200)
            self.cors()
            self.send_header("Content-Type", content_type)
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Title", quote(str(info.get("title") or "YouTube song")[:120]))
            self.send_header("X-Duration", str(duration))
            self.end_headers()
            self.wfile.write(first)
            while chunk := proc.stdout.read(64 * 1024):
                self.wfile.write(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass  # browser went away
        finally:
            killer.cancel()
            if proc.poll() is None:
                proc.kill()
            proc.wait()
            os.unlink(info_path)


if __name__ == "__main__":
    print(f"listening on :{PORT}, origins={sorted(ALLOWED_ORIGINS)}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
