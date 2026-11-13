import { WHITE_KEYS, BLACK_KEYS, KEY_CONFIG_BY_CODE, SONG_MANIFEST_PATH, DEFAULT_WINDOW_BASE, COMPUTER_WINDOW_SPAN, GAME, IMPORT } from "./js/config.js";
import { clamp, isTypingTarget, midiToName, pitchClassName, formatDuration, storage, escapeHtml, prefersReducedMotion } from "./js/utils.js";
import { createSongService } from "./js/songService.js";
import { arrange } from "./js/arrangement.js";
import { baseAt } from "./js/handPlan.js";
import { createGame } from "./js/gameEngine.js";
import { createKeyboardView } from "./js/keyboardView.js";
import { createRenderer } from "./js/renderer.js";
import { createAudioEngine } from "./js/audioEngine.js";
import { createMidiInput } from "./js/midiInput.js";
import { createProfile, ACHIEVEMENTS } from "./js/profile.js";
import { renderAd } from "./js/ads.js";
import { audioStore } from "./js/audioStore.js";
import { createMusicPlayer } from "./js/musicPlayer.js";
import { audioToNotes, createLiveConverter, midiFileToNotes, downloadSongAsMidi, isYoutubeUrl } from "./js/converter.js";
import { tabCaptureSupport, startTabCapture, youtubeTitle } from "./js/tabCapture.js";

const $ = (id) => document.getElementById(id);
const SETTINGS_KEY = "pianogiri.settings.v1";
const COMPUTER_KEYS = [...WHITE_KEYS, ...BLACK_KEYS];
const TOUCH_ONLY = window.matchMedia("(hover: none) and (pointer: coarse)").matches;

const settings = {
  mode: "practice",
  difficulty: "easy",
  speed: 1,
  layout: "computer",
  backing: true,
  music: true,
  labelMode: TOUCH_ONLY ? "notes" : "keys",
  freeLayout: "computer",
  ...storage.get(SETTINGS_KEY, {}),
};
const saveSettings = () => storage.set(SETTINGS_KEY, settings);

const songService = createSongService({ manifestPath: SONG_MANIFEST_PATH });
const audio = createAudioEngine();
const profile = createProfile();
const renderer = createRenderer($("noteCanvas"));
const music = createMusicPlayer();
let musicSongId = null;
const keyboard = createKeyboardView({ keybed: $("keybed"), onPressStart: noteOn, onPressEnd: noteOff });
const midiInput = createMidiInput({
  onNoteOn: (midi, velocity) => noteOn(midi, "midi", velocity),
  onNoteOff: (midi) => noteOff(midi, "midi"),
  onSustain: (on) => {
    if (on !== audio.isSustainOn()) audio.toggleSustain();
    updateControls();
  },
  onDevicesChange: (names) => {
    midiDevices = names;
    updateControls();
    if (names.length) toast("MIDI keyboard connected", names.join(", "));
  },
});

const app = {
  view: "library",
  tab: "all",
  query: "",
  song: null, // null = free play
  arrangement: null,
  game: null,
  windowBase: DEFAULT_WINDOW_BASE,
  phase: "free", // free | setup | countdown | playing | paused | results
  lastFrame: performance.now(),
  pressCount: new Map(),
  lastMidiSource: null,
};
let midiDevices = [];
let countdownTimer = null;

/* ------------------------------------------------------------------ */
/* Input                                                                */
/* ------------------------------------------------------------------ */

function codeToMidi(code) {
  const key = KEY_CONFIG_BY_CODE.get(code);
  return key ? app.windowBase + key.semitone : null;
}

// `at` is the input's own timestamp so a busy frame doesn't make you late.
function noteOn(midi, source, velocity, at = performance.now()) {
  const count = app.pressCount.get(midi) || 0;
  app.pressCount.set(midi, count + 1);
  if (count > 0) return;

  if (!audio.isReady()) {
    audio.resume().then(() => {
      if (app.pressCount.get(midi)) audio.noteOn(midi, velocity);
    });
  } else {
    audio.noteOn(midi, velocity);
  }
  keyboard.setPressed(midi, true);

  if (app.game && app.phase === "playing") {
    const result = app.game.press(midi, Math.min(at, performance.now()), { lenientOctave: source === "midi" && settings.layout === "computer" });
    if (result === "hit") keyboard.flash(midi, "correct-flash");
  } else if (!app.song) {
    renderer.freeNoteOn(midi);
  }
}

function noteOff(midi, _source, at = performance.now()) {
  const count = app.pressCount.get(midi) || 0;
  if (count === 0) return;
  if (count > 1) {
    app.pressCount.set(midi, count - 1);
    return;
  }
  app.pressCount.delete(midi);
  audio.noteOff(midi);
  keyboard.setPressed(midi, false);
  if (app.game) app.game.release(midi, Math.min(at, performance.now()));
  if (!app.song) renderer.freeNoteOff(midi);
}

const heldCodes = new Map(); // keyboard code -> midi it started (survives octave shifts)

function releaseEverything() {
  for (const [code, midi] of heldCodes) {
    noteOff(midi);
    heldCodes.delete(code);
  }
  keyboard.releaseAllPointers();
  for (const midi of [...app.pressCount.keys()]) {
    app.pressCount.set(midi, 1);
    noteOff(midi);
  }
  audio.panic();
}

