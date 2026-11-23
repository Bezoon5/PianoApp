# Changelog

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
