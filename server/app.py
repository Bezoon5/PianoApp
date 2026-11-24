"""
Piano Companion recognition server: wraps homr (https://github.com/liebharc/homr)
so the web app can turn a photo of one page of sheet music into MusicXML.

  GET  /health      -> {"ok": true, "engine": "homr", "version": "...", "busy": 0, "queued": 0}
  POST /recognise   multipart form: image=<jpeg|png|webp> [, tempo=<bpm>]
                    -> 200 MusicXML text, or {"error": "..."} with 4xx/5xx

One page per request keeps requests short and lets the app show progress.

Configuration (environment variables):
  ALLOWED_ORIGINS   comma-separated origins allowed to call the server
                    (default: https://bezoon5.github.io plus localhost:8080)
  API_KEY           optional shared key; clients send it as X-API-Key
  HOMR_CMD          homr command (default "homr"); tests point this at a stub
  HOMR_ARGS         extra homr arguments (default "--gpu no")
  HOMR_TIMEOUT      seconds per page before giving up (default 300)
  MAX_CONCURRENT    pages processed at once (default 1; homr is CPU/RAM heavy)
  MAX_QUEUE         requests allowed to wait (default 8; more get 503)
  MAX_UPLOAD_MB     largest accepted image (default 20)
"""
import asyncio
import os
import shlex
import shutil
import tempfile
import time
from importlib import metadata

from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.middleware.cors import CORSMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.routing import Route

DEFAULT_ORIGINS = "https://bezoon5.github.io,http://localhost:8080,http://127.0.0.1:8080"
ORIGINS = [o.strip() for o in os.environ.get("ALLOWED_ORIGINS", DEFAULT_ORIGINS).split(",") if o.strip()]
API_KEY = os.environ.get("API_KEY", "")
HOMR_CMD = shlex.split(os.environ.get("HOMR_CMD", "homr"))
HOMR_ARGS = shlex.split(os.environ.get("HOMR_ARGS", "--gpu no"))
HOMR_TIMEOUT = float(os.environ.get("HOMR_TIMEOUT", "300"))
MAX_CONCURRENT = max(1, int(os.environ.get("MAX_CONCURRENT", "1")))
MAX_QUEUE = max(0, int(os.environ.get("MAX_QUEUE", "8")))
MAX_UPLOAD = int(float(os.environ.get("MAX_UPLOAD_MB", "20")) * 1024 * 1024)

slots = asyncio.Semaphore(MAX_CONCURRENT)
stats = {"busy": 0, "waiting": 0, "done": 0, "failed": 0}


def homr_version():
    try:
        return metadata.version("homr")
    except metadata.PackageNotFoundError:
        return "unknown"


def image_ext(data: bytes):
    """Accept only the image formats browsers produce from a canvas or camera."""
    if data[:3] == b"\xff\xd8\xff":
        return ".jpg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return ".png"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return ".webp"
    return None


def error(status, message):
    return JSONResponse({"error": message}, status_code=status)


async def health(request: Request):
    return JSONResponse({
        "ok": True, "engine": "homr", "version": homr_version(),
        "busy": stats["busy"], "queued": stats["waiting"], "done": stats["done"], "failed": stats["failed"],
        "needsKey": bool(API_KEY),
    })


async def run_homr(image_path: str, tempo):
    args = list(HOMR_CMD) + list(HOMR_ARGS)
    if tempo:
        args += ["--output-tempo", str(tempo)]
    args.append(image_path)
    proc = await asyncio.create_subprocess_exec(
        *args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
        cwd=os.path.dirname(image_path))
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=HOMR_TIMEOUT)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        raise RuntimeError("recognition took longer than %d seconds" % HOMR_TIMEOUT)
    log = out.decode("utf-8", "replace")[-4000:]
    return proc.returncode, log


async def recognise(request: Request):
    if API_KEY and request.headers.get("x-api-key") != API_KEY:
        return error(401, "missing or wrong API key")
    length = request.headers.get("content-length")
    if length and length.isdigit() and int(length) > MAX_UPLOAD + 65536:
        return error(413, "image is larger than %d MB" % (MAX_UPLOAD // 1024 // 1024))
    if stats["waiting"] >= MAX_QUEUE and slots.locked():
        return error(503, "the server is busy; try again in a minute")
    try:
        form = await request.form(max_files=1, max_fields=4)
    except Exception as e:  # malformed multipart
        return error(400, "could not read the upload (%s)" % e)
    upload = form.get("image")
    if upload is None or not hasattr(upload, "read"):
        return error(400, "send the page as a multipart field named 'image'")
    data = await upload.read()
    if len(data) > MAX_UPLOAD:
        return error(413, "image is larger than %d MB" % (MAX_UPLOAD // 1024 // 1024))
    ext = image_ext(data)
    if not ext:
        return error(415, "only JPEG, PNG or WebP images are accepted")
    tempo = None
    raw_tempo = form.get("tempo")
    if isinstance(raw_tempo, str) and raw_tempo.strip().isdigit():
        tempo = max(30, min(220, int(raw_tempo.strip())))

    work = tempfile.mkdtemp(prefix="homr-")
    image_path = os.path.join(work, "page" + ext)
    xml_path = os.path.join(work, "page.musicxml")
    with open(image_path, "wb") as f:
        f.write(data)
    stats["waiting"] += 1
    started = None
    acquired = False
    try:
        async with slots:
            stats["waiting"] -= 1
            acquired = True
            stats["busy"] += 1
            started = time.monotonic()
            try:
                code, log = await run_homr(image_path, tempo)
            except RuntimeError as e:
                stats["failed"] += 1
                return error(504, str(e))
            except FileNotFoundError:
                stats["failed"] += 1
                return error(500, "homr is not installed on the server")
            finally:
                stats["busy"] -= 1
        if code != 0 or not os.path.exists(xml_path):
            stats["failed"] += 1
            last = [l for l in log.strip().splitlines() if l.strip()][-1:] or ["no output"]
            return error(422, "no music could be recognised on this page (%s)" % last[0][:300])
        with open(xml_path, "rb") as f:
            xml = f.read()
        stats["done"] += 1
        return Response(xml, media_type="application/vnd.recordare.musicxml+xml", headers={
            "X-Recognition-Seconds": "%.1f" % (time.monotonic() - started),
            "X-Engine": "homr " + homr_version(),
        })
    finally:
        if not acquired:
            stats["waiting"] -= 1
        shutil.rmtree(work, ignore_errors=True)


app = Starlette(
    routes=[Route("/health", health, methods=["GET"]), Route("/recognise", recognise, methods=["POST"])],
    middleware=[Middleware(
        CORSMiddleware, allow_origins=ORIGINS, allow_methods=["GET", "POST"],
        allow_headers=["X-API-Key", "Content-Type"],
        expose_headers=["X-Recognition-Seconds", "X-Engine"], max_age=3600)],
)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "7860")))