function onKeyDown(event) {
  if (isTypingTarget(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
  if ($("importDialog").open) return;

  if (app.view === "play") {
    if (event.code === "Space") {
      event.preventDefault();
      if (event.repeat) return;
      if (app.phase === "setup") startRun();
      else if (app.phase === "playing") pauseRun();
      else if (app.phase === "paused") resumeRun();
      else if (app.phase === "results") retryRun();
      return;
    }
    if (event.code === "Escape") {
      if (app.phase === "playing") pauseRun();
      else if (app.phase === "paused") resumeRun();
      else showLibrary();
      return;
    }
    if (event.code === "Enter" && app.phase === "results") {
      event.preventDefault();
      retryRun();
      return;
    }
  }

  if (event.repeat) {
    if (KEY_CONFIG_BY_CODE.has(event.code) || event.code === "Tab") event.preventDefault();
    return;
  }

  if (event.code === "KeyM" && app.view === "play") {
    toggleMusic();
    return;
  }
  if (event.code === "Tab" && app.view === "play") {
    event.preventDefault();
    audio.toggleSustain();
    updateControls();
    return;
  }
  if (app.view === "play" && canShiftOctave()) {
    if (event.code === "KeyZ") return shiftOctave(-12);
    if (event.code === "KeyX") return shiftOctave(12);
  }
  if (app.view === "play" && (event.code === "KeyC" || event.code === "KeyV")) {
    audio.changeVelocity(event.code === "KeyC" ? -4 : 4);
    updateControls();
    return;
  }

  const midi = codeToMidi(event.code);
  if (midi === null || app.view !== "play") return;
  event.preventDefault();
  heldCodes.set(event.code, midi);
  noteOn(midi, "keyboard", undefined, event.timeStamp);
}

function onKeyUp(event) {
  const midi = heldCodes.get(event.code);
  if (midi === undefined) return;
  heldCodes.delete(event.code);
  noteOff(midi, "keyboard", event.timeStamp);
}

function canShiftOctave() {
  return !app.song ? true : settings.layout === "full";
}

function shiftOctave(delta) {
  const lo = app.song ? app.arrangement.rangeLo : 24;
  const hi = app.song ? app.arrangement.rangeHi : 96;
  const next = clamp(app.windowBase + delta, lo, Math.max(lo, hi - COMPUTER_WINDOW_SPAN + 6));
  if (next === app.windowBase) return;
  app.windowBase = next;
  if (!app.song && settings.freeLayout === "computer") buildKeyboard(app.windowBase, app.windowBase + COMPUTER_WINDOW_SPAN);
  else refreshKeyLabels();
  updateControls();
}

/* ------------------------------------------------------------------ */
/* Keyboard + layout                                                    */
/* ------------------------------------------------------------------ */

// Key caps show the computer key that plays them; touch devices get note names instead.
function computerLabels() {
  const labels = new Map();
  if (TOUCH_ONLY) {
    const lo = app.song ? app.arrangement.rangeLo : app.windowBase;
    const hi = app.song ? app.arrangement.rangeHi : app.windowBase + COMPUTER_WINDOW_SPAN;
    for (let m = lo; m <= hi; m += 1) labels.set(m, pitchClassName(m));
    return labels;
  }
  for (const key of COMPUTER_KEYS) labels.set(app.windowBase + key.semitone, key.label);
  return labels;
}

let labelCacheKey = null;
let labelCacheValue = new Map();
function labelCache() {
  const key = `${app.windowBase}|${app.arrangement?.rangeLo}|${app.song ? 1 : 0}`;
  if (key !== labelCacheKey) {
    labelCacheKey = key;
    labelCacheValue = computerLabels();
  }
  return labelCacheValue;
}

function buildKeyboard(lo, hi) {
  const layout = keyboard.build(lo, hi, computerLabels());
  renderer.setLayout(layout);
  $("keybed").classList.toggle("wide", hi - lo > 30);
}

function refreshKeyLabels() {
  keyboard.setLabels(computerLabels());
  updateReach();
}

// With computer keys, keys outside the 18 you can reach are dimmed.
function updateReach() {
  const following = app.song && settings.layout === "computer" && !TOUCH_ONLY;
  keyboard.setReach(following ? app.windowBase : null, following ? app.windowBase + COMPUTER_WINDOW_SPAN : null);
}

// The computer keys follow the music (see js/handPlan.js).
function followHand(songTime) {
  if (!app.arrangement || settings.layout !== "computer") return;
  const base = baseAt(app.arrangement.hand, songTime);
  if (base === app.windowBase) return;
  app.windowBase = base;
  refreshKeyLabels();
  updateControls();
}

/* ------------------------------------------------------------------ */
/* Views                                                                */
/* ------------------------------------------------------------------ */

function setView(view) {
  app.view = view;
  $("libraryView").hidden = view !== "library";
  $("playView").hidden = view !== "play";
  document.body.classList.toggle("is-playing", view === "play");
  document.querySelectorAll(".nav-btn").forEach((b) => {
    const active = (b.dataset.nav === "library" && view === "library") || (b.dataset.nav === "free" && view === "play" && !app.song);
    b.classList.toggle("active", active);
  });
  if (view === "play") {
    document.activeElement?.blur?.();
    requestAnimationFrame(() => renderer.resize());
  }
  $("pauseButton").hidden = !app.song;
  document.querySelector(".song-progress").hidden = !app.song;
  window.scrollTo({ top: 0 });
}

function showLibrary() {
  stopRun();
  releaseEverything();
  app.song = null;
  unloadMusic();
  setView("library");
  renderLibrary();
  renderProfile();
}

function showOverlay(id) {
  for (const o of ["setupOverlay", "countdownOverlay", "pauseOverlay", "resultsOverlay"]) $(o).hidden = o !== id;
}

function openFreePlay() {
  stopRun();
  app.song = null;
  unloadMusic();
  app.arrangement = null;
  app.phase = "free";
  app.windowBase = DEFAULT_WINDOW_BASE;
  showOverlay(null);
  $("hudMode").textContent = "Free play";
  $("hudSong").textContent = "Play anything";
  $("hudStats").hidden = true;
  $("songProgress").style.width = "0%";
  setView("play");
  buildFreeKeyboard();
  renderer.reset();
  updateControls();
  audio.resume();
}

function buildFreeKeyboard() {
  if (settings.freeLayout === "full") buildKeyboard(36, 95);
  else buildKeyboard(app.windowBase, app.windowBase + COMPUTER_WINDOW_SPAN);
}

function openSong(songId) {
  const song = songService.getById(songId);
  if (!song) return;
  stopRun();
  app.song = song;
  setView("play");
  showSetup();
  loadMusicFor(song);
}

/* ------------------------------------------------------------------ */
/* Original song audio                                                  */
/* ------------------------------------------------------------------ */

async function loadMusicFor(song) {
  if (musicSongId === song.id) return;
  unloadMusic();
  if (!song.hasAudio) return;
  musicSongId = song.id;
  const blob = await audioStore.get(song.id);
  if (musicSongId !== song.id) return; // user moved on while loading
  const ok = blob ? await music.load(blob, song.audioOffset) : false;
  if (!ok && musicSongId === song.id) {
    songService.markNoAudio(song.id);
    musicSongId = null;
  }
  if (app.phase === "setup") syncSetupControls();
  updateControls();
}

// Re-runs note finding on a lesson's stored audio (lessons made before melody tracking).
async function reanalyzeSong() {
  const song = app.song;
  if (!song?.hasAudio) return;
  const button = $("reanalyzeButton");
  button.disabled = true;
  try {
    const blob = await audioStore.get(song.id);
    if (!blob) throw new Error("The original audio for this lesson is gone.");
    const result = await audioToNotes(blob, {
      detail: "medium",
      onStage: (stage) => {
        button.textContent = { decode: "Reading audio…", model: "Loading AI model…", notes: "Building notes…" }[stage] || button.textContent;
      },
      onProgress: (p) => {
        button.textContent = `Listening… ${Math.round(p * 100)}%`;
      },
    });
    const updated = songService.replaceUserSongNotes(song.id, { notes: result.notes, audioOffset: result.shift, analysis: IMPORT.analysisVersion });
    if (app.song?.id !== song.id) return;
    app.song = updated;
    unloadMusic();
    loadMusicFor(updated);
    showSetup();
    renderLibrary();
    toast("Melody found", `${updated.notes.filter((n) => n.m).length} melody notes in “${updated.title}”. Easy mode now plays the tune.`);
  } catch (error) {
    toast("Couldn't redo this lesson", error.message);
  } finally {
    button.disabled = false;
    button.textContent = "Find the melody again";
  }
}

function unloadMusic() {
  music.unload();
  musicSongId = null;
}

function songHasMusic() {
  return Boolean(app.song?.hasAudio && music.loaded && musicSongId === app.song.id);
}

function musicOn() {
  return songHasMusic() && settings.music;
}

function toggleMusic() {
  settings.music = !settings.music;
  saveSettings();
  if (app.phase === "setup") syncSetupControls();
  updateControls();
  if (songHasMusic()) toast(settings.music ? "Song music on" : "Song music muted", "The notes stay in sync either way.");
}

/* ------------------------------------------------------------------ */
/* Run lifecycle                                                        */
/* ------------------------------------------------------------------ */

function prepareArrangement() {
  app.arrangement = arrange(app.song.notes, { difficulty: settings.difficulty, layout: settings.layout, sung: isSung(app.song) });
  app.windowBase = app.arrangement.windowBase;
  buildKeyboard(app.arrangement.rangeLo, app.arrangement.rangeHi);
  updateReach();
  app.game = createGame({ arrangement: app.arrangement, mode: settings.mode, speed: settings.speed, backingOn: false, callbacks: {} });
  renderer.reset();
}

function showSetup() {
  stopRun();
  app.phase = "setup";
  const song = app.song;
  $("hudMode").textContent = "Get ready";
  $("hudSong").textContent = song.title;
  $("hudStats").hidden = false;
  $("setupTitle").textContent = song.title;
  $("setupArtist").textContent = song.artist || (song.source === "user" ? "My song" : "Featured");
  syncSetupControls();
  prepareArrangement();
  showOverlay("setupOverlay");
  updateHud(true);
  updateControls();
  setTimeout(() => $("startButton").focus({ preventScroll: true }), 50);
}

function syncSetupControls() {
  const song = app.song;
  const best = profile.bestFor(song.id);
  $("setupMeta").innerHTML = `${escapeHtml(song.difficulty)} · ${formatDuration(song.duration)} · ${song.notes.length} notes${
    best.score ? ` · Best ${best.score.toLocaleString()} ${starString(best.stars)}` : ""
  }`;
  document.querySelectorAll(".seg").forEach((seg) => {
    const value = settings[seg.dataset.setting];
    seg.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.value === value)));
  });
  $("speedInput").value = String(settings.speed);
  $("speedOut").textContent = `${Math.round(settings.speed * 100)}%`;
  $("backingToggle").checked = settings.backing;
  $("musicToggleRow").hidden = !song.hasAudio;
  $("reanalyzeRow").hidden = !(song.source === "user" && song.hasAudio && song.analysis < IMPORT.analysisVersion);
  $("musicToggle").checked = settings.music;
  $("musicToggle").disabled = song.hasAudio && !songHasMusic();
  $("backingToggleRow").hidden = song.hasAudio && settings.music;
  $("labelSelect").value = settings.labelMode;

  const arrangementPreview = arrange(song.notes, { difficulty: settings.difficulty, layout: settings.layout, sung: isSung(song) });
  const holds = arrangementPreview.play.filter((n) => n.d >= GAME.holdThreshold).length;
  const notes = [];
  notes.push(`${arrangementPreview.play.length} notes to play${holds ? `, ${holds} to hold` : ""}.`);
  if (settings.layout === "computer") {
    const moves = arrangementPreview.hand.length - 1;
    if (moves) notes.push(`Your keys move ${moves === 1 ? "once" : `${moves} times`} to follow the tune; a marker drops down the lanes before each move.`);
  }
  if (settings.layout === "full" && !midiDevices.length) {
    notes.push("Full piano works best with a touch screen or MIDI keyboard. Z / X move your computer keys.");
  }
  if (settings.mode === "watch") notes.push("Watch mode plays the song for you — no score.");
  if (song.hasAudio && settings.music && settings.mode === "practice") notes.push("The music pauses while the song waits for you.");
  $("setupNote").textContent = notes.join(" ");
}

