import { COMPUTER_WINDOW_SPAN, MIN_MIDI, MAX_MIDI } from "./config.js";

const CLUSTER_SECONDS = 0.06; // notes starting this close together form one chord
const MIN_GAP_EASY = 0.14; // easy mode drops melody notes faster than this

// Turns a song's raw notes into what the player actually plays.
//   difficulty: "easy" (melody only) | "medium" (melody + bass) | "hard" (everything)
//   layout:     "computer" (fold into the 18-key window) | "full" (original pitches)
// Returns { play, backing, rangeLo, rangeHi, windowBase }.
export function arrange(notes, { difficulty, layout }) {
  const hasMelody = notes.some((n) => n.m);
  let play = hasMelody ? pickFromMelody(notes, difficulty) : pickTopLine(notes, difficulty);

  const playSet = new Set(play);
  const backing = notes.filter((n) => !playSet.has(n));

  let windowBase;
  let rangeLo;
  let rangeHi;

  if (layout === "computer") {
    windowBase = bestWindowBase(play);
    const lo = windowBase;
    const hi = windowBase + COMPUTER_WINDOW_SPAN;
    play = play.map((n) => ({ ...n, midi: foldInto(n.midi, lo, hi), originalMidi: n.midi }));
    rangeLo = lo;
    rangeHi = hi;
  } else {
    play = play.map((n) => ({ ...n, originalMidi: n.midi }));
    const pitches = play.map((n) => n.midi);
    const min = pitches.length ? Math.min(...pitches) : 60;
    const max = pitches.length ? Math.max(...pitches) : 72;
    // Pad to whole octaves (C..B), at least two octaves wide.
    rangeLo = Math.max(MIN_MIDI, Math.floor(min / 12) * 12);
    rangeHi = Math.min(MAX_MIDI, Math.floor(max / 12) * 12 + 11);
    while (rangeHi - rangeLo < 23) {
      if (rangeLo > MIN_MIDI + 12 && (rangeHi >= MAX_MIDI - 12 || (min - rangeLo) < (rangeHi - max))) rangeLo -= 12;
      else rangeHi += 12;
    }
    windowBase = clampWindow(Math.round(median(pitches) / 12) * 12, rangeLo, rangeHi);
  }

  play = resolveOverlaps(dedupe(play));
  play.forEach((n, i) => {
    n.id = i;
  });

  return { play, backing, rangeLo, rangeHi, windowBase };
}

// Songs with a tracked melody (audio and MIDI imports):
//   easy   = the melody
//   medium = melody + a bass line (lowest accompaniment notes, well below the tune)
//   hard   = melody + the whole accompaniment
function pickFromMelody(notes, difficulty) {
  const melody = notes.filter((n) => n.m);
  const accompaniment = notes.filter((n) => !n.m);
  if (difficulty === "easy") return melody;
  if (difficulty === "hard") return [...melody, ...accompaniment.filter((n) => n.d >= 0.1)];

  const bass = [];
  let lastT = -Infinity;
  for (const cluster of clusterNotes(accompaniment)) {
    const low = cluster.reduce((a, b) => (b.midi < a.midi ? b : a));
    const tune = melodyAt(melody, low.t);
    const ceiling = tune ? tune.midi - 7 : 57;
    if (low.midi > ceiling || low.d < 0.15 || low.t - lastT < 0.3) continue;
    bass.push(low);
    lastT = low.t;
  }
  return [...melody, ...bass];
}

function melodyAt(melody, t) {
  let best = null;
  for (const n of melody) {
    if (n.t > t + 0.5) break;
    if (n.t + n.d >= t - 0.5) best = n;
  }
  return best;
}

// Songs without a tracked melody (built-in and older songs): top line.
function pickTopLine(notes, difficulty) {
  const clusters = clusterNotes(notes);
  const play = [];
  if (difficulty === "easy") {
    let lastT = -Infinity;
    for (const cluster of clusters) {
      const top = cluster.reduce((a, b) => (b.midi > a.midi ? b : a));
      if (top.t - lastT < MIN_GAP_EASY) continue;
      play.push(top);
      lastT = top.t;
    }
    return play;
  }
  if (difficulty === "medium") {
    for (const cluster of clusters) {
      const sorted = [...cluster].sort((a, b) => b.midi - a.midi);
      play.push(sorted[0]);
      const low = sorted[sorted.length - 1];
      if (sorted.length > 1 && sorted[0].midi - low.midi >= 5) play.push(low);
    }
    return play;
  }
  return [...notes];
}

function clusterNotes(notes) {
  const clusters = [];
  let current = [];
  for (const note of notes) {
    if (current.length && note.t - current[0].t > CLUSTER_SECONDS) {
      clusters.push(current);
      current = [];
    }
    current.push(note);
  }
  if (current.length) clusters.push(current);
  return clusters;
}

function bestWindowBase(notes) {
  if (!notes.length) return 60;
  let best = 60;
  let bestScore = -Infinity;
  for (let base = 24; base <= 96; base += 12) {
    const inRange = notes.filter((n) => n.midi >= base && n.midi <= base + COMPUTER_WINDOW_SPAN).length;
    const score = inRange * 10 - Math.abs(base - 60) / 12;
    if (score > bestScore) {
      bestScore = score;
      best = base;
    }
  }
  return best;
}

function foldInto(midi, lo, hi) {
  let m = midi;
  while (m < lo) m += 12;
  while (m > hi) m -= 12;
  return m;
}

function median(values) {
  if (!values.length) return 60;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function clampWindow(base, lo, hi) {
  const maxBase = Math.max(lo, hi - COMPUTER_WINDOW_SPAN);
  let b = Math.max(lo, Math.min(maxBase, base));
  b -= ((b % 12) + 12) % 12; // keep it on a C
  return Math.max(MIN_MIDI, b);
}

// Folding chords can stack identical pitches; keep one of each.
function dedupe(notes) {
  const sorted = [...notes].sort((a, b) => a.t - b.t || a.midi - b.midi);
  const out = [];
  const lastByMidi = new Map();
  for (const note of sorted) {
    const prev = lastByMidi.get(note.midi);
    if (prev && Math.abs(note.t - prev.t) < CLUSTER_SECONDS) {
      prev.d = Math.max(prev.d, note.d);
      continue;
    }
    const copy = { ...note };
    out.push(copy);
    lastByMidi.set(note.midi, copy);
  }
  return out;
}

// A key can't be held through its own next strike: trim the earlier note.
function resolveOverlaps(notes) {
  const lastByMidi = new Map();
  for (const note of notes) {
    const prev = lastByMidi.get(note.midi);
    if (prev && prev.t + prev.d > note.t - 0.04) {
      prev.d = Math.max(0.05, note.t - prev.t - 0.06);
    }
    lastByMidi.set(note.midi, note);
  }
  return notes;
}
