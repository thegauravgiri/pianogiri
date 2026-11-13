import { COMPUTER_WINDOW_SPAN, MIN_MIDI, MAX_MIDI } from "./config.js";
import { simplifyMelody } from "./simplify.js";
import { planHands } from "./handPlan.js";

const CLUSTER_SECONDS = 0.06; // notes starting this close together form one chord
const MIN_GAP_EASY = 0.14; // easy mode drops melody notes faster than this
// What a player can manage alongside the melody.
const LIMITS = {
  medium: { maxTogether: 2, minSeconds: 0.3, minGap: 0.8 }, // an occasional bass note
  hard: { maxTogether: 3, minSeconds: 0.2, minGap: 0.25 }, // bass and a chord note, not every note
};

// Turns a song's raw notes into what the player actually plays.
//   difficulty: "easy" (melody only) | "medium" (melody + bass) | "hard" (everything)
//   layout:     "computer" (fold into the 18-key window) | "full" (original pitches)
//   sung:       the melody was transcribed from a recording, so Easy/Medium simplify it
// Returns { play, backing, rangeLo, rangeHi, windowBase, hand }. `hand` lists where the
// computer keys sit over time ([{ t, base }], first t = -Infinity); see handPlan.js.
export function arrange(notes, { difficulty, layout, sung = false }) {
  const hasMelody = notes.some((n) => n.m);
  const picked = hasMelody ? pickFromMelody(notes, difficulty, sung) : { play: pickTopLine(notes, difficulty), replaced: [] };
  let play = picked.play;

  // Everything the player doesn't play can be auto-played as backing, except
  // the sung ornaments folded into the player's notes (they'd clash).
  const playSet = new Set([...play, ...picked.replaced]);
  let backing = notes.filter((n) => !playSet.has(n));

  let windowBase;
  let rangeLo;
  let rangeHi;
  let hand;

  if (layout === "computer") {
    // The keys follow the music instead of squeezing it into 18 keys.
    const planned = planHands(play);
    play = planned.play;
    hand = planned.hand;
    if (planned.dropped.length) backing = [...backing, ...planned.dropped].sort((a, b) => a.t - b.t);
    // The on-screen keyboard is always the 18 computer keys; it slides to
    // another octave when the hand moves (the app rebuilds it at each move).
    windowBase = hand[0].base;
    rangeLo = windowBase;
    rangeHi = windowBase + COMPUTER_WINDOW_SPAN;
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
    hand = [{ t: -Infinity, base: windowBase }];
  }

  play = resolveOverlaps(dedupe(play));
  play.forEach((n, i) => {
    n.id = i;
  });

  return { play, backing, rangeLo, rangeHi, windowBase, hand };
}

// Songs with a tracked melody (audio and MIDI imports):
//   easy   = the melody
//   medium = melody + an occasional bass note (lowest accompaniment, well below the tune)
//   hard   = melody + a playable share of the accompaniment (at most 3 keys at once)
// A melody transcribed from singing is cleaned first (slides and split notes,
// see simplify.js). Returns { play, replaced: original notes the cleaned melody replaces }.
function pickFromMelody(notes, difficulty, sung) {
  const tracked = notes.filter((n) => n.m);
  const accompaniment = notes.filter((n) => !n.m);

  let melody = tracked;
  let replaced = [];
  if (sung) {
    melody = simplifyMelody(tracked, notes).map(({ from, ...n }) => n);
    replaced = tracked;
  }
  if (difficulty === "easy") return { play: melody, replaced };

  const limit = LIMITS[difficulty] || LIMITS.medium;
  const extra = [];
  const lastByMidi = new Map();
  let lastT = -Infinity;
  for (const cluster of clusterNotes(accompaniment)) {
    const t = cluster[0].t;
    const tune = melodyAt(melody, t);
    const ceiling = tune ? tune.midi - (difficulty === "hard" ? 3 : 7) : 57;
    // Lowest notes first: the bass carries the harmony.
    const candidates = cluster
      .filter((n) => n.midi <= ceiling && n.d >= limit.minSeconds && t - (lastByMidi.get(n.midi) ?? -Infinity) >= 0.4)
      .sort((a, b) => a.midi - b.midi);
    if (!candidates.length || t - lastT < limit.minGap) continue;
    const room = limit.maxTogether - (melodyStartsAt(melody, t) ? 1 : 0);
    const chosen = difficulty === "hard" ? spread(candidates, Math.min(room, 2)) : candidates.slice(0, Math.min(room, 1));
    for (const n of chosen) {
      extra.push(n);
      lastByMidi.set(n.midi, t);
    }
    if (chosen.length) lastT = t;
  }
  return { play: [...melody, ...extra], replaced };
}

// Lowest note plus, if there's room, the highest other one (a fuller sound than two neighbours).
function spread(sortedLowFirst, count) {
  if (count <= 0) return [];
  if (count === 1 || sortedLowFirst.length === 1) return sortedLowFirst.slice(0, 1);
  return [sortedLowFirst[0], sortedLowFirst[sortedLowFirst.length - 1]];
}

function melodyStartsAt(melody, t) {
  return melody.some((n) => Math.abs(n.t - t) <= CLUSTER_SECONDS);
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