function startRun() {
  if (!app.song) return;
  audio.resume();
  releaseEverything();
  prepareArrangement();
  const callbacks = {
    onJudge: handleJudge,
    onWrong: handleWrong,
    onHoldEnd: (note, complete) => {
      keyboard.setHolding(note.hitMidi ?? note.midi, false);
      if (complete) renderer.holdComplete(note.midi);
    },
    onAutoNote: (note) => {
      if (!musicOn()) audio.playNote(note.midi, note.d / settings.speed, note.v ?? 85);
      keyboard.setPressed(note.midi, true);
      setTimeout(() => keyboard.setPressed(note.midi, Boolean(app.pressCount.get(note.midi))), Math.max(120, (note.d / settings.speed) * 1000));
      renderer.autoHit(note.midi);
    },
    onBackingNote: (note) => audio.playNote(note.midi, note.d / settings.speed, (note.v ?? 80) * 0.6),
    onFinish: finishRun,
  };
  app.game = createGame({
    arrangement: app.arrangement,
    mode: settings.mode,
    speed: settings.speed,
    backingOn: settings.backing && settings.mode !== "watch" && !musicOn(),
    callbacks,
  });
  $("hudMode").textContent = { practice: "Practice", perform: "Perform", watch: "Watch" }[settings.mode];
  updateHud(true);
  runCountdown(() => {
    app.phase = "playing";
    app.game.begin(performance.now());
  });
}

function runCountdown(done) {
  app.phase = "countdown";
  showOverlay("countdownOverlay");
  let n = 3;
  const el = $("countdownNumber");
  const tick = () => {
    if (n === 0) {
      showOverlay(null);
      done();
      return;
    }
    el.textContent = String(n);
    el.classList.remove("pop");
    void el.offsetWidth;
    el.classList.add("pop");
    n -= 1;
    countdownTimer = setTimeout(tick, prefersReducedMotion() ? 500 : 700);
  };
  tick();
}

function pauseRun() {
  if (app.phase !== "playing") return;
  app.game.pause();
  app.phase = "paused";
  releaseEverything();
  showOverlay("pauseOverlay");
  $("resumeButton").focus({ preventScroll: true });
}

function resumeRun() {
  if (app.phase !== "paused") return;
  runCountdown(() => {
    app.phase = "playing";
    app.game.resume(performance.now());
  });
}

function retryRun() {
  if (!app.song) return;
  startRun();
}

function stopRun() {
  clearTimeout(countdownTimer);
  if (app.game && app.phase === "playing" && app.song) {
    profile.addPracticeSeconds(app.game.getResults().playedSeconds);
    renderProfile();
  }
  app.game = null;
  app.phase = app.song ? "setup" : "free";
}

function handleJudge(note, judgment, info) {
  renderer.hit(note.midi, judgment);
  if (judgment === "miss") {
    keyboard.flash(note.midi, "miss-flash");
    $("comboStat").classList.remove("bump");
    return;
  }
  if (note.isHold) keyboard.setHolding(note.hitMidi ?? note.midi, true);
  const combo = info.combo;
  const el = $("comboStat");
  el.classList.remove("bump");
  void el.offsetWidth;
  el.classList.add("bump");
  if (combo > 0 && combo % 25 === 0) {
    renderer.holdComplete(note.midi);
    flashStage(`${combo} combo!`);
  }
}

function handleWrong(midi) {
  renderer.wrong(midi);
  keyboard.flash(midi, "wrong-flash");
}

function flashStage(text) {
  const el = document.createElement("div");
  el.className = "stage-callout";
  el.textContent = text;
  $("stage").appendChild(el);
  setTimeout(() => el.remove(), 1200);
}

function finishRun(results) {
  app.phase = "results";
  releaseEverything();
  const record = profile.recordRun({ songId: app.song.id, mode: settings.mode, difficulty: settings.difficulty, results });
  renderProfile();
  showResults(results, record);
}

/* ------------------------------------------------------------------ */
/* Results                                                              */
/* ------------------------------------------------------------------ */

function starString(stars) {
  return "★".repeat(stars) + "☆".repeat(3 - stars);
}

