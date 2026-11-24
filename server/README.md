---
title: Piano Companion Recognition
emoji: 🎹
colorFrom: blue
colorTo: indigo
sdk: docker
app_port: 7860
pinned: false
---

# Piano Companion recognition server (homr)

This small server lets the Piano Companion app turn **photos of sheet music into
MusicXML** using [homr](https://github.com/liebharc/homr), a neural-network music
recogniser built for camera pictures. The app sends one page at a time and gets
MusicXML back, which then goes through the app's review screen as before.

The app is a static website, so the recogniser has to run somewhere else. Pick one
of the options below. All of them use the `Dockerfile` in this folder.

## Option A0: automatic deploy from GitHub (recommended)

The repository has a workflow (`.github/workflows/deploy-server.yml`) that creates
the Hugging Face Space and keeps it up to date whenever `server/` changes.

1. Create a free account at <https://huggingface.co>.
2. On Hugging Face: **Settings → Access Tokens → Create new token**, choose
   **Write**, name it `github-deploy`, and copy the token.
3. On GitHub: repository **Settings → Secrets and variables → Actions →
   New repository secret**. Name: `HF_TOKEN`. Paste the token. Save.
4. On GitHub: **Actions → Deploy recognition server → Run workflow**.
5. Open the finished run: its summary shows the **server address**. Wait 5–10
   minutes for the first build on Hugging Face, then use the address in the app
   (Settings → Photo recognition → Test connection).

Never paste the token anywhere else (chat, code, issues). To use a different Space
name, add a repository *variable* `HF_SPACE_NAME`.

## Option A: Hugging Face Spaces by hand (free)

1. Create a free account at <https://huggingface.co>.
2. **New → Space**. Name it e.g. `piano-recogniser`, choose **Docker** as the SDK
   and **Blank** as the template. The free *CPU basic* hardware (2 vCPU, 16 GB) is enough.
3. Upload the four files from this folder (`Dockerfile`, `app.py`,
   `requirements.txt`, `README.md`) using **Files → Add file → Upload files**.
4. Wait for the build to finish (5–10 minutes the first time; it downloads the models).
   The Space shows **Running** when it's ready.
5. Your server address is `https://<your-username>-piano-recogniser.hf.space`.
   Open `<address>/health` in a browser: you should see `{"ok": true, "engine": "homr", ...}`.
6. In the app: **Settings → Photo recognition → Server address**, paste the address
   and press **Test connection**.

Free Spaces go to sleep after a period without use; the first page after that
takes an extra minute or so while it wakes up.

## Option B: Google Cloud Run, Render, Fly.io

Deploy this folder as a Docker service. Give it **at least 4 GB of memory**
(8 GB is safer for large pages) and a request timeout of **5 minutes or more**.
The container listens on `$PORT` (default 7860).

## Option C: your own computer (for testing)

```bash
cd server
docker build -t piano-recogniser .
docker run -p 7860:7860 piano-recogniser
```

Then use `http://localhost:7860` as the server address while running the app
from `npm start` (http://localhost:8080).

Without Docker (Python 3.11 or 3.12):

```bash
pip install -r requirements.txt
homr --init --gpu no
python app.py
```

## Settings

Set these as environment variables (on Hugging Face: **Settings → Variables and secrets**).

| Variable | Default | Meaning |
|---|---|---|
| `ALLOWED_ORIGINS` | `https://bezoon5.github.io,http://localhost:8080,http://127.0.0.1:8080` | Websites allowed to use the server. Add your own if you host the app elsewhere. |
| `API_KEY` | *(none)* | If set, the app must send this key (Settings → Photo recognition → Key). It stops casual use by others, but anyone who can open your app can read it, so it is not strong protection. |
| `HOMR_ARGS` | `--gpu no` | Extra homr options. Use `--gpu auto` on a GPU machine with the `cuda` image. |
| `HOMR_TIMEOUT` | `300` | Seconds allowed per page. |
| `MAX_CONCURRENT` | `1` | Pages processed at the same time. Raise only with more CPU and memory. |
| `MAX_QUEUE` | `8` | Requests allowed to wait; more get "server busy". |
| `MAX_UPLOAD_MB` | `20` | Largest image accepted. |

## How long does a page take?

On the free 2-CPU Space, expect roughly **30 seconds to 2 minutes per page**
depending on how dense the music is. A GPU makes it several times faster.

## Licence

homr is licensed under **AGPL-3.0**. If you change homr itself and run it as a
public service, the AGPL requires you to offer your changed source code to its
users. This server only calls the unmodified `homr` command; this folder is MIT
like the rest of Piano Companion.

## API

```
GET  /health
POST /recognise   multipart/form-data: image=<JPEG|PNG|WebP>, tempo=<bpm, optional>
                  header X-API-Key: <key>   (only if API_KEY is set)
→ 200 MusicXML (application/vnd.recordare.musicxml+xml)
→ 4xx/5xx {"error": "..."}
```
