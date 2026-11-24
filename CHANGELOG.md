# Changelog

## 6.3.0: microphone, play along, recording, falling notes
New
- **🎤 Mic: listen to your piano through the microphone.** Brings Wait mode and wrong-note checking to iPhone and iPad, where MIDI keyboards can't connect to web apps. Because the app knows which notes come next, it checks for exactly those notes (single notes and simple chords), flags clearly wrong notes, ignores the app's own accompaniment, and stays silent for your notes because your piano makes the sound. A short calibration measures the room's background noise first.
- **Play along:** the music runs at tempo with a count-in, and each note you play is marked on time, early, late, missed or wrong, with a running score, a summary (including whether you tend to rush or drag) and your trickiest bars. Choose Strict, Normal or Relaxed timing. Works with a MIDI keyboard (most precise), the on-screen keys or the microphone.
- **● Record and Takes:** record what you play (notes, plus sound when the microphone is on), keep the last 10 takes per piece, play them back with the score following along, and download them as MIDI or sound files.
- **Falling notes:** notes fall onto the keys they belong to, coloured by hand, and by result in Play along.
Other
- On phones the practice controls are more compact and the keyboard scrolls to the piece's notes.
- If Piano Companion is open in another tab during an update, the app waits for it instead of opening without your library.

## 6.2.0: notes on the photo, easier backups, automatic testing
New
- **AI scans: notes on the photo.** In review, bars on the photo are coloured like the Recognised view (red = doesn't add up, amber = check), the selected bar and note are marked on the photo, and tapping the photo selects the nearest note. Next issue scrolls both views to the bar.
- **Send to another device** (Settings → Backup): shares the whole library through the share sheet (AirDrop, Files, Mail on iPhone), or downloads it.
- **Backup reminder** on the library screen when pieces are saved only on this device ("Not now" snoozes it for a week).
- **Restore merges** instead of overwriting: new pieces are added, and the most recently changed copy of each piece is kept.
- The app keeps retrying for a few seconds while the recognition server wakes up, instead of failing straight away.
Other
- Every pull request runs all test suites on GitHub (unit, server, practice, stress, offline, AI recognition, backups).
- A test keeps the version number in step across package.json, the service worker and this changelog.
- Real homr results for the test photos are kept as fixtures: on the Happy Birthday photo, clean and shadowed, all 52 notes are exactly right.

## 6.1.1: built-in recognition server
- AI recognition works out of the box: the app uses the Piano Companion recognition server on Google Cloud Run, with no setup in Settings. Settings → Photo recognition can still point to another server; clearing the box returns to the built-in one.
- Deploy script grants the build permission new Google Cloud projects lack.

## 6.1.0: AI recognition for photos
New
- **AI recognition (homr)**: photos and PDF pages can be read by [homr](https://github.com/liebharc/homr), a neural-network music recogniser built for camera pictures, running on a small server you deploy once (`server/`, free on Hugging Face Spaces). Results go through the same review screen: measures that don't add up are flagged, every note can be edited, and the piece saves for practice as before.
- **Settings → Photo recognition**: server address, optional key and **Test connection**.
- **Layout step**: choose AI recognition or on-device recognition. AI becomes the default once a server is set; if the server can't be reached the app explains why and falls back to the on-device recogniser.
- Review supports **ties and triplets** (playback and MusicXML export), as returned by AI recognition.
- **Sharper camera photos**: Capture takes a full-resolution still where the browser allows it, and **Camera app (sharper)** opens the device's own camera.
Fixes
- Auto-crop no longer cuts off parts of the page that are in shadow (it used to crop away the clefs on unevenly lit photos).
Other
- 63 Node tests (12 new, including a note-for-note comparison of the AI path against the MusicXML importer on five real scores), recognition-server API tests, a 25-check end-to-end browser suite, and a GitHub Actions job that builds the server image and runs real homr on test photos.

## 6.0.0: practice tools and progress
New
- **Hands separately**: practise the right or left hand on its own. In Listen mode your hand's keys light up as a guide while the app plays the other hand; in Wait mode the app waits only for your hand and plays the other hand as you go. Disabled automatically for one-hand pieces.
- **Loop a section** by bar number (works through repeats, shown in amber in the sheet music), in Listen and Wait mode. **Speed trainer**: loops start at 70% of your tempo and get 5% faster each pass until they reach it.
- **Metronome** (accented downbeats; dotted-quarter clicks in 6/8, 9/8, 12/8; pickup bars handled) and a one-bar **count-in**. Settings are remembered.
- **Progress tracking**: every Wait-mode session is saved (accuracy, time, hand, loop). The summary shows your best score, recent sessions and your **trickiest bars**, each with a one-tap **Loop this bar**. Library cards show "Practised 3× · best 94% · today"; the library shows your practice streak.
- **Library management**: rename and delete imported pieces (delete needs a second tap); **back up** your whole library and practice history to a file and **restore** it on any device (Settings).
Fixes found by the new tests
- Loop passes were miscounted when playback started before reaching the loop.
- A "Loop bars 8 to 5" request in a piece with repeats wrapped round the repeat instead of reporting a mistake.
- Short looped sessions (under 5 notes) were not saved to history.
Other
- 51 Node tests (12 new), 29-check practice-tools browser suite, 34-check regression suite, 7-check offline suite.

## 5.2.0
MusicXML import (.musicxml/.xml/.mxl, repeats, ties, tuplets, part chooser); Verovio sheet music with bar and note highlighting; grand piano samples; installable offline app.

## 5.1.1
Camera/Photos/PDF report missing `omr/` files; header layout fixed.

## 5.1.0
Stability: save errors reported, older libraries migrated, duplicate cards, stuck notes and recognition hangs fixed, MIDI keyboards and Wait-mode scoring restored.

## 5.0.0
OMR review loop.