function showResults(results, record) {
  showOverlay("resultsOverlay");
  const watch = settings.mode === "watch";
  const stars = watch ? 0 : results.stars;

  $("resultStars").querySelectorAll("svg").forEach((svg, i) => {
    svg.classList.remove("earned");
    svg.style.animationDelay = `${0.25 + i * 0.25}s`;
    if (i < stars) requestAnimationFrame(() => svg.classList.add("earned"));
  });
  $("resultStars").hidden = watch;

  const headlines = watch
    ? ["Now it's your turn!"]
    : stars === 3
      ? ["Flawless!", "Virtuoso!", "Standing ovation!"]
      : stars === 2
        ? ["Great playing!", "So close to 3 stars!"]
        : stars === 1
          ? ["Nice start!", "Keep going!"]
          : ["Every pianist starts here.", "Keep at it!"];
  $("resultHeadline").textContent = headlines[Math.floor(Math.random() * headlines.length)];

  $("resultGrade").textContent = watch ? "–" : results.grade;
  $("resultGrade").dataset.grade = results.grade;
  countUp($("resultScore"), watch ? 0 : results.score);
  $("newBest").hidden = !record.isNewBest || watch;

  const rows = watch
    ? [["Notes", results.total]]
    : [
        ["Perfect", results.perfect, "perfect"],
        ["Great", results.great, "great"],
        ["Good", results.good, "good"],
        ["Miss", results.miss, "miss"],
        ["Wrong keys", results.wrong, "miss"],
        ["Max combo", results.maxCombo],
        ["Holds", `${results.holdsCompleted}/${results.holdsTotal}`],
        ["Accuracy", `${Math.round(results.accuracy * 100)}%`],
      ];
  $("resultGrid").innerHTML = rows
    .map(([label, value, cls]) => `<div class="${cls || ""}"><span>${label}</span><strong>${value}</strong></div>`)
    .join("");

  const summary = profile.summary();
  $("resultXp").textContent = `+${record.xpGained} XP`;
  $("resultLevel").textContent = record.leveledUp ? `Level up! ${summary.level}` : `Level ${summary.level}`;
  $("resultLevel").classList.toggle("level-up", record.leveledUp);
  $("resultXpFill").style.width = `${(summary.into / summary.needed) * 100}%`;

  $("resultBadges").innerHTML = record.unlocked.map((a) => `<span class="badge-pill">🏅 ${escapeHtml(a.title)}</span>`).join("");
  record.unlocked.forEach((a) => toast(`Badge unlocked: ${a.title}`, a.text));

  const next = suggestNext(results);
  $("resultTip").textContent = next.tip;
  $("nextButton").textContent = next.label;
  $("nextButton").onclick = next.action;

  if (stars === 3 && !prefersReducedMotion()) confetti();
  renderAd($("adResults"), "results");
  setTimeout(() => $("retryButton").focus({ preventScroll: true }), 50);
}

function suggestNext(results) {
  const goTo = (changes) => () => {
    Object.assign(settings, changes);
    saveSettings();
    showSetup();
  };
  if (settings.mode === "watch") return { tip: "You've heard it — now play it in Practice mode.", label: "Practice it", action: goTo({ mode: "practice" }) };
  if (results.stars < 2 && settings.speed > 0.6) return { tip: "Tip: slow the song down to lock in the notes, then speed back up.", label: "Try at 75% speed", action: goTo({ speed: Math.max(0.5, settings.speed - 0.25) }) };
  if (results.stars >= 2 && settings.mode === "practice") return { tip: "You know the notes. Can you keep the beat?", label: "Try Perform mode", action: goTo({ mode: "perform" }) };
  if (results.stars >= 2 && settings.difficulty !== "hard") {
    const harder = settings.difficulty === "easy" ? "medium" : "hard";
    return { tip: "Ready for more notes?", label: `Try ${harder[0].toUpperCase()}${harder.slice(1)}`, action: goTo({ difficulty: harder }) };
  }
  if (results.stars >= 2 && settings.speed < 1.5) return { tip: "Push the tempo for a bigger challenge.", label: "Speed up", action: goTo({ speed: Math.min(1.5, settings.speed + 0.25) }) };
  return { tip: "Pick another song and keep your streak going.", label: "Another song", action: showLibrary };
}

