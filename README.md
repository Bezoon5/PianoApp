# Piano Companion 6.3

**Live app:** https://bezoon5.github.io/PianoApp

A piano practice app for iPhone, iPad and desktop browsers. Import music (including photos of sheet music), follow the engraved score or falling notes, and practise with your own piano: through a MIDI keyboard, or on iPhone and iPad through the microphone. Practise one hand at a time, loop tricky bars with a speed trainer and metronome, play along with timing feedback, record yourself, and track your progress. It installs to the home screen and works offline.

![Practice tools](docs/practice-tools.png)

## Getting music in
| Source | Accuracy | Notes |
|---|---|---|
| **MusicXML** (`.musicxml`, `.xml`, `.mxl`) | Exact | Recommended. Export from MuseScore, Sibelius, Finale or Dorico. Multi-part scores ask which part to practise (piano suggested). |
| **MIDI** | Exact notes | Notation is generated, so the display is approximate. |
| **Camera / Photos / PDF** | Good with AI recognition; needs review | Optical music recognition with a review-and-correct step. Pages are read by the homr neural network on the app's [recognition server](server/README.md), which copes with real phone photos. Offline, or if you choose it, a basic on-device recogniser is used (best with clean screenshots). |
| **Built-in** | – | 25 public-domain Christmas melodies and Happy Birthday. |

### AI recognition for photos
Scanned pages are sent to the app's recognition server (in [`server/`](server/README.md), running [homr](https://github.com/liebharc/homr) on Google Cloud Run). It is built into the app, so there is nothing to set up. The server sleeps when unused, so the first page after a break takes a little longer while it wakes up. If it can't be reached, the app says so and uses the on-device recogniser instead. **Settings → Photo recognition** can point the app at a different server; clearing the box returns to the built-in one. In the Layout step you can also choose **On this device**.

**Reviewing a scan.** Bars that don't add up are shown in red, ones to check in amber, both on the recognised score and on your photo. Tap a note on either to select and fix it; **Next issue** jumps to the next problem bar.

Tips for good photos: lay the page flat, fill the frame, use even light, and use **Camera app (sharper)** for a full-resolution photo.

## Practising

**Connecting your piano.** On a computer, Chrome or Edge connect a MIDI keyboard (USB or Bluetooth). Safari on iPhone and iPad cannot use MIDI keyboards, so use **🎤 Mic** on the practice screen instead: the app listens to your piano. Microphone tips: put the phone near the piano, keep the room quiet for the one-second calibration, and use headphones if the app plays the other hand for you. Single notes are recognised reliably; simple chords mostly; fast or very complex passages less so.

- **Listen** plays the piece.
- **Wait mode** waits for the right note or chord before moving on, and scores you.
- **Play along** runs at tempo after a count-in and marks each note **on time, early, late, missed or wrong**, with a live score. **Timing** sets how strict it is (Strict, Normal, Relaxed). The summary says whether you tend to rush or drag. A MIDI keyboard gives the most precise timing; the microphone is rougher. Bluetooth headphones add a delay that makes notes look late, so use wired ones or the speaker.
- **Falling notes** shows notes falling onto the keys they belong to, instead of sheet music.
- **● Record** saves what you play (notes, plus sound when the microphone is on). **Takes** lists the last 10 recordings of the piece: play one back with the score following, or download it as a MIDI or sound file.
- **Hands**: Both, Right only or Left only. The app plays the other hand; your hand's keys light up.
- **Loop**: choose bars (e.g. 12 to 16) and press **⟲ Loop**. Looped bars are shaded in the score.
- **Speed trainer** (with a loop): starts at 70% of your tempo and adds 5% per pass.
- **Metronome** and **count-in**.
- **Progress**: after each Wait-mode or Play-along run you see your result, best score, recent sessions and your trickiest bars, each with **Loop this bar**. The library shows how often and how well you've practised each piece, plus your practice streak.
- Engraved sheet music (Verovio) with the current bar and notes highlighted; tempo 30–220 BPM; repeats played as written.
- Touch keyboard (61/76/88 keys); USB/Bluetooth MIDI keyboards in Chrome/Edge (not Safari); microphone on any device. Grand piano or simple synth.

## Your library
- **Edit** on an imported piece lets you rename or delete it.
- Your music and practice history are saved in the browser on each device.
- **Settings → Send to another device** shares your whole library through the share sheet (AirDrop, Files, Mail on iPhone and iPad). **Back up library** saves it as a file. On the other device, **Restore backup** adds new pieces and keeps the most recently changed copy of each piece, so nothing newer is overwritten.
- The library shows a reminder when pieces are saved only on this device (**Not now** hides it for a week).

