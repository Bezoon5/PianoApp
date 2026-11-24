/* Piano Companion 6: library, storage, sound, practice tools, progress, notation and app shell. */
(function () {
  'use strict';
  const $ = s => document.querySelector(s);
  const PR = window.PCPractice;
  let db = null, song = null, part = null, metroPart = null, anim = null, mode = 'listen', libraryFilter = 'all';
  let renderGen = 0, pressSeq = 0, segs = [], sheetReady = false, openGen = 0, playing = false, lastBeat = 0, inLoop = false;
  const held = new Map();      // midi -> number of active sources (touch, MIDI)
  const pressed = new Map();   // midi -> press token for touch
  const attacked = new Map();  // midi -> instrument that started it
  const score = { hits: 0, wrong: 0, start: 0 };

  // v6 practice state
  const tools = Object.assign({ metronome: false, countIn: true, trainer: false, trainerStart: 70 }, readJSON('pc-tools-v6', {}));
  let hand = 'both', loopOn = false, loopRange = null, pass = 0, targetBpm = 100;
  let waitEvs = [], waitIdx = 0, waitRange = null, waitPasses = 0, barStats = {}, sessionLogged = false, accompTimers = [];
  // v6.3: microphone, play along, recording, falling notes
  let mic = null, along = null, recording = null, takePlay = null, lastPos = 0;
  let fallingOn = localStorage.getItem('pc-falling') === '1';
  const judged = new Map();   // 'beat:midi' -> play-along result, for colouring falling notes
  const NOTE_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
  const noteName = m => NOTE_NAMES[m % 12] + (Math.floor(m / 12) - 1);

  /* ------------------------- Built-in repertoire ------------------------- */
  const N = { C3: 48, D3: 50, E3: 52, F3: 53, G3: 55, A3: 57, B3: 59, C4: 60, D4: 62, E4: 64, F4: 65, G4: 67, A4: 69, B4: 71, C5: 72, D5: 74, E5: 76, F5: 77, G5: 79, A5: 81, B5: 83, C6: 84 };
  const mk = (id, title, bpm, meter, seq) => ({ id, title, bpm, composer: 'Traditional · public-domain melody', source: 'Christmas', category: 'christmas', builtin: true, timeSignature: meter, notes: seq.split(' ').map((x, i) => ({ midi: N[x] || 60, startBeat: i, durationBeats: 0.9, velocity: 0.7, hand: 'right' })) });
  const built = [
    mk('silent', 'Silent Night', 72, [3, 4], 'G4 A4 G4 E4 G4 A4 G4 E4 D5 D5 B4 C5 C5 G4 A4 A4 C5 B4 A4 G4 A4 G4 E4'),
    mk('away', 'Away in a Manger', 86, [3, 4], 'F4 F4 E4 D4 D4 C4 B3 A3 G3 F3 E3 D3 C3 F4 F4 E4 D4 D4 C4'),
    mk('jingle', 'Jingle Bells', 110, [4, 4], 'E4 E4 E4 E4 E4 E4 E4 G4 C4 D4 E4 F4 F4 F4 F4 F4 E4 E4 E4 E4 D4 D4 E4 D4 G4'),
    mk('adeste', 'O Come, All Ye Faithful', 92, [4, 4], 'G4 G4 D4 G4 A4 D4 B4 A4 B4 C5 B4 A4 G4 F4 E4 F4 G4 A4 F4 E4 D4 C4 B3 A3 G3'),
    mk('hark', 'Hark! The Herald Angels Sing', 104, [4, 4], 'G4 C5 C5 B4 C5 E5 E5 D5 G5 G5 G5 F5 E5 D5 E5 C5 D5 E5 F5 G5'),
    mk('birthday', 'Happy Birthday', 100, [3, 4], 'G4 G4 A4 G4 C5 B4 G4 G4 A4 G4 D5 C5 G4 G4 G5 E5 C5 B4 A4 F5 F5 E5 C5 D5 C5'),
    mk('joy', 'Joy to the World', 112, [4, 4], 'C5 B4 A4 G4 F4 E4 D4 C4 G4 A4 A4 B4 B4 C5 C5 C5 B4 A4 G4 G4 F4 E4 C5 C5 B4 A4 G4'),
    mk('first-noel', 'The First Noel', 88, [3, 4], 'E4 D4 C4 D4 E4 F4 G4 A4 B4 C5 B4 A4 G4 A4 B4 C5 B4 A4 G4 F4 E4'),
    mk('little-town', 'O Little Town of Bethlehem', 82, [4, 4], 'B4 B4 B4 A4 G4 F4 E4 F4 G4 A4 B4 B4 C5 B4 A4 G4 F4 E4 D4 E4 F4 G4'),
    mk('god-rest', 'God Rest Ye Merry, Gentlemen', 96, [4, 4], 'E4 E4 B4 B4 A4 G4 F4 E4 D4 E4 F4 G4 A4 B4 C5 B4 A4 G4 F4 E4'),
    mk('deck', 'Deck the Hall', 116, [4, 4], 'G4 F4 E4 D4 C4 D4 E4 C4 D4 E4 F4 D4 E4 D4 C4 B3 C4 D4 E4 C4'),
    mk('we-three', 'We Three Kings', 84, [3, 4], 'B4 A4 G4 E4 F4 G4 F4 E4 D4 C4 D4 E4 G4 F4 E4 D4 C4 B3 C4 D4 E4'),
    mk('what-child', 'What Child Is This', 82, [3, 4], 'E4 G4 A4 B4 C5 B4 A4 F4 D4 E4 F4 G4 E4 E4 D4 E4 F4 D4 B3 C4 D4 E4'),
    mk('angels', 'Angels We Have Heard on High', 104, [4, 4], 'G4 A4 B4 C5 B4 A4 G4 F4 E4 F4 G4 A4 B4 C5 D5 C5 B4 A4 G4'),
    mk('midnight', 'It Came Upon the Midnight Clear', 86, [4, 4], 'C4 E4 F4 G4 A4 G4 F4 E4 D4 C4 D4 E4 F4 E4 D4 C4'),
    mk('emmanuel', 'O Come, O Come, Emmanuel', 76, [4, 4], 'E4 G4 B4 B4 A4 C5 B4 A4 G4 F4 E4 G4 A4 F4 E4 D4 E4 F4 G4 A4'),
    mk('holy-night', 'O Holy Night', 72, [6, 8], 'C4 E4 G4 G4 A4 A4 E4 G4 C5 B4 A4 G4 F4 E4 D4 C4'),
    mk('saw-ships', 'I Saw Three Ships', 112, [6, 8], 'G4 G4 A4 B4 C5 B4 A4 G4 E4 G4 A4 B4 C5 D5 C5 B4 A4 G4'),
    mk('shepherds', 'While Shepherds Watched Their Flocks', 88, [4, 4], 'G4 A4 B4 C5 B4 A4 G4 F4 E4 D4 C4 D4 E4 F4 G4 A4 G4 F4 E4'),
    mk('bleak', 'In the Bleak Midwinter', 74, [4, 4], 'E4 F4 G4 A4 G4 F4 E4 D4 C4 E4 G4 C5 B4 A4 G4 F4 E4'),
    mk('kings', 'Good King Wenceslas', 104, [4, 4], 'G4 G4 G4 A4 G4 G4 D4 E4 D4 E4 F4 G4 G4 F4 E4 D4 C4 D4 E4'),
    mk('ding', 'Ding Dong! Merrily on High', 110, [4, 4], 'G4 A4 B4 C5 D5 C5 B4 A4 G4 B4 D5 C5 B4 A4 G4'),
    mk('holly', 'The Holly and the Ivy', 98, [4, 4], 'G4 E4 F4 G4 A4 G4 F4 E4 D4 E4 F4 G4 E4 C4 D4 E4 F4 G4'),
    mk('coventry', 'Coventry Carol', 72, [3, 4], 'E4 F4 G4 A4 B4 A4 G4 F4 E4 D4 E4 F4 G4 A4 G4 F4 E4'),
    mk('boar', 'The Boar’s Head Carol', 102, [4, 4], 'G4 G4 C5 B4 A4 G4 F4 E4 D4 G4 A4 B4 C5 D5 C5 B4 A4 G4')
  ];

  function readJSON(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
  function writeJSON(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } }

  /* ------------------------------ Storage ------------------------------- */
  const DB_NAME = 'PC44';
  const LEGACY_DBS = ['PianoCompanion2', 'PianoCompanion4', 'PianoCompanion41', 'PianoCompanion42'];
  function openDb() {
    return new Promise(ok => {
      if (!window.indexedDB) return ok(null);
      let r;
      try { r = indexedDB.open(DB_NAME, 2); } catch (e) { return ok(null); }
      r.onupgradeneeded = () => {
        const d = r.result;
        if (!d.objectStoreNames.contains('songs')) d.createObjectStore('songs', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('scans')) d.createObjectStore('scans', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('takes')) d.createObjectStore('takes', { keyPath: 'id' });   // v6.3 recordings
      };
      // Another tab with an older version can block the upgrade: give it a few seconds to
      // let go (the upgrade then completes) before carrying on without storage.
      let blocked = 0;
      r.onsuccess = () => { clearTimeout(blocked); const d = r.result; d.onversionchange = () => d.close(); ok(d); };
      r.onerror = () => { clearTimeout(blocked); ok(null); };
      r.onblocked = () => { blocked = setTimeout(() => { ok(null); setTimeout(() => libStatus('Your saved music could not be opened because Piano Companion is open in another tab. Close the other tab and reload.', true), 0); }, 4000); };
    });
  }
  function allSongs() {
    if (!db) return Promise.resolve([]);
    return new Promise(ok => {
      try { const r = db.transaction('songs').objectStore('songs').getAll(); r.onsuccess = () => ok(r.result || []); r.onerror = () => ok([]); }
      catch (e) { ok([]); }
    });
  }
  /** Resolves when the transaction commits; rejects on error, abort or full storage. */
  function txWrite(store, fn) {
    if (!db) return Promise.reject(new Error('local storage is unavailable (private browsing or storage disabled)'));
    return new Promise((ok, fail) => {
      let tx;
      try { tx = db.transaction(store, 'readwrite'); fn(tx.objectStore(store)); } catch (e) { return fail(e); }
      tx.oncomplete = () => ok();
      tx.onerror = () => fail(tx.error || new Error('write failed'));
      tx.onabort = () => fail(tx.error || new Error('write was aborted'));
    });
  }
  const put = (store, value) => txWrite(store, s => s.put(value));
  const del = (store, id) => txWrite(store, s => s.delete(id));
  function readLegacy(name) {
    return new Promise(ok => {
      let r, fresh = false;
      try { r = indexedDB.open(name); } catch (e) { return ok([]); }
      r.onupgradeneeded = () => { fresh = true; r.transaction.abort(); };
      r.onerror = () => ok([]); r.onblocked = () => ok([]);
      r.onsuccess = () => {
        const d = r.result;
        if (fresh || !d.objectStoreNames.contains('songs')) { d.close(); return ok([]); }
        try { const q = d.transaction('songs').objectStore('songs').getAll(); q.onsuccess = () => { d.close(); ok(q.result || []); }; q.onerror = () => { d.close(); ok([]); }; }
        catch (e) { d.close(); ok([]); }
      };
    });
  }
  function normaliseLegacy(s, dbName) {
    if (!s || !Array.isArray(s.notes) || !s.notes.length) return null;
    const notes = s.notes.map(n => ({
      midi: n.midi, velocity: n.velocity || 0.72,
      startBeat: n.startBeat != null ? n.startBeat : (n.start != null ? n.start : 0),
      durationBeats: n.durationBeats != null ? n.durationBeats : (n.duration != null ? n.duration : 1),
      hand: n.hand || (n.midi < 60 ? 'left' : 'right')
    })).filter(n => n.midi >= 21 && n.midi <= 108 && isFinite(n.startBeat) && n.durationBeats > 0);
    if (!notes.length) return null;
    return { id: 'legacy-' + dbName + '-' + s.id, title: s.title || 'Imported piece', composer: s.composer || 'Imported (earlier version)', bpm: Math.round(s.bpm || 100), source: s.source || 'Imported', category: 'imported', timeSignature: s.timeSignature || [4, 4], notes, migratedFrom: dbName };
  }
  async function migrateLegacy() {
    if (!db || localStorage.getItem('pc-migrated-v51') === '1') return 0;
    const existing = new Set((await allSongs()).map(s => s.id));
    let copied = 0;
    for (const name of LEGACY_DBS) for (const s of await readLegacy(name)) {
      const n = normaliseLegacy(s, name);
      if (!n || existing.has(n.id)) continue;
      try { await put('songs', n); copied++; } catch (e) { return copied; }
    }
    localStorage.setItem('pc-migrated-v51', '1');
    return copied;
  }

  /* v6: practice history (localStorage; included in backups) */
  const HKEY = 'pc-history-v6';
  const BKEY = 'pc-last-backup', SNOOZE = 'pc-backup-snooze'; // when the library was last backed up / reminder snoozed
  const lastBackup = () => +readJSON(BKEY, 0) || 0;
  const history = () => readJSON(HKEY, {});
  function recordSession(s) { const h = PR.addSession(history(), song.id, s); writeJSON(HKEY, h); }

  /* ----------------------------- Navigation ----------------------------- */
  function nav(id) {
    if (id !== 'practice') { endWaitSession(); endAlongSession(); if (recording) stopRecording(); stop(); if (mic) stopMic(); }
    document.querySelectorAll('.screen').forEach(x => x.classList.toggle('active', x.id === id));
    if (id === 'library') render();
  }
  $('#start').onclick = () => nav('library');
  document.querySelectorAll('[data-nav]').forEach(b => b.onclick = () => nav(b.dataset.nav));

  /* ------------------------------ Library ------------------------------- */
  /* Reminder to back up pieces that exist only on this device */
  async function renderNudge(songs) {
    const box = $('#backupNudge'); if (!box) return;
    songs = songs || await allSongs();
    const pending = PR.unbackedUp(songs, lastBackup()), snoozed = (+readJSON(SNOOZE, 0) || 0) > Date.now();
    box.hidden = !pending.length || snoozed;
    if (!box.hidden) $('#nudgeText').textContent = (pending.length === 1 ? '1 piece is saved only on this device. Back it up or send it' : pending.length + ' pieces are saved only on this device. Back them up or send them') + ' to your other device.';
  }
  $('#nudgeSend').onclick = () => sendLibrary(t => { $('#nudgeText').textContent = t; });
  $('#nudgeLater').onclick = () => { writeJSON(SNOOZE, Date.now() + 7 * 86400000); $('#backupNudge').hidden = true; };
  async function render() {
    const gen = ++renderGen;
    const raw = await allSongs();
    const imported = raw.map(s => Object.assign({}, s, { category: s.category || 'imported' }));
    if (gen !== renderGen) return;
    renderNudge(raw);
    const hist = history();
    const list = [...built, ...imported].filter(s => libraryFilter === 'all' || s.category === libraryFilter);
    const frag = document.createDocumentFragment();
    for (const s of list) {
      const c = document.createElement('article');
      c.className = 'card'; c.dataset.id = s.id;
      c.innerHTML = '<span class="tag"></span><h3></h3><p></p><p class="progress"></p><div class="card-actions"><button class="primary play">Play</button></div>';
      c.querySelector('.tag').textContent = s.category === 'christmas' ? 'Christmas · public domain' : s.source === 'OMR' ? 'Scanned · reviewed' : s.source === 'MusicXML' ? 'MusicXML' : s.migratedFrom ? 'Imported · earlier version' : 'Imported';
      c.querySelector('h3').textContent = s.title;
      c.querySelector('p').textContent = (s.composer || '') + ' · ' + s.bpm + ' BPM' + (s.omr ? ' · ' + s.omr.measures + ' measures' : '') + (s.partName && s.source === 'MusicXML' ? ' · ' + s.partName : '');
      const sum = PR.summarise(hist[s.id]);
      const pg = c.querySelector('.progress');
      if (sum.count) pg.textContent = 'Practised ' + sum.count + '× · ' + (sum.best != null ? 'best ' + sum.best + '% · ' : '') + PR.relativeDay(sum.last);
      else pg.remove();
      c.querySelector('.play').onclick = () => openSong(s);
      const actions = c.querySelector('.card-actions');
      if (s.musicxml) {
        const x = document.createElement('button'); x.textContent = 'MusicXML';
        x.onclick = () => download(s.musicxml, s.title + '.musicxml', 'application/vnd.recordare.musicxml+xml');
        actions.append(x);
      }
      if (!s.builtin) {
        const e = document.createElement('button'); e.textContent = 'Edit'; e.className = 'edit';
        e.onclick = () => openEdit(s);
        actions.append(e);
      }
      frag.append(c);
    }
    $('#songs').replaceChildren(frag);
    const all = Object.keys(hist).reduce((a, k) => a.concat((hist[k] || []).map(x => x.date)), []);
    const n = PR.streak(all);
    $('#streak').textContent = n ? '🔥 ' + n + '-day practice streak' : '';
    if (!db) libStatus('Local storage is unavailable, so imported music cannot be kept on this device.', true);
  }
  function libStatus(t, warn) { const el = $('#libStatus'); el.textContent = t; el.classList.toggle('warn', !!warn); }
  document.querySelectorAll('[data-filter]').forEach(b => b.onclick = () => {
    libraryFilter = b.dataset.filter;
    document.querySelectorAll('[data-filter]').forEach(x => x.classList.toggle('primary', x === b));
    render();
  });
  function download(text, name, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name.replace(/[^\w\-. ]+/g, '').trim().replace(/\s+/g, '-') || 'file';
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  }

  /* v6: rename and delete imported pieces */
  let editing = null, deleteArmed = false;
  function openEdit(s) {
    editing = s; deleteArmed = false;
    $('#editTitle').value = s.title;
    $('#editDelete').textContent = 'Delete';
    $('#editStatus').textContent = '';
    $('#editDlg').showModal();
  }
  $('#editCancel').onclick = () => $('#editDlg').close();
  $('#editSave').onclick = async () => {
    const t = $('#editTitle').value.trim();
    if (!t) { $('#editStatus').textContent = 'Enter a title.'; return; }
    try {
      const fresh = (await allSongs()).find(x => x.id === editing.id) || editing;
      fresh.title = t;
      fresh.updatedAt = Date.now();
      await put('songs', fresh);
      $('#editDlg').close(); libStatus('Renamed to “' + t + '”.'); render();
    } catch (e) { $('#editStatus').textContent = 'Could not save: ' + e.message; }
  };
  $('#editDelete').onclick = async () => {
    if (!deleteArmed) { deleteArmed = true; $('#editDelete').textContent = 'Tap again to delete'; return; }
    try {
      await del('songs', editing.id);
      const h = history(); delete h[editing.id]; writeJSON(HKEY, h);
      $('#editDlg').close(); libStatus('Deleted “' + editing.title + '”.'); render();
    } catch (e) { $('#editStatus').textContent = 'Could not delete: ' + e.message; }
  };

  /* ------------------------------- Sound -------------------------------- */
  const SAMPLE_BASE = 'https://tonejs.github.io/audio/salamander/';
  const SAMPLE_NOTES = ['A0', 'C1', 'D#1', 'F#1', 'A1', 'C2', 'D#2', 'F#2', 'A2', 'C3', 'D#3', 'F#3', 'A3', 'C4', 'D#4', 'F#4', 'A4', 'C5', 'D#5', 'F#5', 'A5', 'C6', 'D#6', 'F#6', 'A6', 'C7', 'D#7', 'F#7', 'A7', 'C8'];
  const SAMPLE_URLS = {};
  SAMPLE_NOTES.forEach(n => { SAMPLE_URLS[n] = n.replace('#', 's') + '.mp3'; });
  let synth = null, sampler = null, clickSynth = null, samplerState = 'idle', soundPref = localStorage.getItem('pc-sound') || 'piano';
  function soundStatus(t) { const el = $('#soundStatus'); if (el) el.textContent = t; }
  function ensureSynth() {
    if (!synth) synth = new Tone.PolySynth(Tone.Synth, { envelope: { attack: 0.005, decay: 0.3, sustain: 0.3, release: 0.8 } }).toDestination();
    return synth;
  }
  function instrument() { return soundPref === 'piano' && samplerState === 'ready' ? sampler : ensureSynth(); }
  function loadSampler() {
    if (!window.Tone || !Tone.Sampler || soundPref !== 'piano' || samplerState === 'loading' || samplerState === 'ready') return;
    samplerState = 'loading';
    soundStatus('Loading grand piano sound…');
    const fail = msg => { clearTimeout(timer); if (samplerState !== 'ready') { samplerState = 'failed'; soundStatus(msg || 'Grand piano sound could not load (offline?). Using the simple synth.'); } };
    const timer = setTimeout(() => fail('Grand piano sound is taking too long to load. Using the simple synth.'), 30000);
    try {
      sampler = new Tone.Sampler({
        urls: SAMPLE_URLS, baseUrl: SAMPLE_BASE, release: 1.2,
        onload: () => { clearTimeout(timer); if (samplerState === 'loading') { samplerState = 'ready'; soundStatus('Grand piano sound ready.'); } },
        onerror: () => fail()
      }).toDestination();
    } catch (e) { fail(); }
  }
  async function audio() {
    if (!window.Tone) throw Error('Tone.js unavailable');
    await Tone.start();
    ensureSynth();
    loadSampler();
  }
  function click(time, accent) {
    micIgnore(accent ? 84 : 79, time + 0.08);
    if (!clickSynth) { clickSynth = new Tone.Synth({ oscillator: { type: 'square' }, envelope: { attack: 0.001, decay: 0.04, sustain: 0, release: 0.02 } }).toDestination(); clickSynth.volume.value = -12; }
    clickSynth.triggerAttackRelease(accent ? 'C6' : 'G5', 0.03, time, accent ? 1 : 0.6);
  }
  function releaseAllSound() { if (synth) synth.releaseAll(); if (sampler && sampler.releaseAll) sampler.releaseAll(); attacked.clear(); }
  $('#soundSel').value = soundPref;
  $('#soundSel').onchange = e => {
    soundPref = e.target.value; localStorage.setItem('pc-sound', soundPref);
    if (soundPref === 'piano') { if (samplerState === 'failed') samplerState = 'idle'; if (window.Tone) loadSampler(); }
    else soundStatus('Using the simple synth.');
  };

  /* ------------------------------ Practice ------------------------------ */
  function beatsPerMeasure(s) { s = s || song; return s && s.timeSignature ? s.timeSignature[0] * 4 / s.timeSignature[1] : 4; }
  function songEnd(s) { return s.totalBeats || Math.max(0, ...s.notes.map(n => n.startBeat + n.durationBeats)); }
  function segmentsFor(s) {
    if (s.segments && s.segments.length) return s.segments;
    const end = songEnd(s);
    if (s.measureStarts && s.measureStarts.length) return s.measureStarts.map((b, i) => ({ measure: i, number: String(i + 1), play: b, len: (i + 1 < s.measureStarts.length ? s.measureStarts[i + 1] : end) - b }));
    const L = beatsPerMeasure(s), n = Math.max(1, Math.ceil(end / L - 1e-6));
    return Array.from({ length: n }, (_, i) => ({ measure: i, number: String(i + 1), play: i * L, len: L }));
  }
  function segAt(beat) {
    let lo = 0, hi = segs.length - 1, ans = 0;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (segs[mid].play <= beat + 1e-6) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
    return segs[ans];
  }
  function openSong(s) {
    song = s; segs = segmentsFor(s); resetScore();
    $('#songTitle').textContent = s.title;
    $('#songMeta').textContent = (s.composer || '') + ' · ' + s.notes.length + ' notes';
    $('#tempo').value = s.bpm; $('#tempoOut').value = s.bpm + ' BPM'; targetBpm = s.bpm;
    $('#measure').textContent = 'Measure ' + (segs[0] ? segs[0].number : 1);
    // Tools reset per piece; hands default to both, loop off, sensible bars pre-filled.
    hand = 'both'; $('#handSel').value = 'both';
    const hasLeft = s.notes.some(n => n.hand === 'left');
    $('#handSel').disabled = !hasLeft; $('#handSel').title = hasLeft ? '' : 'This piece has only one hand';
    setLoop(false);
    const first = segs.find(x => x.len >= beatsPerMeasure(s) - 1e-6) || segs[0];
    const fi = segs.indexOf(first);
    $('#loopFrom').value = first ? first.number : 1;
    $('#loopTo').value = segs[Math.min(segs.length - 1, fi + 3)] ? segs[Math.min(segs.length - 1, fi + 3)].number : 1;
    toolStatus('');
    nav('practice');
    requestAnimationFrame(() => { piano(+$('#range').value); centerKeys(s); showView(); });
    setFalling(fallingOn);
    if (window.Tone && soundPref === 'piano') loadSampler();
  }
  $('#tempo').oninput = e => {
    $('#tempoOut').value = e.target.value + ' BPM';
    targetBpm = +e.target.value;
    if (mode === 'along' && playing) { endAlongSession(); stop(); toolStatus('Tempo changed: press Play to start again at ' + targetBpm + ' BPM.'); return; }
    if (window.Tone && playing && !(tools.trainer && loopOn)) Tone.Transport.bpm.rampTo(targetBpm, 0.1);
  };
  function setMode(m) {
    mode = m;
    ['listen', 'wait', 'along'].forEach(id => { $('#' + id).className = id === m ? 'primary' : ''; });
    $('#practice').classList.toggle('mode-along', m === 'along');
    updateMicExpected();
  }
  $('#listen').onclick = () => { endWaitSession(); endAlongSession(); stop(); setMode('listen'); clearExpected(); updateScore(); };
  $('#wait').onclick = () => { endAlongSession(); stop(); setMode('wait'); startWait(); };
  $('#along').onclick = () => { endWaitSession(); endAlongSession(); stop(); setMode('along'); clearExpected(); startAlong(); };

  /* v6 practice tools ------------------------------------------------------ */
  function toolStatus(t) { $('#toolStatus').textContent = t; }
  function saveTools() { writeJSON('pc-tools-v6', tools); }
  $('#metro').checked = tools.metronome; $('#countIn').checked = tools.countIn; $('#trainer').checked = tools.trainer;
  $('#metro').onchange = e => { tools.metronome = e.target.checked; saveTools(); };
  $('#countIn').onchange = e => { tools.countIn = e.target.checked; saveTools(); };
  $('#trainer').onchange = e => { tools.trainer = e.target.checked; saveTools(); if (tools.trainer && !loopOn) toolStatus('Speed trainer works with a loop: turn on Loop and choose the bars.'); };
  $('#handSel').onchange = e => { hand = e.target.value; if (mode === 'wait') { stop(); startWait(); } else if (mode === 'along') { endAlongSession(); stop(); } else if (playing) stop(); if (mic) micHint(); };
  function setLoop(on) {
    loopOn = on;
    $('#loopBtn').classList.toggle('primary', on);
    $('#loopBtn').setAttribute('aria-pressed', on ? 'true' : 'false');
    loopRange = null;
    if (!on && window.PCNotation && sheetReady) window.PCNotation.markRange(null, null);
  }
  /** The practice range: the whole piece, or the loop (with an error if the bars are invalid). */
  function activeRange() {
    if (!loopOn) return { startBeat: 0, endBeat: songEnd(song), label: null };
    const r = PR.resolveLoop(segs, $('#loopFrom').value, $('#loopTo').value);
    if (!r.error) {
      loopRange = r;
      if (sheetReady) window.PCNotation.markRange(segs[r.from].measure, segs[r.to].measure);
    }
    return r;
  }
  $('#loopBtn').onclick = () => {
    const was = playing;
    stop(); setLoop(!loopOn);
    if (loopOn) {
      const r = activeRange();
      toolStatus(r.error ? r.error : 'Looping ' + r.label + '.');
      if (r.error) setLoop(false);
    } else toolStatus('');
    if (mode === 'wait') startWait(); else if (mode === 'along') { endAlongSession(); if (was) startAlong(); } else if (was) $('#play').click();
  };
  ['#loopFrom', '#loopTo'].forEach(id => $(id).onchange = () => {
    if (!loopOn) return;
    stop();
    const r = activeRange();
    toolStatus(r.error ? r.error : 'Looping ' + r.label + '.');
    if (mode === 'wait' && !r.error) startWait();
  });

  function beatsToTicks(b) { return Math.max(0, Math.round(b * Tone.Transport.PPQ)) + 'i'; }
  $('#play').onclick = async () => {
    if (!song) return;
    if (mode === 'wait') { stop(); startWait(); return; }
    if (mode === 'along') { endAlongSession(); startAlong(); return; }
    const range = activeRange();
    if (range.error) { toolStatus(range.error); return; }
    try { await audio(); } catch (e) { $('#measure').textContent = 'Audio unavailable'; return; }
    stop(false);
    targetBpm = +$('#tempo').value; pass = 0;
    const bpm = tools.trainer && loopOn ? PR.speedTrainer(targetBpm, tools.trainerStart, 0) : targetBpm;
    Tone.Transport.bpm.value = bpm;
    // Hands separately: the app plays the other hand; your hand's keys light up as a guide.
    const events = song.notes.map(n => Object.assign({}, n, { guide: hand !== 'both' && PR.inHand(n, hand), time: beatsToTicks(n.startBeat) }));
    part = new Tone.Part((time, n) => {
      const dur = beatsToTicks(n.durationBeats);
      if (!n.guide) { instrument().triggerAttackRelease(Tone.Frequency(n.midi, 'midi').toNote(), dur, time, n.velocity || 0.7); micIgnore(n.midi, time + Tone.Time(dur).toSeconds()); }
      Tone.Draw.schedule(() => light(n.midi, 1, n.guide), time);
      Tone.Draw.schedule(() => light(n.midi, 0, n.guide), time + Tone.Time(dur).toSeconds());
    }, events).start(0);
    if (tools.metronome) {
      metroPart = new Tone.Part((time, c) => click(time, c.accent), PR.clicks(segs, song.timeSignature, 0, songEnd(song)).map(c => ({ time: beatsToTicks(c.beat), accent: c.accent }))).start(0);
    }
    if (loopOn) {
      Tone.Transport.loop = true;
      Tone.Transport.loopStart = beatsToTicks(range.startBeat);
      Tone.Transport.loopEnd = beatsToTicks(range.endBeat);
      toolStatus('Looping ' + range.label + (tools.trainer ? ' · speed trainer ' + bpm + ' → ' + targetBpm + ' BPM' : '') + '.');
    } else {
      Tone.Transport.loop = false;
      Tone.Transport.scheduleOnce(() => Tone.Draw.schedule(() => stop(), Tone.now()), beatsToTicks(songEnd(song) + 0.5));
    }
    if (hand !== 'both') toolStatus((loopOn ? $('#toolStatus').textContent + ' ' : '') + 'You play the ' + hand + ' hand (lit keys); the app plays the other.');
    let at = Tone.now() + 0.05;
    if (tools.countIn) {
      const ci = PR.countIn(song.timeSignature), spb = 60 / bpm, base = $('#toolStatus').textContent;
      ci.clicks.forEach(c => click(at + c.beat * spb, c.accent));
      at += ci.beats * spb;
      toolStatus((base ? base + ' ' : '') + 'Count-in…');
      accompTimers.push(setTimeout(() => { if (playing && /Count-in…$/.test($('#toolStatus').textContent)) toolStatus(base); }, ci.beats * spb * 1000 + 60));
    }
    playing = true; lastBeat = range.startBeat; inLoop = false;
    Tone.Transport.start(at, beatsToTicks(range.startBeat));
    tick();
  };
  $('#stop').onclick = () => { if (mode === 'along') endAlongSession(); stop(); if (mode === 'wait') endWaitSession(); };
  function stop(redraw) {
    playing = false;
    endTakePlay();
    cancelAnimationFrame(anim);
    if (part) { part.dispose(); part = null; }
    if (metroPart) { metroPart.dispose(); metroPart = null; }
    if (window.Tone) { Tone.Transport.stop(); Tone.Transport.cancel(); Tone.Transport.loop = false; }
    accompTimers.forEach(clearTimeout); accompTimers = [];
    releaseAllSound();
    document.querySelectorAll('.key.on,.key.guide').forEach(k => k.classList.remove('on', 'guide'));
    if (redraw !== false && song) position(loopOn && loopRange ? loopRange.startBeat : 0);
  }
  function tick() {
    if (!playing) return;
    if (Tone.Transport.state === 'started') {
      const b = Tone.Transport.ticks / Tone.Transport.PPQ;
      // A loop pass is a jump back after playback has been inside the loop;
      // positions before the loop start (transport not yet there) are ignored.
      if (loopOn && loopRange) {
        if (b >= loopRange.startBeat - 0.01) {
          if (inLoop && b < lastBeat - 0.25) onLoopPass();
          inLoop = true; lastBeat = b;
        }
      } else lastBeat = b;
      if (mode === 'along' && along) alongTick(); else position(b);
    }
    anim = requestAnimationFrame(tick);
  }
  function onLoopPass() {
    pass++;
    let msg = 'Looping ' + loopRange.label + ' · pass ' + (pass + 1);
    if (tools.trainer) {
      const bpm = PR.speedTrainer(targetBpm, tools.trainerStart, pass);
      Tone.Transport.bpm.value = bpm;
      msg += ' · ' + bpm + (bpm >= targetBpm ? ' BPM (target reached)' : ' → ' + targetBpm + ' BPM');
    }
    toolStatus(msg + '.');
  }
  function position(beat) {
    lastPos = beat;
    const seg = segAt(beat);
    if (seg) $('#measure').textContent = 'Measure ' + seg.number;
    if (sheetReady && seg) window.PCNotation.highlight(seg.measure, beat - seg.play);
    else draw(beat);
    drawRoad(beat);
  }

  /* Input: touch keyboard and Web MIDI share one path --------------------- */
  // A release that arrives while audio is still starting cancels the pending
  // note for every input (touch and MIDI), so nothing is left sounding.
  const pendingOn = new Map();
  /**
   * opt.silent: the note came from the microphone (your piano makes the sound, so the
   * app doesn't play it). opt.ctxTime: when it was played, in audio-clock seconds
   * (for play-along timing); defaults to now.
   */
  async function noteOn(m, velocity, opt) {
    opt = opt || {};
    const at = opt.ctxTime != null ? opt.ctxTime : audioNow();
    recordNote(m, velocity, true);
    const tok = ++pressSeq;
    pendingOn.set(m, tok);
    try { await audio(); } catch (e) { pendingOn.delete(m); return false; }
    if (pendingOn.get(m) !== tok) return false;
    pendingOn.delete(m);
    if (!opt.silent) {
      const inst = instrument();
      inst.triggerAttack(Tone.Frequency(m, 'midi').toNote(), undefined, velocity || 0.75);
      attacked.set(m, inst);
    }
    held.set(m, (held.get(m) || 0) + 1);
    light(m, 1);
    if (mode === 'wait') checkWait(m);
    else if (mode === 'along') alongPress(m, at);
    return true;
  }
  function noteOff(m) {
    recordNote(m, 0, false);
    if (pendingOn.has(m)) { pendingOn.delete(m); return; }
    const c = (held.get(m) || 0) - 1;
    if (c > 0) { held.set(m, c); return; }
    held.delete(m);
    const inst = attacked.get(m);
    attacked.delete(m);
    if (inst && window.Tone) inst.triggerRelease(Tone.Frequency(m, 'midi').toNote());
    light(m, 0);
  }
  /** The audio clock (seconds); 0 before audio starts. */
  function audioNow() { try { return window.Tone ? Tone.context.rawContext.currentTime : 0; } catch (e) { return 0; } }
  /** Convert an event's timeStamp (performance clock) to the audio clock. */
  function ctxTimeOf(ev) { const now = audioNow(); return ev && ev.timeStamp && now ? now - Math.max(0, performance.now() - ev.timeStamp) / 1000 : now; }

  const bk = new Set([1, 3, 6, 8, 10]), ranges = { 61: [36, 96], 76: [28, 103], 88: [21, 108] };
  function piano(size) {
    const el = $('#piano'), r = ranges[Math.min(88, size)] || ranges[88], wh = [];
    el.replaceChildren();
    for (let m = r[0]; m <= r[1]; m++) if (!bk.has(m % 12)) wh.push(m);
    el.style.setProperty('--whites', wh.length);
    for (let m = r[0]; m <= r[1]; m++) {
      const k = document.createElement('button'), black = bk.has(m % 12);
      k.className = 'key ' + (black ? 'black' : 'white'); k.dataset.m = m;
      k.setAttribute('aria-label', 'MIDI note ' + m);
      if (black) k.style.left = 'calc(' + wh.filter(x => x < m).length + ' * var(--ww) - 9px)';
      k.onpointerdown = async ev => {
        ev.preventDefault();
        const tok = ++pressSeq;
        pressed.set(m, tok);
        try { await audio(); } catch (e) { return; }
        if (pressed.get(m) !== tok) return;
        pressed.set(m, 'on');
        noteOn(m, 0.75, { ctxTime: ctxTimeOf(ev) });
      };
      const up = () => { const p = pressed.get(m); pressed.delete(m); if (p === 'on') noteOff(m); };
      k.onpointerup = up; k.onpointerleave = up; k.onpointercancel = up;
      el.append(k);
    }
  }
  /** On narrow screens, scroll the keyboard so the piece's notes are in view. */
  function centerKeys(s) {
    const wrap = $('.pwrap'); if (!wrap || !s || !s.notes.length || wrap.scrollWidth <= wrap.clientWidth + 4) return;
    const ms = s.notes.map(n => n.midi).sort((a, b) => a - b), lo = ms[Math.floor(ms.length * 0.05)], hi = ms[Math.floor(ms.length * 0.95)];
    const kl = document.querySelector('#piano [data-m="' + lo + '"]'), kh = document.querySelector('#piano [data-m="' + hi + '"]');
    if (!kl || !kh) return;
    const mid = (kl.offsetLeft + kh.offsetLeft + kh.offsetWidth) / 2;
    wrap.scrollLeft = Math.max(0, mid - wrap.clientWidth / 2);
  }
  function light(m, on, guide) { const k = document.querySelector('#piano [data-m="' + m + '"]'); if (k) k.classList.toggle(guide ? 'guide' : 'on', !!on); }

  /* Web MIDI ---------------------------------------------------------------- */
  function midiStatus(t) { const el = $('#midiStatus'); if (el) el.textContent = t; }
  async function connectMidi() {
    if (!navigator.requestMIDIAccess) { midiStatus('MIDI keyboards are not supported in this browser (Safari on iPhone and iPad does not support Web MIDI). On iPhone and iPad, use 🎤 Mic on the practice screen to listen to your piano instead; on a computer, Chrome or Edge can connect a MIDI keyboard.'); return; }
    try {
      const access = await navigator.requestMIDIAccess();
      const bind = () => {
        let n = 0;
        access.inputs.forEach(input => {
          n++;
          input.onmidimessage = e => {
            const [st, note, vel] = e.data, cmd = st & 0xf0;
            if (cmd === 0x90 && vel > 0) noteOn(note, vel / 127, { ctxTime: ctxTimeOf(e) });
            else if (cmd === 0x80 || (cmd === 0x90 && vel === 0)) noteOff(note);
          };
        });
        midiStatus(n ? n + ' MIDI keyboard(s) connected.' : 'No MIDI keyboard connected. Plug one in and it will be detected.');
      };
      bind(); access.onstatechange = bind;
    } catch (e) { midiStatus('MIDI access was not granted.'); }
  }

  /* Wait mode: hands, loops, scoring, progress ------------------------------ */
  function clearExpected() { document.querySelectorAll('.expect').forEach(x => x.classList.remove('expect')); }
  async function startWait() {
    endWaitSession();
    resetScore(); barStats = {}; waitPasses = 0; sessionLogged = false;
    const r = activeRange();
    if (r.error) { toolStatus(r.error); waitEvs = []; clearExpected(); return; }
    waitRange = r;
    waitEvs = PR.waitEvents(song.notes, { hand, start: r.startBeat, end: r.endBeat });
    waitIdx = 0;
    if (!waitEvs.length) { toolStatus('No notes for the ' + (hand === 'both' ? '' : hand + ' hand ') + 'in ' + (r.label || 'this piece') + '.'); clearExpected(); return; }
    const parts = [];
    if (hand !== 'both') parts.push((hand === 'right' ? 'Right' : 'Left') + ' hand only; the app plays the other hand');
    if (loopOn) parts.push('looping ' + r.label);
    toolStatus(parts.length ? parts.join(' · ') + '.' : '');
    try { await audio(); playAccomp(r.startBeat, waitEvs[0].beat, 0); } catch (e) { /* audio starts on first key */ }
    expected();
  }
  /** Play the other hand's notes that start in [t0, t1), `delay` beats from now. */
  function playAccomp(t0, t1, delay) {
    if (!window.Tone || hand === 'both') return;
    const notes = PR.accompaniment(song.notes, hand, t0, t1);
    if (!notes.length) return;
    const spb = 60 / (+$('#tempo').value || 100), now = Tone.now() + 0.03, inst = instrument();
    notes.forEach(n => {
      const at = (delay || 0) + n.startBeat - t0;
      inst.triggerAttackRelease(Tone.Frequency(n.midi, 'midi').toNote(), Math.max(0.05, n.durationBeats * spb), now + at * spb, (n.velocity || 0.7) * 0.85);
      micIgnore(n.midi, now + (at + n.durationBeats) * spb);
      accompTimers.push(setTimeout(() => light(n.midi, 1, true), at * spb * 1000));
      accompTimers.push(setTimeout(() => light(n.midi, 0, true), (at + n.durationBeats) * spb * 1000));
    });
  }
  function expected() {
    clearExpected();
    updateMicExpected();
    const ev = waitEvs[waitIdx];
    if (ev) { ev.midis.forEach(m => { const k = document.querySelector('#piano [data-m="' + m + '"]'); if (k) k.classList.add('expect'); }); position(ev.beat); }
    updateScore();
  }
  function barOf(beat) { const s = segAt(beat); return s ? s.number : '?'; }
  function checkWait(m) {
    const ev = waitEvs[waitIdx];
    if (!ev) return;
    if (!score.start) score.start = Date.now();
    const bar = barOf(ev.beat), st = barStats[bar] || (barStats[bar] = { wrong: 0, hits: 0 });
    if (ev.midis.indexOf(m) < 0) { score.wrong++; st.wrong++; flash(m, 'wrong'); updateScore(); return; }
    flash(m, 'right');
    if (!ev.midis.every(x => held.has(x))) return;
    score.hits += ev.midis.length; st.hits += ev.midis.length;
    const next = waitEvs[waitIdx + 1];
    playAccomp(ev.beat, next ? next.beat : waitRange.endBeat, 0);
    waitIdx++;
    if (waitIdx < waitEvs.length) { expected(); return; }
    if (loopOn) {
      waitPasses++;
      playAccomp(waitRange.startBeat, waitEvs[0].beat, waitRange.endBeat - ev.beat);
      waitIdx = 0;
      toolStatus('Looping ' + waitRange.label + ' · ' + waitPasses + ' pass' + (waitPasses === 1 ? '' : 'es') + ' completed · accuracy ' + (accuracy() == null ? '—' : accuracy() + '%') + '.');
      expected();
    } else { expected(); finishWait(); }
  }
  function flash(m, cls) { const k = document.querySelector('#piano [data-m="' + m + '"]'); if (!k) return; k.classList.add(cls); setTimeout(() => k.classList.remove(cls), 250); }
  function resetScore() { score.hits = 0; score.wrong = 0; score.start = 0; updateScore(); }
  function accuracy() { const t = score.hits + score.wrong; return t ? Math.round(score.hits / t * 100) : null; }
  function updateScore() {
    const el = $('#scoreOut'); if (!el) return;
    if (mode === 'along') { el.textContent = alongScoreText(); return; }
    if (mode !== 'wait' || !song || !waitEvs.length) { el.textContent = ''; return; }
    const pct = Math.round(Math.min(waitIdx, waitEvs.length) / waitEvs.length * 100), acc = accuracy();
    el.textContent = 'Progress ' + pct + '% · Accuracy ' + (acc == null ? '—' : acc + '%');
  }
  function sessionRecord(complete) {
    return {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), date: Date.now(), mode: 'wait', hand,
      loop: loopOn && waitRange ? waitRange.label : null, passes: waitPasses, complete,
      hits: score.hits, wrong: score.wrong, accuracy: accuracy(),
      seconds: score.start ? Math.round((Date.now() - score.start) / 1000) : 0,
      tricky: PR.trickiest(barStats).map(t => t.bar)
    };
  }
  /** Log an unfinished (or looping) Wait session when leaving it, if enough was played. */
  function endWaitSession() {
    if (mode !== 'wait' || !song || sessionLogged || (score.hits + score.wrong < 5 && !waitPasses)) return;
    recordSession(sessionRecord(false));
    sessionLogged = true;
  }
  function finishWait() {
    const rec = sessionRecord(true);
    recordSession(rec); sessionLogged = true;
    const sum = PR.summarise(history()[song.id]), acc = rec.accuracy;
    const body = $('#summaryBody'); body.replaceChildren();
    const p = (t, cls) => { const e = document.createElement('p'); e.textContent = t; if (cls) e.className = cls; body.append(e); return e; };
    p('You played ' + rec.hits + ' notes with ' + rec.wrong + ' wrong note' + (rec.wrong === 1 ? '' : 's') + ' · accuracy ' + (acc == null ? '—' : acc + '%') + ' · ' + Math.floor(rec.seconds / 60) + 'm ' + (rec.seconds % 60) + 's' + (hand !== 'both' ? ' · ' + hand + ' hand' : '') + '.');
    p((sum.best != null && acc != null && acc >= sum.best && sum.count > 1 ? '🏆 New best! ' : '') + 'Best for this piece: ' + (sum.best != null ? sum.best + '%' : '—') + ' · practised ' + sum.count + '×.', 'muted');
    const tricky = PR.trickiest(barStats);
    if (tricky.length) {
      p('Trickiest bars:');
      const ul = document.createElement('ul'); ul.className = 'tricky';
      tricky.forEach(t => {
        const li = document.createElement('li'), b = document.createElement('button');
        li.textContent = 'Bar ' + t.bar + ' · ' + t.wrong + ' wrong note' + (t.wrong === 1 ? '' : 's') + ' ';
        b.textContent = 'Loop this bar'; b.dataset.bar = t.bar;
        b.onclick = () => { $('#summaryDlg').close(); $('#loopFrom').value = t.bar; $('#loopTo').value = t.bar; setLoop(true); startWait(); };
        li.append(b); ul.append(li);
      });
      body.append(ul);
    } else p('No wrong notes. Well played!');
    const recent = (history()[song.id] || []).slice(-5).reverse();
    if (recent.length > 1) {
      p('Recent sessions:');
      const ul = document.createElement('ul'); ul.className = 'recent';
      recent.forEach(s => { const li = document.createElement('li'); li.textContent = PR.relativeDay(s.date) + ' · ' + (s.accuracy == null ? '—' : s.accuracy + '%') + (s.hand && s.hand !== 'both' ? ' · ' + s.hand + ' hand' : '') + (s.loop ? ' · ' + s.loop : '') + (s.complete ? '' : ' · unfinished'); ul.append(li); });
      body.append(ul);
    }
    $('#summaryDlg').showModal();
  }
  $('#summaryAgain').onclick = () => { $('#summaryDlg').close(); if (mode === 'along') startAlong(); else startWait(); };
  $('#summaryDone').onclick = () => $('#summaryDlg').close();

  /* v6.3 Microphone: listen to an acoustic or digital piano (music/listen.js) ------ */
  function micStatus(t) { $('#micStatus').textContent = t; }
  function micHint() { if (mic) micStatus('🎤 Listening.' + (hand !== 'both' ? ' Use headphones so the app’s ' + (hand === 'right' ? 'left' : 'right') + ' hand doesn’t confuse the microphone.' : ' Play on your piano.')); }
  function micIgnore(midi, until) { if (mic) { mic.det.ignore(midi, until + 0.3); mic.det.ignore(midi + 12, until + 0.3); } }
  function updateMicExpected() {
    if (!mic) return;
    if (mode === 'wait' && waitEvs[waitIdx]) mic.det.setExpected(waitEvs[waitIdx].midis);
    else if (mode === 'along' && along && playing) mic.det.setExpected(alongUpcoming());
    else mic.det.setExpected(null);
  }
  async function startMic() {
    if (!window.PCListen) { micStatus('Microphone listening is unavailable (music/listen.js did not load).'); return; }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { micStatus('This browser cannot use the microphone here.'); return; }
    try { await audio(); } catch (e) { micStatus('Audio is unavailable, so the microphone cannot be used.'); return; }
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } }); }
    catch (e) {
      micStatus(e && e.name === 'NotAllowedError' ? 'Microphone access was not allowed. Allow it for this site in your browser settings (iPhone: Settings › Apps › Safari › Microphone), then try again.' : 'Could not start the microphone (' + ((e && (e.message || e.name)) || 'unknown error') + ').');
      return;
    }
    const ctx = Tone.context.rawContext, src = ctx.createMediaStreamSource(stream), an = ctx.createAnalyser();
    an.fftSize = 8192; an.smoothingTimeConstant = 0; src.connect(an);
    mic = { stream, ctx, src, an, det: window.PCListen.create({ sampleRate: ctx.sampleRate, fftSize: an.fftSize }), buf: new Float32Array(an.fftSize), timer: 0, offTimers: [] };
    $('#micBtn').classList.add('primary'); $('#micBtn').setAttribute('aria-pressed', 'true'); $('#micMeter').hidden = false;
    micStatus('Calibrating: stay quiet for a moment…');
    const snaps = [];
    for (let i = 0; i < 6 && mic; i++) { await new Promise(r => setTimeout(r, 180)); if (!mic) return; an.getFloatTimeDomainData(mic.buf); snaps.push(mic.buf.slice()); }
    if (!mic) return;
    const all = new Float32Array(snaps.length * mic.buf.length); snaps.forEach((x, i) => all.set(x, i * mic.buf.length));
    mic.det.calibrate(all);
    micHint();
    updateMicExpected();
    mic.timer = setInterval(pollMic, 30);
  }
  function stopMic() {
    if (!mic) return;
    clearInterval(mic.timer); mic.offTimers.forEach(clearTimeout);
    try { mic.src.disconnect(); } catch (e) { /* ignore */ }
    mic.stream.getTracks().forEach(t => t.stop());
    mic = null;
    $('#micBtn').classList.remove('primary'); $('#micBtn').setAttribute('aria-pressed', 'false'); $('#micMeter').hidden = true;
    micStatus('');
  }
  function pollMic() {
    if (!mic) return;
    mic.an.getFloatTimeDomainData(mic.buf);
    const t = mic.ctx.currentTime;
    if (mode === 'along' && along && playing) mic.det.setExpected(alongUpcoming());
    let e2 = 0; for (let i = mic.buf.length - 1024; i < mic.buf.length; i++) e2 += mic.buf[i] * mic.buf[i];
    const db = 10 * Math.log10(e2 / 1024 + 1e-12);
    $('#micMeter i').style.width = Math.max(0, Math.min(100, (db - mic.det.noiseDb) * 2.5)) + '%';
    mic.det.process(mic.buf, t).forEach(ev => {
      const ms = ev.type === 'notes' ? ev.midis : [ev.midi];
      ms.forEach(m => { noteOn(m, 0.7, { silent: true, ctxTime: ev.time }); mic.offTimers.push(setTimeout(() => noteOff(m), 180)); });
      if (mic.offTimers.length > 64) mic.offTimers.splice(0, 32);
      micStatus('🎤 Heard ' + ms.map(noteName).join(' + ') + (ev.type === 'wrong' ? ' (not the note expected)' : ''));
    });
  }
  $('#micBtn').onclick = () => { if (mic) stopMic(); else startMic(); };

  /* v6.3 Play along: timing feedback ---------------------------------------------- */
  const tolPref = () => localStorage.getItem('pc-tolerance') || (mic ? 'relaxed' : 'normal');
  $('#tolSel').value = localStorage.getItem('pc-tolerance') || 'normal';
  $('#tolSel').onchange = e => { localStorage.setItem('pc-tolerance', e.target.value); if (mode === 'along' && playing) { endAlongSession(); startAlong(); } };
  async function startAlong() {
    if (!song) return;
    const range = activeRange();
    if (range.error) { toolStatus(range.error); return; }
    try { await audio(); } catch (e) { $('#measure').textContent = 'Audio unavailable'; return; }
    stop(false);
    targetBpm = +$('#tempo').value;
    const spb = 60 / targetBpm;
    Tone.Transport.bpm.value = targetBpm;
    const expectedNotes = song.notes.filter(n => PR.inHand(n, hand) && n.startBeat >= range.startBeat - 1e-6 && n.startBeat < range.endBeat - 1e-6)
      .map(n => ({ beat: n.startBeat, midi: n.midi, hand: n.hand }));
    if (!expectedNotes.length) { toolStatus('No notes for the ' + (hand === 'both' ? '' : hand + ' hand ') + 'in ' + (range.label || 'this piece') + '.'); return; }
    along = { range, spb, expected: expectedNotes, judge: PR.timingJudge(expectedNotes, { spb, tolerance: tolPref() }), pass: 0, passes: [], barStats: {}, t0: 0, last: null, started: Date.now(), logged: false };
    judged.clear();
    // The app plays the other hand (if any) and lights your keys as a guide.
    const events = song.notes.map(n => Object.assign({}, n, { mine: PR.inHand(n, hand), time: beatsToTicks(n.startBeat) }));
    part = new Tone.Part((time, n) => {
      const dur = beatsToTicks(n.durationBeats);
      if (!n.mine) { instrument().triggerAttackRelease(Tone.Frequency(n.midi, 'midi').toNote(), dur, time, (n.velocity || 0.7) * 0.85); micIgnore(n.midi, time + Tone.Time(dur).toSeconds()); }
      Tone.Draw.schedule(() => light(n.midi, 1, true), time);
      Tone.Draw.schedule(() => light(n.midi, 0, true), time + Tone.Time(dur).toSeconds());
    }, events).start(0);
    if (tools.metronome) metroPart = new Tone.Part((time, c) => click(time, c.accent), PR.clicks(segs, song.timeSignature, 0, songEnd(song)).map(c => ({ time: beatsToTicks(c.beat), accent: c.accent }))).start(0);
    if (loopOn) {
      Tone.Transport.loop = true; Tone.Transport.loopStart = beatsToTicks(range.startBeat); Tone.Transport.loopEnd = beatsToTicks(range.endBeat);
    } else {
      Tone.Transport.loop = false;
      Tone.Transport.scheduleOnce(t => Tone.Draw.schedule(() => finishAlong(), t), beatsToTicks(range.endBeat + Math.max(1, along.judge.windowMs / 1000 / spb + 0.5)));
    }
    // Always count in, so the first note can be on time.
    const ci = PR.countIn(song.timeSignature);
    let at = Tone.now() + 0.08;
    ci.clicks.forEach(c => click(at + c.beat * spb, c.accent));
    at += ci.beats * spb;
    along.t0 = at;
    toolStatus('Play along' + (hand !== 'both' ? ' · ' + hand + ' hand (the app plays the other)' : '') + (loopOn ? ' · looping ' + range.label : '') + (tools.trainer ? ' · speed trainer is paused in Play along' : '') + ' · count-in…');
    playing = true; lastBeat = range.startBeat; inLoop = false;
    Tone.Transport.start(at, beatsToTicks(range.startBeat));
    updateScore(); updateMicExpected();
    tick();
  }
  /** Where the music is, as heard (output latency included), in beats; and which loop pass. */
  function alongBeat(c) {
    const ctxRaw = Tone.context.rawContext, lat = ctxRaw.outputLatency || ctxRaw.baseLatency || 0;
    const r = along.range, el = (c - lat - along.t0) / along.spb;
    if (!loopOn) return { beat: r.startBeat + el, pass: 0 };
    const len = r.endBeat - r.startBeat;
    if (el < 0) return { beat: r.startBeat + el, pass: 0 };
    return { beat: r.startBeat + (el % len), pass: Math.floor(el / len) };
  }
  function alongUpcoming() {
    if (!along) return null;
    const { beat } = alongBeat(audioNow()), wb = along.judge.windowMs / 1000 / along.spb;
    const next = along.judge.notes.filter(n => !n.result && n.beat >= beat - wb && n.beat <= beat + wb);
    if (!next.length) return null;
    const first = Math.min(...next.map(n => n.beat));
    return next.filter(n => n.beat - first < 0.05).map(n => n.midi);
  }
  function rollPass() {
    along.judge.sweep(Infinity).forEach(n => judged.set(n.beat + ':' + n.midi, 'missed'));
    const sm = along.judge.summary();
    along.passes.push(sm);
    along.pass++;
    along.judge = PR.timingJudge(along.expected, { spb: along.spb, tolerance: tolPref() });
    judged.clear();
    toolStatus('Looping ' + along.range.label + ' · pass ' + along.pass + ': on time ' + sm.on + '/' + sm.total + (sm.early ? ' · early ' + sm.early : '') + (sm.late ? ' · late ' + sm.late : '') + (sm.missed ? ' · missed ' + sm.missed : '') + (sm.wrong ? ' · wrong ' + sm.wrong : '') + '.');
  }
  function alongPress(m, c) {
    if (!along || !playing) return;
    let { beat, pass } = alongBeat(c);
    const r = along.range, wb = along.judge.windowMs / 1000 / along.spb;
    if (beat < r.startBeat - wb) return;                 // still counting in
    // A slightly early first note of the next loop pass arrives just before the wrap.
    if (loopOn && pass === along.pass && r.endBeat - beat < wb && along.expected.some(n => n.midi === m && n.beat - r.startBeat < wb) && !along.judge.notes.some(n => !n.result && n.midi === m && Math.abs(n.beat - beat) < wb)) { pass++; beat -= r.endBeat - r.startBeat; }
    while (pass > along.pass) rollPass();
    const res = along.judge.press(m, beat);
    const bar = barOf(res.note ? res.note.beat : beat), st = along.barStats[bar] || (along.barStats[bar] = { wrong: 0, hits: 0 });
    if (res.result === 'on') st.hits++; else st.wrong++;
    if (res.note) judged.set(res.note.beat + ':' + res.note.midi, res.result);
    flash(m, res.result === 'on' ? 'right' : res.result === 'wrong' ? 'wrong' : 'off');
    along.last = res;
    updateScore();
  }
  function alongTick() {
    const c = audioNow(), { beat, pass } = alongBeat(c);
    while (pass > along.pass) rollPass();
    along.judge.sweep(beat).forEach(n => { judged.set(n.beat + ':' + n.midi, 'missed'); const st = along.barStats[barOf(n.beat)] || (along.barStats[barOf(n.beat)] = { wrong: 0, hits: 0 }); st.wrong++; });
    position(Math.max(along.range.startBeat, beat));
    if (!along.lastScore || c - along.lastScore > 0.25) { along.lastScore = c; updateScore(); }
  }
  function alongScoreText() {
    if (!along) return '';
    const s = along.judge.summary(), l = along.last;
    const lastTxt = !l ? '' : l.result === 'on' ? 'On time ✓ · ' : l.result === 'wrong' ? 'Wrong note ' + noteName(l.midi) + ' · ' : (l.result === 'early' ? 'Early ' : 'Late ') + Math.abs(l.ms) + ' ms · ';
    return lastTxt + 'On time ' + s.on + ' · early ' + s.early + ' · late ' + s.late + ' · missed ' + s.missed + ' · wrong ' + s.wrong;
  }
  function alongRecord(complete) {
    const all = along.passes.concat([along.judge.summary()]);
    const t = all.reduce((a, x) => { ['on', 'early', 'late', 'missed', 'wrong', 'total', 'played'].forEach(k => { a[k] = (a[k] || 0) + (x[k] || 0); }); return a; }, {});
    const ms = all.filter(x => x.meanMs != null);
    return {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), date: Date.now(), mode: 'along', hand,
      loop: loopOn && along.range.label ? along.range.label : null, passes: along.passes.length, complete,
      hits: t.played, wrong: t.total - t.on + t.wrong, accuracy: t.total + t.wrong ? Math.round(t.played / (t.total + t.wrong) * 100) : null,
      timing: t.played ? Math.round(t.on / t.played * 100) : null, meanMs: ms.length ? Math.round(ms.reduce((a, x) => a + x.meanMs, 0) / ms.length) : null,
      counts: t, seconds: Math.round((Date.now() - along.started) / 1000), tricky: PR.trickiest(along.barStats).map(x => x.bar)
    };
  }
  /** Leaving a play-along run early: log it if enough was played. */
  function endAlongSession() {
    if (!along || along.logged || !song) { along = null; return; }
    const sm = along.judge.summary();
    if (along.passes.length || sm.played + sm.wrong + sm.missed >= 5) recordSession(alongRecord(false));
    along.logged = true; along = null; judged.clear();
  }
  function finishAlong() {
    if (!along || mode !== 'along') return;
    along.judge.sweep(Infinity).forEach(n => judged.set(n.beat + ':' + n.midi, 'missed'));
    const rec = alongRecord(true), c = rec.counts;
    recordSession(rec); along.logged = true;
    const tricky = PR.trickiest(along.barStats);
    stop();
    const body = $('#summaryBody'); body.replaceChildren();
    const p = (t, cls) => { const e = document.createElement('p'); e.textContent = t; if (cls) e.className = cls; body.append(e); return e; };
    p('On time: ' + c.on + ' of ' + c.total + ' notes' + (rec.timing != null ? ' (' + rec.timing + '% of the notes you played)' : '') + '.');
    p('Early ' + c.early + ' · late ' + c.late + ' · missed ' + c.missed + ' · wrong ' + c.wrong + (hand !== 'both' ? ' · ' + hand + ' hand' : '') + ' · ' + targetBpm + ' BPM.');
    if (rec.meanMs != null) p(rec.meanMs < -30 ? 'You tend to rush: on average ' + (-rec.meanMs) + ' ms early. Try listening to the click and waiting for it.' : rec.meanMs > 30 ? 'You tend to drag: on average ' + rec.meanMs + ' ms late. Try a slower tempo until the notes come easily.' : 'Your timing is well centred on the beat.', 'muted');
    if (tricky.length) {
      p('Trickiest bars:');
      const ul = document.createElement('ul'); ul.className = 'tricky';
      tricky.forEach(t => {
        const li = document.createElement('li'), b = document.createElement('button');
        li.textContent = 'Bar ' + t.bar + ' · ' + t.wrong + ' note' + (t.wrong === 1 ? '' : 's') + ' off ';
        b.textContent = 'Loop this bar';
        b.onclick = () => { $('#summaryDlg').close(); $('#loopFrom').value = t.bar; $('#loopTo').value = t.bar; setLoop(true); startAlong(); };
        li.append(b); ul.append(li);
      });
      body.append(ul);
    } else if (c.on === c.total) p('Every note on time. Well played!');
    along = null;
    $('#summaryDlg').showModal();
  }

  /* v6.3 Recording: what you play (MIDI notes, plus microphone audio) --------------- */
  function recBeat() {
    if (!song) return null;
    if (mode === 'along' && along && playing) return alongBeat(audioNow()).beat;
    if (playing && window.Tone && Tone.Transport.state === 'started') return Tone.Transport.ticks / Tone.Transport.PPQ;
    if (mode === 'wait' && waitEvs[waitIdx]) return waitEvs[waitIdx].beat;
    return null;
  }
  function recordNote(m, vel, on) {
    if (!recording) return;
    recording.events.push({ t: Math.round(performance.now() - recording.start), midi: m, vel: on ? (vel || 0.75) : 0, on, beat: on ? recBeat() : null });
  }
  function startRecording() {
    if (!song) return;
    endTakePlay();
    recording = { start: performance.now(), events: [], timeline: [], chunks: [], mediaRec: null, mime: '', mode, timer: 0 };
    if (mic && window.MediaRecorder) {
      try {
        const mr = new MediaRecorder(mic.stream);
        mr.ondataavailable = e => { if (e.data && e.data.size && recording) recording.chunks.push(e.data); };
        mr.start(1000); recording.mediaRec = mr; recording.mime = mr.mimeType || '';
      } catch (e) { /* MIDI-only take */ }
    }
    recording.timer = setInterval(() => { if (!recording) return; const b = recBeat(); if (b != null) recording.timeline.push([Math.round(performance.now() - recording.start) / 1000, b]); }, 100);
    $('#recBtn').textContent = '■ Stop recording'; $('#recBtn').classList.add('rec');
    toolStatus('Recording' + (recording.mediaRec ? ' notes and sound' : ' notes') + '… press Stop recording when done.');
  }
  async function stopRecording() {
    const r = recording; if (!r) return;
    const end = Math.round(performance.now() - r.start);
    clearInterval(r.timer);
    held.forEach((c, m) => r.events.push({ t: end, midi: m, vel: 0, on: false, beat: null }));
    let blob = null;
    if (r.mediaRec) {
      await new Promise(res => { r.mediaRec.onstop = res; try { r.mediaRec.stop(); } catch (e) { res(); } });
      if (r.chunks.length) blob = new Blob(r.chunks, { type: r.mime || r.chunks[0].type || 'audio/mp4' });
    }
    recording = null;
    $('#recBtn').textContent = '● Record'; $('#recBtn').classList.remove('rec');
    const notes = r.events.filter(e => e.on).length;
    if (!notes && !blob) { toolStatus('Nothing was recorded.'); return; }
    const take = { id: 'take-' + Date.now().toString(36), songId: song.id, songTitle: song.title, date: Date.now(), duration: end / 1000, events: r.events, timeline: r.timeline, audio: blob, mime: blob ? blob.type : '', mode: r.mode };
    try {
      await put('takes', take);
      const mine = (await allTakes()).filter(t => t.songId === song.id).sort((a, b) => b.date - a.date);
      for (const old of mine.slice(10)) await del('takes', old.id);
      toolStatus('Saved a take: ' + fmtSecs(take.duration) + ', ' + notes + ' note' + (notes === 1 ? '' : 's') + (blob ? ' and sound' : '') + '. Open Takes to listen.');
    } catch (e) { toolStatus('Could not save the take: ' + e.message + '.'); }
  }
  const fmtSecs = s => Math.floor(s / 60) + ':' + String(Math.round(s % 60)).padStart(2, '0');
  function allTakes() {
    if (!db || !db.objectStoreNames.contains('takes')) return Promise.resolve([]);
    return new Promise(ok => { try { const r = db.transaction('takes').objectStore('takes').getAll(); r.onsuccess = () => ok(r.result || []); r.onerror = () => ok([]); } catch (e) { ok([]); } });
  }
  $('#recBtn').onclick = () => { if (recording) stopRecording(); else startRecording(); };
  async function renderTakes() {
    const box = $('#takesList'); box.replaceChildren();
    const mine = (await allTakes()).filter(t => song && t.songId === song.id).sort((a, b) => b.date - a.date);
    if (!mine.length) { const p = document.createElement('p'); p.className = 'muted'; p.textContent = 'No takes yet. Press ● Record on the practice screen, play, then Stop recording.'; box.append(p); return; }
    mine.forEach(t => {
      const row = document.createElement('div'); row.className = 'take';
      const info = document.createElement('span'), n = t.events.filter(e => e.on).length;
      info.textContent = PR.relativeDay(t.date) + ' ' + new Date(t.date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ' · ' + fmtSecs(t.duration) + ' · ' + n + ' note' + (n === 1 ? '' : 's') + (t.audio ? ' · with sound' : '') + (t.mode && t.mode !== 'listen' ? ' · ' + (t.mode === 'along' ? 'play along' : 'wait mode') : '');
      const btn = (label, fn, cls) => { const b = document.createElement('button'); b.textContent = label; b.onclick = fn; if (cls) b.className = cls; row.append(b); return b; };
      row.append(info);
      btn('▶ Play', () => playTake(t), 'primary');
      if (n) btn('⬇ MIDI', () => download(PR.takeToMidi(t.events, t.songTitle), t.songTitle + ' take.mid', 'audio/midi'));
      if (t.audio) btn('⬇ Sound', () => { const a = document.createElement('a'); a.href = URL.createObjectURL(t.audio); a.download = (t.songTitle + ' take.' + (/mp4|aac|m4a/.test(t.mime) ? 'm4a' : /ogg/.test(t.mime) ? 'ogg' : 'webm')).replace(/[^\w\-. ]+/g, '').replace(/\s+/g, '-'); document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 3000); });
      btn('Delete', async () => { await del('takes', t.id); renderTakes(); }, 'danger');
      box.append(row);
    });
  }
  $('#takesBtn').onclick = async () => { await renderTakes(); $('#takesDlg').showModal(); };
  $('#takesDone').onclick = () => $('#takesDlg').close();
  async function playTake(t) {
    stop();
    try { await audio(); } catch (e) { toolStatus('Audio is unavailable.'); return; }
    $('#takesDlg').close();
    takePlay = { timers: [], audio: null, url: null, raf: 0 };
    const tp = takePlay, start = performance.now() + 120;
    let clock = () => (performance.now() - start) / 1000;
    if (t.audio) {
      tp.url = URL.createObjectURL(t.audio);
      tp.audio = new Audio(tp.url);
      tp.audio.onended = () => endTakePlay(true);
      try { await tp.audio.play(); } catch (e) { toolStatus('Could not play the sound (' + e.message + ').'); endTakePlay(); return; }
      clock = () => tp.audio.currentTime;
    }
    // Light the keys (and, for MIDI-only takes, play the notes) at their recorded times.
    const ons = t.events.filter(e => e.on), t0 = Tone.now() + 0.12, inst = instrument();
    ons.forEach(e => {
      const off = t.events.find(x => !x.on && x.midi === e.midi && x.t >= e.t), dur = Math.max(0.08, ((off ? off.t : e.t + 400) - e.t) / 1000);
      if (!t.audio) inst.triggerAttackRelease(Tone.Frequency(e.midi, 'midi').toNote(), dur, t0 + e.t / 1000, e.vel || 0.7);
      tp.timers.push(setTimeout(() => light(e.midi, 1), 120 + e.t), setTimeout(() => light(e.midi, 0), 120 + e.t + dur * 1000));
    });
    if (!t.audio) tp.timers.push(setTimeout(() => endTakePlay(true), 120 + t.duration * 1000 + 300));
    // Follow the score where the take knows the position.
    const tl = t.timeline && t.timeline.length ? t.timeline : ons.filter(e => e.beat != null).map(e => [e.t / 1000, e.beat]);
    const follow = () => {
      if (takePlay !== tp) return;
      const now = clock();
      let b = null; for (const [ts, bt] of tl) { if (ts <= now) b = bt; else break; }
      if (b != null) position(b);
      tp.raf = requestAnimationFrame(follow);
    };
    if (tl.length) follow();
    toolStatus('Playing your take from ' + PR.relativeDay(t.date).toLowerCase() + '… press Stop to end.');
  }
  function endTakePlay(finished) {
    const tp = takePlay; if (!tp) return;
    takePlay = null;
    tp.timers.forEach(clearTimeout); cancelAnimationFrame(tp.raf);
    if (tp.audio) { tp.audio.pause(); tp.audio.onended = null; }
    if (tp.url) URL.revokeObjectURL(tp.url);
    if (window.Tone) releaseAllSound();
    document.querySelectorAll('#piano .key.on').forEach(k => k.classList.remove('on'));
    toolStatus(finished ? 'Take finished.' : '');
  }

  /* Sheet music view (Verovio) with simple-view fallback -------------------- */
  let viewPref = localStorage.getItem('pc-view') || 'sheet';
  function setViewButton() { $('#viewToggle').textContent = viewPref === 'sheet' ? 'Simple view' : 'Sheet music'; }
  setViewButton();
  $('#viewToggle').onclick = () => { viewPref = viewPref === 'sheet' ? 'simple' : 'sheet'; localStorage.setItem('pc-view', viewPref); setViewButton(); showView(); };
  function useSimple(note) {
    sheetReady = false;
    $('#engraved').hidden = true; $('#score').hidden = false;
    $('#notationNote').textContent = note || '';
    if (song) position(0);
  }
  async function showView() {
    const gen = ++openGen;
    if (viewPref !== 'sheet' || !window.PCNotation) return useSimple(viewPref === 'sheet' ? 'Sheet music view is unavailable (music/notation.js did not load).' : '');
    const box = $('#engraved');
    sheetReady = false;
    box.hidden = false; $('#score').hidden = true;
    box.innerHTML = '<p class="loading">Loading sheet music…</p>';
    $('#notationNote').textContent = '';
    const tk = await window.PCNotation.load();
    if (gen !== openGen) return;
    if (!tk) return useSimple('Sheet music view unavailable: ' + window.PCNotation.error() + '. Showing the simple view; it needs an internet connection the first time.');
    let xml = song.musicxml || song._xml;
    if (!xml) { try { xml = song._xml = window.PCMusicXML.songToMusicXML(song); } catch (e) { return useSimple('Could not prepare sheet music for this piece.'); } }
    const r = window.PCNotation.render(box, xml);
    if (gen !== openGen) return;
    if (!r.ok) return useSimple('Could not draw this score (' + r.error + '). Showing the simple view.');
    sheetReady = true;
    if (r.measures !== segs.reduce((a, s) => Math.max(a, s.measure + 1), 0)) $('#notationNote').textContent = 'Note: the sheet music and playback have different measure counts, so highlighting may drift.';
    if (loopOn) activeRange();
    position(0);
  }
  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    if (!$('#practice').classList.contains('active')) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (sheetReady && Math.abs($('#engraved').clientWidth - window.PCNotation.width()) > 60) showView();
      else if (!sheetReady && song) position(0);
    }, 300);
  });

  /* Simple view (canvas) and note road ------------------------------------- */
  function ctx(id, bg) {
    const c = $(id), r = c.getBoundingClientRect(), d = window.devicePixelRatio || 1;
    c.width = r.width * d; c.height = r.height * d;
    const x = c.getContext('2d'); x.setTransform(d, 0, 0, d, 0, 0);
    x.fillStyle = bg; x.fillRect(0, 0, r.width, r.height);
    return [x, r.width, r.height];
  }
  const WHITE_STEP = [0, 0, 1, 1, 2, 3, 3, 4, 4, 5, 5, 6];
  const diatonic = midi => Math.floor(midi / 12 - 1) * 7 + WHITE_STEP[midi % 12];
  function draw(beat) {
    if ($('#score').hidden) return;
    const [x, w, h] = ctx('#score', '#fffdf8');
    const beats = beatsPerMeasure(), perSystem = beats * 4, systems = 2;
    const left = 64, right = w - 18, sh = h / systems, g = Math.max(7, Math.min(10, sh / 13));
    const base = Math.floor(beat / (perSystem * systems)) * perSystem * systems;
    for (let s = 0; s < systems; s++) {
      const yT = s * sh + g * 3, yB = yT + g * 8;
      x.strokeStyle = '#64748b'; x.lineWidth = 1;
      for (const top of [yT, yB]) for (let i = 0; i < 5; i++) { x.beginPath(); x.moveTo(left, top + i * g); x.lineTo(right, top + i * g); x.stroke(); }
      x.fillStyle = '#0f172a'; x.strokeStyle = '#0f172a';
      drawClef(x, 'treble', 14, yT, g); drawClef(x, 'bass', 16, yB, g);
      x.strokeStyle = '#64748b';
      for (let m = 0; m <= 4; m++) { const bx = left + m / 4 * (right - left); x.beginPath(); x.moveTo(bx, yT); x.lineTo(bx, yB + 4 * g); x.stroke(); }
      x.font = '11px system-ui'; x.fillStyle = '#64748b';
      x.fillText(String(Math.floor((base + s * perSystem) / beats) + 1), left + 2, yT - 4);
      if (!song) continue;
      const s0 = base + s * perSystem;
      for (const n of song.notes) {
        const r = n.startBeat - s0; if (r < 0 || r >= perSystem) continue;
        const px = left + 10 + r / perSystem * (right - left - 14), d = diatonic(n.midi);
        const py = n.hand === 'left' ? yB + 4 * g - (d - 18) * g / 2 : yT + 4 * g - (d - 30) * g / 2;
        const now = n.startBeat <= beat + 0.02 && n.startBeat + n.durationBeats > beat;
        x.fillStyle = now ? '#7c3aed' : (hand !== 'both' && !PR.inHand(n, hand) ? '#94a3b8' : '#111827');
        x.beginPath(); x.ellipse(px, py, g * 0.62, g * 0.45, -0.3, 0, 7);
        if (n.durationBeats >= 1.9) { x.strokeStyle = x.fillStyle; x.lineWidth = 1.6; x.stroke(); } else x.fill();
        if (bk.has(n.midi % 12)) { x.font = (g * 1.5) + 'px serif'; x.fillText('♯', px - g * 1.6, py + g * 0.5); }
      }
      if (beat >= s0 && beat < s0 + perSystem) {
        const cx = left + 10 + (beat - s0) / perSystem * (right - left - 14);
        x.fillStyle = 'rgba(56,189,248,.25)'; x.fillRect(cx - 3, yT - g, 6, g * 14);
      }
    }
  }
  /* v6.3 Falling notes: notes fall onto the keys they belong to */
  function setFalling(on) {
    fallingOn = on;
    localStorage.setItem('pc-falling', on ? '1' : '0');
    $('main.practice').classList.toggle('falling', on);
    $('#fallToggle').classList.toggle('primary', on); $('#fallToggle').setAttribute('aria-pressed', on ? 'true' : 'false');
    requestAnimationFrame(() => { if (song) position(lastPos); });
  }
  $('#fallToggle').onclick = () => setFalling(!fallingOn);
  $('.pwrap').addEventListener('scroll', () => { if (fallingOn && song) drawRoad(lastPos); }, { passive: true });
  const FALL_COLOURS = { on: '#22c55e', early: '#f59e0b', late: '#f59e0b', missed: '#7f1d1d' };
  function drawFalling(beat) {
    const [x, w, h] = ctx('#road', '#08121f');
    if (!song) return;
    const cv = $('#road').getBoundingClientRect(), keys = {};
    document.querySelectorAll('#piano .key').forEach(k => { const r = k.getBoundingClientRect(); keys[k.dataset.m] = [r.left - cv.left, r.width, k.classList.contains('black')]; });
    const span = Math.max(4, beatsPerMeasure() * 2), ppb = (h - 8) / span, base = h - 3;
    x.font = '11px system-ui';
    segs.forEach(sg => {
      const y = base - (sg.play - beat) * ppb;
      if (y < 0 || y > h) return;
      x.fillStyle = '#1b3350'; x.fillRect(0, y, w, 1);
      x.fillStyle = '#5b7a99'; x.fillText(sg.number, 4, y - 3);
    });
    for (const black of [false, true]) for (const n of song.notes) {
      const k = keys[n.midi];
      if (!k || k[2] !== black) continue;
      const yb = base - (n.startBeat - beat) * ppb, yt = yb - Math.max(5, n.durationBeats * ppb - 2);
      if (yb < 0 || yt > h) continue;
      const mine = hand === 'both' || PR.inHand(n, hand), res = judged.get(n.startBeat + ':' + n.midi);
      x.fillStyle = FALL_COLOURS[res] || (!mine ? '#334155' : n.hand === 'left' ? '#a78bfa' : '#38bdf8');
      const rx = k[0] + 1.5, rw = Math.max(3, k[1] - 3), rh = yb - yt;
      x.beginPath();
      if (x.roundRect) x.roundRect(rx, yt, rw, rh, 4); else x.rect(rx, yt, rw, rh);
      x.fill();
    }
    x.fillStyle = 'rgba(56,189,248,.75)'; x.fillRect(0, base - 1, w, 2);
  }
  function drawRoad(beat) {
    if (fallingOn) return drawFalling(beat);
    const [x, w, h] = ctx('#road', '#0b1a2d');
    if (song) for (const n of song.notes) {
      const r = n.startBeat - beat;
      if (r >= 0 && r < 8) {
        const mine = hand === 'both' || PR.inHand(n, hand);
        x.fillStyle = !mine ? '#334155' : n.hand === 'left' ? '#a78bfa' : '#38bdf8';
        x.fillRect(r / 8 * w, h - 10 - (n.midi - 21) / 87 * (h - 20), Math.max(7, n.durationBeats / 8 * w), 5);
      }
    }
  }
  function drawClef(x, type, cx, top, il) {
    x.save(); x.lineCap = 'round'; x.lineJoin = 'round';
    if (type === 'bass') {
      const y = top + il;
      x.lineWidth = il * 0.28;
      x.beginPath();
      x.arc(cx + il * 0.45, y + il * 0.15, il * 0.32, Math.PI, Math.PI * 1.9, false);
      x.moveTo(cx + il * 0.2, y);
      x.bezierCurveTo(cx + il * 0.3, y - il * 1.1, cx + il * 2.0, y - il * 0.9, cx + il * 1.9, y + il * 0.6);
      x.bezierCurveTo(cx + il * 1.8, y + il * 1.8, cx + il * 0.9, y + il * 2.6, cx + il * 0.1, y + il * 3.0);
      x.stroke();
      x.beginPath(); x.arc(cx + il * 2.45, y - il * 0.45, il * 0.17, 0, 7); x.arc(cx + il * 2.45, y + il * 0.45, il * 0.17, 0, 7); x.fill();
    } else {
      const g = top + il * 3;
      x.lineWidth = il * 0.2;
      x.beginPath();
      x.moveTo(cx + il * 1.05, g + il * 0.25);
      x.bezierCurveTo(cx + il * 0.2, g + il * 0.6, cx + il * 0.1, g - il * 0.9, cx + il * 1.0, g - il * 0.85);
      x.bezierCurveTo(cx + il * 2.0, g - il * 0.8, cx + il * 1.9, g + il * 1.0, cx + il * 0.9, g + il * 1.0);
      x.bezierCurveTo(cx - il * 0.3, g + il * 1.0, cx - il * 0.2, g - il * 1.2, cx + il * 0.9, g - il * 2.3);
      x.bezierCurveTo(cx + il * 1.6, g - il * 3.0, cx + il * 1.7, g - il * 4.3, cx + il * 1.1, g - il * 4.4);
      x.bezierCurveTo(cx + il * 0.6, g - il * 4.3, cx + il * 0.6, g - il * 3.0, cx + il * 0.9, g - il * 2.0);
      x.lineTo(cx + il * 1.3, g + il * 1.9);
      x.bezierCurveTo(cx + il * 1.35, g + il * 2.5, cx + il * 0.6, g + il * 2.6, cx + il * 0.5, g + il * 2.1);
      x.stroke();
      x.beginPath(); x.arc(cx + il * 0.65, g + il * 2.05, il * 0.22, 0, 7); x.fill();
    }
    x.restore();
  }
  window.PCDraw = { clef: drawClef };

  /* ------------------------------ Imports ------------------------------- */
  function missingOmr() {
    const need = { 'omr/engine.js': window.OMREngine, 'omr/geometry.js': window.OMRGeometry, 'omr/model.js': window.OMRModel, 'omr/workflow.js': window.PCOMR };
    return Object.keys(need).filter(k => !need[k]);
  }
  function openOmr(source) {
    const missing = missingOmr();
    if (missing.length) {
      libStatus('Scanning is unavailable because these files did not load: ' + missing.join(', ') + '. Upload the whole omr/ folder to the repository root.', true);
      $('#libStatus').scrollIntoView({ block: 'center' });
      return;
    }
    window.PCOMR.open(source);
  }
  $('#cam').onclick = () => openOmr('camera');
  $('#photos').onclick = () => openOmr('photos');
  $('#pdf').onclick = () => openOmr('pdf');
  $('#midi').onclick = () => $('#midiIn').click();
  $('#xml').onclick = () => {
    if (!window.PCMusicXML) { libStatus('MusicXML import is unavailable because music/musicxml.js did not load. Upload the whole music/ folder.', true); return; }
    $('#xmlIn').click();
  };
  async function saveAndOpen(s, label) {
    s.updatedAt = Date.now();
    try { await put('songs', s); libStatus('Imported “' + s.title + '”' + (label || '') + '.'); }
    catch (err) { libStatus('“' + s.title + '” opened but could not be saved: ' + err.message + '.', true); }
    openSong(s);
  }
  $('#midiIn').onchange = async e => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    let s;
    try {
      if (!window.Midi) throw new Error('MIDI reader unavailable (check your connection)');
      const m = new Midi(await f.arrayBuffer()), bpm = m.header.tempos[0] ? m.header.tempos[0].bpm : 120;
      s = { id: 'midi-' + Date.now().toString(36), title: m.name || f.name.replace(/\.midi?$/i, ''), bpm: Math.round(bpm), composer: 'Imported MIDI', source: 'MIDI', category: 'imported', timeSignature: [4, 4], notes: m.tracks.flatMap(t => t.notes.map(n => ({ midi: n.midi, startBeat: n.time * bpm / 60, durationBeats: n.duration * bpm / 60, velocity: n.velocity, hand: n.midi < 60 ? 'left' : 'right' }))) };
      if (!s.notes.length) throw new Error('the file contains no notes');
    } catch (err) { libStatus('MIDI import failed: ' + err.message, true); return; }
    saveAndOpen(s);
  };

  function choosePartDialog(sc) {
    return new Promise(resolve => {
      const dlg = $('#partDlg'), box = $('#partList'), def = window.PCMusicXML.choosePart(sc);
      box.replaceChildren();
      sc.parts.forEach(p => {
        const l = document.createElement('label'); l.className = 'opart';
        const r = document.createElement('input'); r.type = 'radio'; r.name = 'xmlPart'; r.value = p.id; r.checked = p.id === def; r.disabled = !p.noteCount;
        const t = document.createElement('span');
        t.textContent = (p.name || p.id) + ' · ' + (p.staves >= 2 ? p.staves + ' staves' : '1 staff') + ' · ' + p.noteCount + ' notes' + (p.id === def ? ' · suggested' : '');
        l.append(r, t); box.append(l);
      });
      const finish = v => { dlg.close(); resolve(v); };
      $('#partOk').onclick = () => { const r = box.querySelector('input:checked'); finish(r ? r.value : def); };
      $('#partCancel').onclick = () => finish(null);
      dlg.oncancel = () => resolve(null);
      dlg.showModal();
    });
  }
  async function importMusicXML(file) {
    libStatus('Reading “' + file.name + '”…');
    const MX = window.PCMusicXML;
    let text, sc;
    try {
      text = await MX.readFile(await file.arrayBuffer());
      sc = MX.parse(text);
      if (!sc.parts.some(p => p.noteCount)) throw new Error('no playable notes were found');
    } catch (err) { libStatus('MusicXML import failed: ' + err.message, true); return null; }
    const pid = sc.parts.length > 1 ? await choosePartDialog(sc) : sc.parts[0].id;
    if (!pid) { libStatus('Import cancelled.'); return null; }
    const s = MX.toSong(sc, pid);
    if (!s.notes.length) { libStatus('That part has no playable notes.', true); return null; }
    s.id = 'xml-' + Date.now().toString(36);
    if (!sc.title) s.title = file.name.replace(/\.(musicxml|xml|mxl)$/i, '').replace(/[_-]+/g, ' ');
    s.musicxml = sc.parts.length > 1 ? MX.extractPart(text, pid) : text;
    await saveAndOpen(s, sc.parts.length > 1 ? ' (' + (s.partName || 'selected part') + ')' : '');
    return s;
  }
  $('#xmlIn').onchange = e => { const f = e.target.files[0]; e.target.value = ''; if (f) importMusicXML(f); };

  /* ------------------------- Settings, backup, offline, install ---------- */
  $('#settings').onclick = () => $('#settingsDlg').showModal();
  $('#settingsDone').onclick = () => $('#settingsDlg').close();
  $('#range').onchange = e => piano(+e.target.value);

  // v6: back up and restore the library and practice history
  function backupStatus(t) { $('#backupStatus').textContent = t; }
  async function backupFile() {
    const songs = await allSongs(), h = history();
    const text = JSON.stringify(PR.makeBackup(songs, h));
    const name = 'piano-companion-backup-' + new Date().toISOString().slice(0, 10) + '.json';
    const sessions = Object.keys(h).reduce((a, k) => a + (h[k] || []).length, 0);
    const what = songs.length + ' piece' + (songs.length === 1 ? '' : 's') + ' and ' + sessions + ' practice session' + (sessions === 1 ? '' : 's');
    return { text, name, what };
  }
  function markBackedUp() { writeJSON(BKEY, Date.now()); renderNudge(); }
  $('#backupBtn').onclick = async () => {
    const b = await backupFile();
    download(b.text, b.name, 'application/json');
    markBackedUp();
    backupStatus('Backup saved: ' + b.what + '. Keep it in Files, iCloud Drive or OneDrive.');
  };
  /** Share sheet (AirDrop, Files, Mail…) where supported, otherwise a download. */
  async function sendLibrary(statusFn) {
    const b = await backupFile();
    const file = typeof File === 'function' ? new File([b.text], b.name, { type: 'application/json' }) : null;
    if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: 'Piano Companion library' });
        markBackedUp();
        statusFn('Sent ' + b.what + '. On the other device open Settings → Restore backup and choose the file.');
      } catch (e) {
        if (e && e.name === 'AbortError') statusFn('Not sent.');
        else { download(b.text, b.name, 'application/json'); markBackedUp(); statusFn('Sharing isn’t available here, so the backup was downloaded instead (' + b.what + ').'); }
      }
      return;
    }
    download(b.text, b.name, 'application/json');
    markBackedUp();
    statusFn('Backup downloaded (' + b.what + '). Copy it to the other device, then open Settings → Restore backup there.');
  }
  $('#shareBtn').onclick = () => sendLibrary(backupStatus);
  $('#restoreBtn').onclick = () => $('#restoreIn').click();
  $('#restoreIn').onchange = async e => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    let data;
    try { data = PR.readBackup(await f.text()); } catch (err) { backupStatus('Restore failed: ' + err.message + '.'); return; }
    // Merge: add new pieces, keep whichever copy of a piece was changed last.
    const plan = PR.mergeSongs(await allSongs(), data.songs);
    let restored = 0;
    try { for (const s of plan.write) { await put('songs', s); restored++; } }
    catch (err) { backupStatus('Restored ' + restored + ' of ' + plan.write.length + ' pieces, then stopped: ' + err.message + '.'); return; }
    writeJSON(HKEY, PR.mergeHistory(history(), data.history));
    const n = (k, w) => k + ' ' + w + (k === 1 ? '' : 's');
    const parts = [n(plan.added, 'new piece')];
    if (plan.updated) parts.push(n(plan.updated, 'newer version') + ' of pieces you had');
    if (plan.kept) parts.push(n(plan.kept, 'piece') + ' kept as on this device (changed more recently here)');
    if (plan.same) parts.push(plan.same + ' already up to date');
    backupStatus('Restored: ' + parts.join(', ') + '; practice history merged' + (data.skipped ? ' (' + n(data.skipped, 'damaged entry').replace('entrys', 'entries') + ' skipped)' : '') + '.');
    render();
  };

  const OFFLINE_URLS = [
    'https://cdnjs.cloudflare.com/ajax/libs/tone/14.8.49/Tone.js',
    'https://cdn.jsdelivr.net/npm/@tonejs/midi@2.0.28/build/Midi.js',
    'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.min.mjs',
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.mjs',
    window.PCNotation ? window.PCNotation.URL : null
  ].filter(Boolean).concat(SAMPLE_NOTES.map(n => SAMPLE_BASE + SAMPLE_URLS[n]));
  function offlineStatus(t) { $('#offlineStatus').textContent = t; }
  async function makeOffline() {
    if (!('serviceWorker' in navigator) || !navigator.serviceWorker.controller) {
      offlineStatus('Offline mode needs the published https site (e.g. GitHub Pages). Open it, reload once, then try again.');
      return;
    }
    $('#offlineBtn').disabled = true;
    let ok = 0, failed = 0;
    for (const u of OFFLINE_URLS) {
      try { await fetch(u, { mode: 'cors' }).catch(() => fetch(u, { mode: 'no-cors' })); ok++; } catch (e) { failed++; }
      offlineStatus('Downloading for offline use… ' + (ok + failed) + ' / ' + OFFLINE_URLS.length);
    }
    let persisted = false;
    try { persisted = navigator.storage && navigator.storage.persist ? await navigator.storage.persist() : false; } catch (e) { /* ignore */ }
    offlineStatus(failed ? ok + ' of ' + OFFLINE_URLS.length + ' files saved; ' + failed + ' could not be downloaded. Try again with a better connection.' : 'Ready for offline use: app, sheet music, scanning tools and grand piano sound are saved on this device.' + (persisted ? '' : ' The browser may clear them if storage runs low.'));
    $('#offlineBtn').disabled = false;
  }
  $('#offlineBtn').onclick = makeOffline;

  let installPrompt = null;
  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installPrompt = e; $('#installBtn').hidden = false; });
  $('#installBtn').onclick = async () => { if (!installPrompt) return; installPrompt.prompt(); try { await installPrompt.userChoice; } catch (e) { /* ignore */ } installPrompt = null; $('#installBtn').hidden = true; };
  (function installHint() {
    const standalone = window.matchMedia && window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
    const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    $('#installHint').textContent = standalone ? 'Running as an installed app.' : ios ? 'On iPad or iPhone: tap Share, then “Add to Home Screen”.' : 'In Chrome or Edge, use the install button below or the install icon in the address bar.';
  })();
  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(err => console.warn('Service worker not registered', err)); });
  }
  window.addEventListener('pagehide', () => { endWaitSession(); endAlongSession(); });

  window.PCApp = {
    nav, openSong, saveSong: s => { s.updatedAt = Date.now(); return put('songs', s); }, download, audio, instrument, importMusicXML,
    _render: render, _put: put, _position: position, _history: history,
    _state: () => ({ samplerState, soundPref, sheetReady, segs: segs.length, hand, loopOn, loopRange, pass, waitIdx, waitEvs: waitEvs.length, waitPasses, playing, mode, mic: !!mic, along: along ? { pass: along.pass, summary: along.judge.summary(), t0: along.t0, spb: along.spb } : null, recording: !!recording, fallingOn }),
    _alongBeat: c => along ? alongBeat(c) : null, _audioNow: audioNow
  };
  window.addEventListener('load', () => {
    const missing = missingOmr();
    if (missing.length) { libStatus('Missing files: ' + missing.join(', ') + '. Camera, Photos and PDF need the omr/ folder.', true); console.error('Piano Companion: missing', missing); }
  });
  piano(88);
  connectMidi();
  openDb().then(async d => {
    db = d;
    const copied = await migrateLegacy().catch(() => 0);
    if (copied) libStatus(copied + ' piece(s) brought across from an earlier version.');
    render();
  });
})();