function countUp(el, target) {
  const start = performance.now();
  const duration = prefersReducedMotion() ? 1 : 900;
  const step = (now) => {
    const k = Math.min(1, (now - start) / duration);
    el.textContent = Math.round(target * (1 - Math.pow(1 - k, 3))).toLocaleString();
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function confetti() {
  const layer = document.createElement("div");
  layer.className = "confetti";
  const colors = ["#ffd166", "#fb6b3d", "#2fe0c5", "#9ad1ff", "#ff6b9a"];
  for (let i = 0; i < 70; i += 1) {
    const piece = document.createElement("i");
    piece.style.left = `${Math.random() * 100}%`;
    piece.style.background = colors[i % colors.length];
    piece.style.animationDelay = `${Math.random() * 0.6}s`;
    piece.style.setProperty("--drift", `${(Math.random() - 0.5) * 160}px`);
    layer.appendChild(piece);
  }
  $("stage").appendChild(layer);
  setTimeout(() => layer.remove(), 3200);
}

/* ------------------------------------------------------------------ */
/* HUD + controls                                                       */
/* ------------------------------------------------------------------ */

const hudCache = {};
function setText(id, value) {
  if (hudCache[id] !== value) {
    hudCache[id] = value;
    $(id).textContent = value;
  }
}

function updateHud(force = false) {
  if (force) for (const key of Object.keys(hudCache)) delete hudCache[key];
  const game = app.game;
  if (!game) return;
  const s = game.stats;
  setText("hudScore", s.score.toLocaleString());
  setText("hudCombo", String(s.combo));
  setText("hudMultiplier", `×${game.multiplier()}`);
  setText("hudAccuracy", `${Math.round(game.liveAccuracy() * 100)}%`);
  $("comboStat").dataset.multiplier = String(game.multiplier());
  $("songProgress").style.width = `${game.progress * 100}%`;
}

function updateControls() {
  $("octaveLabel").textContent = midiToName(app.windowBase);
  $("velocityLabel").textContent = String(audio.getVelocity());
  $("sustainButton").setAttribute("aria-pressed", String(audio.isSustainOn()));
  const octaveEnabled = canShiftOctave();
  $("octaveDown").disabled = !octaveEnabled;
  $("octaveUp").disabled = !octaveEnabled;
  $("freeLayoutButton").hidden = Boolean(app.song);
  $("freeLayoutButton").textContent = settings.freeLayout === "full" ? "Computer keys" : "Full piano";
  $("midiButton").textContent = midiDevices.length ? `MIDI: ${midiDevices[0]}` : "Connect MIDI keyboard";
  $("midiButton").classList.toggle("connected", midiDevices.length > 0);
  $("midiButton").hidden = !midiInput.supported;
  $("musicButton").hidden = !songHasMusic();
  $("musicButton").setAttribute("aria-pressed", String(settings.music));
}

/* ------------------------------------------------------------------ */
/* Library                                                              */
/* ------------------------------------------------------------------ */

function miniRoll(song) {
  const notes = song.notes.filter((n) => n.t < 24).slice(0, 90);
  if (!notes.length) return "";
  const lo = Math.min(...notes.map((n) => n.midi));
  const hi = Math.max(...notes.map((n) => n.midi));
  const span = Math.max(12, hi - lo + 1);
  const end = Math.max(...notes.map((n) => n.t + n.d), 4);
  const rects = notes
    .map((n) => {
      const x = (n.t / end) * 100;
      const w = Math.max(1.2, (n.d / end) * 100);
      const y = 92 - ((n.midi - lo) / span) * 84;
      return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="6" rx="2" />`;
    })
    .join("");
  return `<svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">${rects}</svg>`;
}

function renderLibrary() {
  const all = songService.getAll();
  const userCount = all.filter((s) => s.source === "user").length;
  $("myCount").textContent = String(userCount);

  const q = app.query.trim().toLowerCase();
  const songs = all.filter((s) => (app.tab === "all" || s.source === app.tab) && (!q || `${s.title} ${s.artist}`.toLowerCase().includes(q)));
  const grid = $("songGrid");

  if (app.tab === "user" && userCount === 0) {
    grid.innerHTML = `<div class="empty-card"><h3>No songs yet</h3><p>Upload audio, record yourself, or drop in a MIDI file — we'll turn it into a playable lesson.</p><button class="btn primary" type="button" data-action="import">Make my first lesson</button></div>`;
    return;
  }
  if (!songs.length) {
    grid.innerHTML = `<div class="empty-card"><h3>No songs match “${escapeHtml(app.query)}”</h3><p>Try another search, or make a lesson from your own audio.</p><button class="btn ghost" type="button" data-action="import">Import a song</button></div>`;
    return;
  }

  const importCard = `<button class="song-card import-card-tile" type="button" data-action="import">
      <span class="plus">+</span><strong>New lesson</strong><small>From audio, mic or MIDI</small>
    </button>`;

  grid.innerHTML =
    importCard +
    songs
      .map((song, i) => {
        const best = profile.bestFor(song.id);
        const hue = (i * 47 + song.title.length * 13) % 360;
        return `<article class="song-card" style="--hue:${hue}" data-id="${escapeHtml(song.id)}">
          <div class="card-art">${miniRoll(song)}<span class="diff diff-${escapeHtml(song.difficulty.toLowerCase())}">${escapeHtml(song.difficulty)}</span></div>
          <div class="card-body">
            <h3>${escapeHtml(song.title)}</h3>
            <p class="card-sub">${escapeHtml(song.artist || (song.source === "user" ? "My song" : "Featured"))}</p>
            <div class="card-meta"><span>${formatDuration(song.duration)}</span><span>${song.notes.length} notes</span>
              <span class="stars ${best.stars ? "" : "none"}" aria-label="${best.stars} of 3 stars">${starString(best.stars)}</span></div>
          </div>
          <div class="card-actions">
            <button class="btn primary small" type="button" data-action="play">Play</button>
            ${song.source === "user" ? `<button class="icon-btn small" type="button" data-action="download" title="Download MIDI" aria-label="Download MIDI"><svg viewBox="0 0 24 24"><path d="M12 4v11m0 0-4-4m4 4 4-4M5 20h14" /></svg></button><button class="icon-btn small" type="button" data-action="delete" title="Delete" aria-label="Delete song"><svg viewBox="0 0 24 24"><path d="M5 7h14M10 7V5h4v2m-7 0 1 12h8l1-12" /></svg></button>` : ""}
          </div>
        </article>`;
      })
      .join("");
}

function renderBadges() {
  const unlocked = new Set(profile.summary().achievements);
  $("badgeGrid").innerHTML = ACHIEVEMENTS.map(
    (a) => `<div class="badge ${unlocked.has(a.id) ? "unlocked" : ""}"><span class="medal">${unlocked.has(a.id) ? "🏅" : "🔒"}</span><strong>${escapeHtml(a.title)}</strong><small>${escapeHtml(a.text)}</small></div>`
  ).join("");
}

function renderProfile() {
  const s = profile.summary();
  $("streakCount").textContent = String(s.streak);
  $("levelBadge").textContent = String(s.level);
  $("xpFill").style.width = `${(s.into / s.needed) * 100}%`;
  const circumference = 2 * Math.PI * 15;
  $("dailyRing").style.strokeDasharray = `${circumference}`;
  $("dailyRing").style.strokeDashoffset = `${circumference * (1 - s.dailyProgress)}`;
  $("dailyLabel").textContent = s.dailyProgress >= 1 ? "Goal ✓" : `${s.dailyMinutes}/${GAME.dailyGoalMinutes}m`;
  document.querySelector(".chip.daily").classList.toggle("done", s.dailyProgress >= 1);
  document.querySelector(".chip.streak").classList.toggle("lit", s.streak > 0);
  $("statStars").textContent = String(s.totalStars);
  $("statLevel").textContent = String(s.level);
  $("statBadges").textContent = `${s.achievements.length}/${ACHIEVEMENTS.length}`;
  $("statStreak").textContent = String(s.streak);
  renderBadges();
}

/* ------------------------------------------------------------------ */
/* Toasts                                                               */
/* ------------------------------------------------------------------ */

function toast(title, text = "") {
  const el = document.createElement("div");
  el.className = "toast";
  el.innerHTML = `<strong>${escapeHtml(title)}</strong>${text ? `<span>${escapeHtml(text)}</span>` : ""}`;
  $("toastStack").appendChild(el);
  setTimeout(() => el.classList.add("out"), 3600);
  setTimeout(() => el.remove(), 4000);
}

/* ------------------------------------------------------------------ */
/* Import dialog                                                        */
/* ------------------------------------------------------------------ */

const importState = { tab: "audio", file: null, midiFile: null, recording: null, recordedBlob: null, busy: false, capture: null };
const TAB_SUPPORT = tabCaptureSupport();
const PAGE_TITLE = document.title;

function openImport() {
  importState.busy = false;
  $("importError").hidden = true;
  $("convertProgress").hidden = true;
  document.querySelector('[data-import-tab="youtube"] .soon').hidden = true;
  $("youtubeNotice").hidden = TAB_SUPPORT.ok;
  $("youtubeNotice").textContent = TAB_SUPPORT.reason || "";
  $("youtubeFlow").hidden = !TAB_SUPPORT.ok;
  if (!importState.capture) setYtStep(isYoutubeUrl($("youtubeInput").value) ? Math.max(2, yt.step) : 1);
  $("importDialog").showModal();
  updateImportButton();
}

function closeImport() {
  if (importState.recording) stopRecording();
  if (importState.capture) cancelTabCapture();
  $("importDialog").close();
}

function setImportTab(tab) {
  importState.tab = tab;
  document.querySelectorAll("[data-import-tab]").forEach((b) => {
    b.classList.toggle("active", b.dataset.importTab === tab);
    b.setAttribute("aria-selected", String(b.dataset.importTab === tab));
  });
  document.querySelectorAll("[data-import-panel]").forEach((p) => {
    p.hidden = p.dataset.importPanel !== tab;
  });
  $("detailRow").hidden = tab === "midi";
  updateImportButton();
}

function updateImportButton() {
  const ready =
    (importState.tab === "audio" && importState.file) ||
    (importState.tab === "midi" && importState.midiFile) ||
    (importState.tab === "record" && importState.recordedBlob && !importState.recording) ||
    false; // YouTube has its own step buttons
  $("importConvert").disabled = !ready || importState.busy;
  $("importConvert").hidden = importState.tab === "youtube";
}

/* YouTube guided steps ------------------------------------------------ */
// 1 paste link → 2 open the video → 3 record. Only the current step is open;
// finished steps collapse to a ✓ and can be clicked to go back.

const yt = { step: 1, opened: false, metaFor: null, meta: null };

function youtubeId(text) {
  const m = String(text).trim().match(/(?:youtu\.be\/|[?&]v=|\/shorts\/|\/live\/)([\w-]{11})/);
  return m ? m[1] : null;
}

function youtubeUrl() {
  const id = youtubeId($("youtubeInput").value);
  return id ? `https://www.youtube.com/watch?v=${id}` : null;
}

function setYtStep(step) {
  yt.step = step;
  document.querySelectorAll(".yt-step").forEach((li) => {
    const n = Number(li.dataset.ytStep);
    li.classList.toggle("active", n === step);
    li.classList.toggle("done", n < step);
    li.classList.toggle("todo", n > step);
  });
  $("ytSummary1").textContent = step > 1 ? yt.meta?.title || youtubeUrl() || "" : "";
  $("ytSummary2").textContent = step > 2 ? (yt.opened ? (yt.inWindow ? "Open in a small window" : "Open in a new tab") : "Already open") : "";
  $("youtubeOpen").textContent = yt.opened ? "Open it again" : "Open video";
  $("pmTitle").textContent = `${yt.meta?.title || "Your YouTube video"} – YouTube`;
  if (step === 1) setTimeout(() => $("youtubeInput").focus(), 30);
  if (step === 2) setTimeout(() => $("youtubeOpen").focus(), 30);
  if (step === 3) setTimeout(() => $("ytRecord").focus(), 30);
}

async function onYoutubeLinkChange() {
  const id = youtubeId($("youtubeInput").value);
  $("ytNext1").disabled = !id;
  $("ytPreview").hidden = !id;
  if (!id) return;
  if (yt.metaFor !== id) {
    yt.metaFor = id;
    yt.meta = null;
    yt.opened = false;
    $("ytThumb").src = `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;
    $("ytTitle").textContent = "Looking up the video…";
    $("ytChannel").textContent = "";
    const meta = await youtubeTitle(youtubeUrl());
    if (yt.metaFor !== id) return;
    yt.meta = meta;
    $("ytTitle").textContent = meta?.title || "YouTube video";
    $("ytChannel").textContent = meta?.artist || "";
  }
}

// Opens the video in a small window in the corner of the screen, so PianoGiri
// (and step 3) stays in view. Chrome lists that window's video under
// "Chrome tab" in the share dialog, with audio. Named, so "Open it again"
// reuses it. Falls back to a normal tab if the small window is blocked.
function openYoutubeVideo() {
  const url = youtubeUrl();
  if (!url) return;
  const w = Math.min(640, Math.round(screen.availWidth * 0.4));
  const h = Math.round(w * 0.75);
  const left = (screen.availLeft ?? 0) + screen.availWidth - w - 24;
  const top = (screen.availTop ?? 0) + screen.availHeight - h - 48;
  const win = window.open(url, "pianogiri-youtube", `popup,width=${w},height=${h},left=${left},top=${top}`);
  yt.opened = true;
  yt.inWindow = Boolean(win);
  if (!win) window.open(url, "_blank");
  setYtStep(3);
}

function showYoutubeRecorder(recording) {
  $("youtubeFlow").hidden = recording;
  $("tabRecorder").hidden = !recording;
}

/* YouTube via tab-audio capture ------------------------------------- */

// Runs from the Record click. Notes are found while the song plays, so the
// lesson is ready as soon as recording ends.
function startYoutubeCapture() {
  $("importError").hidden = true;
  const url = youtubeUrl();
  const capture = { cancelled: false, controller: null, session: null, meta: yt.meta ? Promise.resolve(yt.meta) : youtubeTitle(url) };
  importState.capture = capture;
  importState.busy = true;
  updateImportButton();

  let session;
  try {
    session = createLiveConverter({
      detail: $("detailSelect").value,
      onLiveSeconds: (seconds) => {
        if (seconds > 0) $("tabLiveStatus").textContent = `Notes found up to ${formatDuration(seconds)} — the lesson will be ready when the song ends.`;
      },
    });
  } catch (error) {
    return endCapture(capture, error);
  }
  capture.session = session;

  // startTabCapture creates its audio context synchronously, inside this click.
  startTabCapture({
    onPcm: (chunk) => session.append(chunk),
    onLevel: (level) => {
      $("tabLevel").style.width = `${Math.round(level * 100)}%`;
    },
    onTick: ({ recorded, silentFor, finishAt, waiting }) => {
      $("tabRecordTimer").textContent = formatDuration(recorded);
      document.title = waiting ? "● Waiting for music – PianoGiri" : `● ${formatDuration(recorded)} Recording – PianoGiri`;
      const quiet = !waiting && silentFor >= 3;
      $("keepWaitingButton").hidden = !quiet;
      $("tabRecordStatus").textContent = waiting
        ? "▶ Now press play on the YouTube tab."
        : quiet
          ? `It's gone quiet. If the song is over, your lesson opens in ${Math.max(0, Math.ceil(finishAt - silentFor))} s.`
          : "Recording. Come back to this tab any time; we stop when the song ends.";
    },
  })
    .then((controller) => {
      capture.controller = controller;
      if (capture.cancelled) return controller.stop();
      showYoutubeRecorder(true);
      $("tabLiveStatus").textContent = "";
      $("tabRecordTimer").textContent = "0:00";
      updateImportButton();
      return controller.done.then(async ({ wav }) => {
        if (capture.cancelled) return;
        $("tabRecordStatus").textContent = "Finishing your lesson…";
        $("keepWaitingButton").hidden = true;
        $("ytStop").disabled = true;
        const { notes, shift } = await session.finish();
        const meta = await capture.meta;
        endCapture(capture);
        await saveLesson({
          origin: "youtube",
          notes,
          audioOffset: shift,
          audioBlob: wav,
          title: $("importTitleInput").value.trim() || yt.meta?.title || meta?.title || "YouTube song",
          artist: meta?.artist || "From YouTube",
        });
        $("youtubeInput").value = "";
        yt.metaFor = null;
        yt.opened = false;
        $("ytPreview").hidden = true;
        setYtStep(1);
        document.title = "✓ Lesson ready – PianoGiri";
        setTimeout(() => (document.title = PAGE_TITLE), 6000);
      });
    })
    .catch((error) => endCapture(capture, error));
}

function endCapture(capture, error) {
  if (importState.capture === capture) {
    importState.capture = null;
    importState.busy = false;
  }
  if (error) capture.session?.cancel();
  showYoutubeRecorder(false);
  $("keepWaitingButton").hidden = true;
  $("ytStop").disabled = false;
  document.title = PAGE_TITLE;
  if (error && !capture.cancelled && error.message !== "cancelled") {
    $("importError").textContent = error.message;
    $("importError").hidden = false;
  }
  updateImportButton();
}

function cancelTabCapture() {
  const capture = importState.capture;
  if (!capture) return;
  capture.cancelled = true;
  capture.controller?.stop();
  capture.session?.cancel();
  endCapture(capture);
}

function titleFromFilename(name) {
  return name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
}

// Lessons made from recordings (not MIDI files) have a transcribed, ornamented tune.
function isSung(song) {
  return song.source === "user" && song.origin !== "midi" && song.notes.some((n) => n.m);
}

function setStage(stage) {
  const order = ["fetch", "decode", "model", "listen", "notes"];
  const idx = order.indexOf(stage);
  document.querySelectorAll(".stages li").forEach((li) => {
    const i = order.indexOf(li.dataset.stage);
    li.classList.toggle("done", i < idx);
    li.classList.toggle("current", i === idx);
  });
}

async function runImport() {
  if (importState.busy) return;
  importState.busy = true;
  updateImportButton();
  $("importError").hidden = true;

  const title = $("importTitleInput").value.trim();
  const id = `user-${Date.now().toString(36)}`;
  try {
    let notes;
    let finalTitle = title;
    let origin = importState.tab;
    let audioBlob = null;
    let audioOffset = 0;

    if (importState.tab === "midi") {
      const result = await midiFileToNotes(importState.midiFile);
      notes = result.notes;
      finalTitle = finalTitle || result.title || titleFromFilename(importState.midiFile.name);
    } else {
      const blob = importState.tab === "audio" ? importState.file : importState.recordedBlob;
      $("convertProgress").hidden = false;
      $("convertBar").style.width = "0%";
      document.querySelector('.stages [data-stage="fetch"]').hidden = true;
      audioBlob = blob;
      const result = await audioToNotes(blob, {
        detail: $("detailSelect").value,
        onStage: (stage) => setStage(stage),
        onProgress: (p) => {
          $("convertBar").style.width = `${Math.round(p * 100)}%`;
        },
      });
      notes = result.notes;
      audioOffset = result.shift;
      if (result.trimmed) toast("Trimmed to 8 minutes", "Longer audio is cut to keep your browser fast.");
      finalTitle = finalTitle || (importState.file ? titleFromFilename(importState.file.name) : "My recording");
    }

    setStage("done");
    await saveLesson({ origin, notes, audioOffset, audioBlob, title: finalTitle, artist: origin === "record" ? "My recording" : "My song", id });
  } catch (error) {
    $("importError").textContent = error.message || "Something went wrong.";
    $("importError").hidden = false;
  } finally {
    importState.busy = false;
    updateImportButton();
  }
}

// Stores a finished lesson (and its audio, for play-along) and opens it.
async function saveLesson({ origin, notes, audioOffset = 0, audioBlob = null, title, artist, id = `user-${Date.now().toString(36)}` }) {
  let hasAudio = false;
  if (audioBlob) {
    try {
      await audioStore.put(id, audioBlob);
      hasAudio = true;
    } catch (_error) {
      toast("Couldn't save the song audio", "You can still play the lesson, just without the original music.");
    }
  }
  const analysis = origin === "midi" ? 1 : IMPORT.analysisVersion; // see js/melody.js
  const song = songService.addUserSong({ id, title: title || "My song", artist, origin, notes, hasAudio, audioOffset, analysis });
  profile.recordConversion().forEach((a) => toast(`Badge unlocked: ${a.title}`, a.text));
  toast("Lesson ready!", `${song.notes.filter((n) => n.m).length || song.notes.length} melody notes in “${song.title}”.`);
  resetImportInputs();
  closeImport();
  app.tab = "user";
  syncTabs();
  renderLibrary();
  openSong(song.id);
}

function resetImportInputs() {
  importState.file = null;
  importState.midiFile = null;
  importState.recordedBlob = null;
  $("youtubeInput").value = "";
  $("audioFile").value = "";
  $("midiFile").value = "";
  $("audioFileName").textContent = "";
  $("midiFileName").textContent = "";
  $("importTitleInput").value = "";
  $("recordStatus").textContent = "Hum, sing or play near your mic";
  $("recordTimer").textContent = "0:00";
}

async function startRecording() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false } });
    const recorder = new MediaRecorder(stream);
    const chunks = [];
    recorder.ondataavailable = (e) => chunks.push(e.data);
    recorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      importState.recordedBlob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
      $("recordStatus").textContent = "Recorded! Give it a title and create your lesson.";
      updateImportButton();
    };
    const started = Date.now();
    importState.recording = {
      recorder,
      timer: setInterval(() => {
        const secs = (Date.now() - started) / 1000;
        $("recordTimer").textContent = formatDuration(secs);
        if (secs >= IMPORT.maxAudioSeconds) stopRecording();
      }, 250),
    };
    recorder.start();
    $("recordButton").setAttribute("aria-pressed", "true");
    $("recordStatus").textContent = "Recording… tap again to stop";
    importState.recordedBlob = null;
    updateImportButton();
  } catch (_error) {
    $("importError").textContent = "Microphone access was blocked. Allow it in your browser settings to record.";
    $("importError").hidden = false;
  }
}