## Install and offline
- **iPad/iPhone:** Safari → Share → *Add to Home Screen*. **Chrome/Edge:** install button in Settings or the address bar.
- Open **Settings → Make available offline** once while online to save the libraries, sheet-music engine and piano sound.

## Known limitations
- MusicXML: D.C./D.S./Coda jumps are not followed; cue and grace notes are not played.
- Scanning with AI recognition: dynamics, articulations, grace notes and repeat signs are not used; key and time-signature changes inside a piece should be checked. Review is still recommended.
- Scanning on this device only: ties, slurs, tuplets and accidentals next to notes are not recognised; review is required.
- Practice history is stored in the browser; use Backup or Send to another device to keep a copy. Recorded takes stay on the device where they were made (download them to keep them).
- Microphone: single notes are recognised reliably, simple chords mostly; dense chords and very fast passages are less dependable than a MIDI keyboard. If the app plays the other hand through the speaker, headphones help.
- MIDI keyboards don't work in Safari (iPhone, iPad, Mac): Apple hasn't added Web MIDI. Use the microphone there, or Chrome/Edge on a computer.
- The sheet-music engine (~7 MB) downloads the first time it is used.

## Project structure
```
index.html, app.js, styles.css      app shell, library, practice, sound, settings
sw.js, manifest.webmanifest, icons/ installable offline app
music/practice.js                   hands, loops, speed trainer, metronome, progress, backup, play-along timing, MIDI export (pure logic)
music/listen.js                     microphone listening: note detection from audio (pure logic, own FFT)
music/xml.js, music/musicxml.js     MusicXML import/export
music/notation.js                   Verovio rendering, bar/note highlighting, loop marking
omr/                                optical music recognition and review workflow
omr/homr.js                         AI recognition: server client + MusicXML -> review score
server/                             recognition server (homr), Dockerfile, deploy guide
tests/                              Node tests, fixtures, browser suites, Verovio check
```

## Run and test
```
npm start                                   # http://localhost:8080
npm test                                    # 79 Node tests (all suites also run on GitHub for every pull request)
python3 tests/server/test_server.py         # recognition server API (stub homr; needs starlette, uvicorn, python-multipart, requests)
python3 tests/browser/homr.py               # AI recognition end to end (Playwright), 36 checks
python3 tests/browser/backup.py             # backups: reminder, send, merging restore, 14 checks
python3 tests/browser/practice63.py         # microphone, play along, recording, falling notes, 28 checks
pip install verovio && python3 tests/verovio_check.py
python3 tests/browser/server.py 8080 &      # browser suites (Playwright)
python3 tests/browser/practice6.py http://127.0.0.1:8080/index.html   # 29 checks
python3 tests/browser/stress.py    http://127.0.0.1:8080/index.html   # 34 checks
python3 tests/browser/offline.py   http://127.0.0.1:8080/index.html   # 7 checks
```

## Publishing
The live app is published by GitHub Pages from the `main` branch: whatever is merged into `main` goes live a minute or two later. Changes are made on a separate branch and proposed as a pull request; GitHub then runs every test suite on it (see `.github/workflows/ci.yml`) before it is merged. Installed copies update the next time they are opened online, as long as the `VERSION` in `sw.js` was raised (a test checks it matches `package.json` and the changelog).

If you ever upload files through GitHub's web page instead, note that it skips names starting with a dot (such as `.github/` and `.gitignore`).

The recognition server is deployed separately; see [`server/README.md`](server/README.md).

## Credits
[Tone.js](https://tonejs.github.io), [@tonejs/midi](https://github.com/Tonejs/Midi), [Salamander Grand Piano](https://archive.org/details/SalamanderGrandPianoV3) samples (CC-BY 3.0, Alexander Holm), [Verovio](https://www.verovio.org) (LGPL-3.0), [PDF.js](https://mozilla.github.io/pdf.js/), [Tesseract.js](https://tesseract.projectnaptha.com), all loaded from public CDNs. Photo recognition server: [homr](https://github.com/liebharc/homr) (AGPL-3.0, runs separately; see server/README.md). Test scores from the [music21](https://github.com/cuthbertLab/music21) corpus. Visual in this file was generated with Microsoft Copilot.
