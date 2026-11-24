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

The app is a static website, so the recogniser has to run somewhere else.
Google Cloud Run is recommended: it switches off when unused, and personal use
normally stays within Google's monthly free allowance.

## Option A: Google Cloud Run (recommended)

1. Go to <https://console.cloud.google.com> and sign in with a Google account.
   Accept the terms. New accounts are offered a free trial with credit; a card
   is required either way.
2. Create a project: project picker at the top → **New project** → name it
   `piano-recogniser` → **Create**. Make sure it is selected in the top bar.
3. Turn on billing for it if asked (**Billing** → link your billing account).
4. **Set a spending alert**: **Billing → Budgets & alerts → Create budget**,
   amount e.g. £5, keep the default email alerts. (An alert warns you; it does
   not stop charges by itself. The server is also capped at 2 copies.)
5. Open **Cloud Shell**: the `>_` icon at the top right. A terminal opens at the
   bottom of the page. Paste this line and press Enter:

   ```bash
   rm -rf PianoApp && git clone --depth 1 https://github.com/Bezoon5/PianoApp.git && bash PianoApp/server/deploy-cloudrun.sh
   ```

   If Cloud Shell asks to **Authorize**, allow it. The first deploy takes about
   5–10 minutes and ends by printing the **server address**
   (`https://piano-recogniser-….run.app`).
6. In the app: **Settings → Photo recognition**, paste the address, press
   **Test connection**.

To update the server after `server/` changes, open Cloud Shell and paste the
same line again.

**Cost.** Cloud Run's monthly free allowance (CPU, memory and requests) covers
roughly a few thousand pages. Storing the server image costs a few pence a month.
The first page after the server has been idle takes longer while it starts.

## Option B: Hugging Face Spaces ($9/month)

Hugging Face now requires a **PRO subscription** to run Docker Spaces. With PRO,
the workflow `.github/workflows/deploy-server.yml` deploys automatically:

1. On Hugging Face: **Settings → Access Tokens → Create new token**, choose
   **Write**, copy it.
2. On GitHub: **Settings → Secrets and variables → Actions → New repository
   secret**, name `HF_TOKEN`, paste the token.
3. On GitHub: **Actions → Deploy recognition server (Hugging Face) → Run workflow**. The run
   summary shows the server address.

Never paste the token anywhere else (chat, code, issues).

## Option C: other hosts

Deploy this folder as a Docker service anywhere (Render, Fly.io, a VPS). Give it
**at least 4 GB of memory** and a request timeout of **5 minutes or more**. The
container listens on `$PORT` (default 7860).

## Option D: your own computer (for testing)

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

Set these as environment variables (Cloud Run: **Edit & deploy new revision → Variables**; Hugging Face: **Settings → Variables and secrets**).

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

On GitHub's 4-CPU test machines homr took about **7 seconds per page**. On Cloud
Run with 2 CPUs expect roughly 10–30 seconds, plus up to a minute when the server
has been idle and needs to start.

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