function stopRecording() {
  const rec = importState.recording;
  if (!rec) return;
  clearInterval(rec.timer);
  rec.recorder.stop();
  importState.recording = null;
  $("recordButton").setAttribute("aria-pressed", "false");
}

function bindImport() {
  $("importOpen").addEventListener("click", openImport);
  $("importClose").addEventListener("click", closeImport);
  $("importCancel").addEventListener("click", closeImport);
  $("importConvert").addEventListener("click", runImport);
  $("keepWaitingButton").addEventListener("click", () => importState.capture?.controller?.keepWaiting());
  $("youtubeInput").addEventListener("input", onYoutubeLinkChange);
  $("youtubeInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && youtubeId($("youtubeInput").value)) setYtStep(2);
  });
  $("ytNext1").addEventListener("click", () => setYtStep(2));
  $("youtubeOpen").addEventListener("click", openYoutubeVideo);
  $("ytSkip2").addEventListener("click", () => setYtStep(3));
  $("ytRecord").addEventListener("click", startYoutubeCapture);
  $("ytStop").addEventListener("click", () => importState.capture?.controller?.stop());
  $("ytCancelRecording").addEventListener("click", () => {
    cancelTabCapture();
    setYtStep(3);
  });
  document.querySelectorAll(".yt-step").forEach((li) =>
    li.querySelector(".yt-step-head").addEventListener("click", () => {
      const n = Number(li.dataset.ytStep);
      if (n < yt.step && !importState.capture) setYtStep(n);
    })
  );

  $("importDialog").addEventListener("cancel", (e) => {
    if (importState.busy && !importState.capture) e.preventDefault();
    else if (importState.capture) cancelTabCapture();
  });
  document.querySelectorAll("[data-import-tab]").forEach((b) => b.addEventListener("click", () => setImportTab(b.dataset.importTab)));

  const pickAudio = (file) => {
    if (!file) return;
    importState.file = file;
    $("audioFileName").textContent = file.name;
    if (!$("importTitleInput").value) $("importTitleInput").value = titleFromFilename(file.name);
    updateImportButton();
  };
  const pickMidi = (file) => {
    if (!file) return;
    importState.midiFile = file;
    $("midiFileName").textContent = file.name;
    if (!$("importTitleInput").value) $("importTitleInput").value = titleFromFilename(file.name);
    updateImportButton();
  };
  $("audioFile").addEventListener("change", (e) => pickAudio(e.target.files[0]));
  $("midiFile").addEventListener("change", (e) => pickMidi(e.target.files[0]));

  document.querySelectorAll(".dropzone").forEach((zone) => {
    zone.addEventListener("dragover", (e) => {
      e.preventDefault();
      zone.classList.add("over");
    });
    zone.addEventListener("dragleave", () => zone.classList.remove("over"));
    zone.addEventListener("drop", (e) => {
      e.preventDefault();
      zone.classList.remove("over");
      const file = e.dataTransfer.files[0];
      if (!file) return;
      if (/\.(mid|midi)$/i.test(file.name)) {
        setImportTab("midi");
        pickMidi(file);
      } else {
        setImportTab("audio");
        pickAudio(file);
      }
    });
  });

  $("recordButton").addEventListener("click", () => (importState.recording ? stopRecording() : startRecording()));

}

/* ------------------------------------------------------------------ */
/* Bindings                                                             */
/* ------------------------------------------------------------------ */

function syncTabs() {
  document.querySelectorAll("[data-tab]").forEach((b) => {
    b.classList.toggle("active", b.dataset.tab === app.tab);
    b.setAttribute("aria-selected", String(b.dataset.tab === app.tab));
  });
}

function bindUi() {
  document.querySelectorAll("[data-nav]").forEach((b) =>
    b.addEventListener("click", () => (b.dataset.nav === "free" ? openFreePlay() : showLibrary()))
  );
  $("brandLink").addEventListener("click", (e) => {
    e.preventDefault();
    showLibrary();
  });

  document.querySelectorAll("[data-tab]").forEach((b) =>
    b.addEventListener("click", () => {
      app.tab = b.dataset.tab;
      syncTabs();
      renderLibrary();
    })
  );
  $("songSearch").addEventListener("input", (e) => {
    app.query = e.target.value;
    renderLibrary();
  });

  $("songGrid").addEventListener("click", async (e) => {
    const actionEl = e.target.closest("[data-action]");
    const card = e.target.closest(".song-card[data-id]");
    const action = actionEl?.dataset.action;
    if (action === "import") return openImport();
    if (!card) return;
    const id = card.dataset.id;
    if (action === "delete") {
      const song = songService.getById(id);
      if (song && window.confirm(`Delete “${song.title}” from My songs?`)) {
        songService.removeUserSong(id);
        audioStore.remove(id);
        renderLibrary();
      }
      return;
    }
    if (action === "download") {
      try {
        await downloadSongAsMidi(songService.getById(id));
      } catch (error) {
        toast("Download failed", error.message);
      }
      return;
    }
    openSong(id);
  });

  document.querySelectorAll(".seg").forEach((seg) =>
    seg.addEventListener("click", (e) => {
      const button = e.target.closest("button[data-value]");
      if (!button) return;
      settings[seg.dataset.setting] = button.dataset.value;
      saveSettings();
      syncSetupControls();
      prepareArrangement();
      updateControls();
    })
  );
  $("speedInput").addEventListener("input", (e) => {
    settings.speed = Number(e.target.value);
    $("speedOut").textContent = `${Math.round(settings.speed * 100)}%`;
    saveSettings();
  });
  $("musicToggle").addEventListener("change", (e) => {
    settings.music = e.target.checked;
    saveSettings();
    syncSetupControls();
    updateControls();
  });
  $("musicButton").addEventListener("click", toggleMusic);
  $("reanalyzeButton").addEventListener("click", reanalyzeSong);
  $("backingToggle").addEventListener("change", (e) => {
    settings.backing = e.target.checked;
    saveSettings();
  });
  $("labelSelect").addEventListener("change", (e) => {
    settings.labelMode = e.target.value;
    saveSettings();
  });

  $("startButton").addEventListener("click", startRun);
  $("pauseButton").addEventListener("click", () => (app.phase === "paused" ? resumeRun() : pauseRun()));
  $("resumeButton").addEventListener("click", resumeRun);
  $("restartButton").addEventListener("click", retryRun);
  $("settingsButton").addEventListener("click", showSetup);
  $("quitButton").addEventListener("click", showLibrary);
  $("retryButton").addEventListener("click", retryRun);
  $("resultsBackButton").addEventListener("click", showLibrary);
  $("backButton").addEventListener("click", () => {
    if (app.song && (app.phase === "playing" || app.phase === "paused" || app.phase === "results")) showSetup();
    else showLibrary();
  });

  $("sustainButton").addEventListener("click", () => {
    audio.toggleSustain();
    updateControls();
  });
  $("octaveDown").addEventListener("click", () => shiftOctave(-12));
  $("octaveUp").addEventListener("click", () => shiftOctave(12));
  $("velocityDown").addEventListener("click", () => {
    audio.changeVelocity(-4);
    updateControls();
  });
  $("velocityUp").addEventListener("click", () => {
    audio.changeVelocity(4);
    updateControls();
  });
  $("freeLayoutButton").addEventListener("click", () => {
    settings.freeLayout = settings.freeLayout === "full" ? "computer" : "full";
    saveSettings();
    buildFreeKeyboard();
    updateControls();
  });
  $("midiButton").addEventListener("click", async () => {
    try {
      await midiInput.connect();
      if (!midiDevices.length) toast("No MIDI keyboard found", "Plug one in via USB or Bluetooth — it will connect automatically.");
    } catch (error) {
      toast("MIDI unavailable", error.message);
    }
  });

  window.addEventListener("keydown", onKeyDown, { passive: false });
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", () => {
    pauseRun();
    releaseEverything();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      pauseRun();
      releaseEverything();
    }
  });
  window.addEventListener("resize", () => renderer.resize());
  if (window.ResizeObserver) new ResizeObserver(() => renderer.resize()).observe($("noteCanvas"));
}

/* ------------------------------------------------------------------ */
/* Frame loop                                                           */
/* ------------------------------------------------------------------ */

function frame(now) {
  const dt = Math.min(0.1, (now - app.lastFrame) / 1000);
  app.lastFrame = now;

  if (app.view === "play") {
    const game = app.game;
    if (game && app.phase === "playing") game.update(now);
    if (game) followHand(game.songTime);
    music.sync(game ? game.songTime : 0, settings.speed, Boolean(game) && app.phase === "playing" && !game.waiting && musicOn());
    if (game) {
      updateHud();
      const upcoming = settings.mode === "watch" ? [] : game.nextNotes().filter((n) => n.t - game.songTime < 0.8);
      keyboard.setExpected(upcoming.map((n) => n.midi));
    } else {
      keyboard.setExpected([]);
    }
    renderer.frame({
      game: app.song ? game : null,
      options: {
        labelMode: settings.labelMode,
        keyLabels: labelCache(),
        hand: app.song && settings.layout === "computer" && app.arrangement ? app.arrangement.hand : null,
      },
      dt,
      nowMs: now,
    });
  }
  requestAnimationFrame(frame);
}

/* ------------------------------------------------------------------ */
/* Start                                                                */
/* ------------------------------------------------------------------ */

async function startApp() {
  bindUi();
  bindImport();
  renderProfile();
  updateControls();
  midiInput.autoConnect();
  renderAd($("adLibrary"), "library");
  requestAnimationFrame(frame);

  try {
    await songService.loadSongs();
  } catch (_error) {
    toast("Couldn't load featured songs", "Check your connection and refresh.");
  }
  renderLibrary();

  const deepLink = new URLSearchParams(window.location.search).get("song");
  if (deepLink && songService.getById(deepLink)) openSong(deepLink);
}

if (new URLSearchParams(window.location.search).has("debug")) window.__pianogiri = { app, settings, noteOn, noteOff, music };

startApp();
