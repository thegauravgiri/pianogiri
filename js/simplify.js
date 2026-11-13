// Turns a transcribed vocal line into the tune people actually hum.
//
// Singers decorate: quick turns, slides into a note, little runs on one
// syllable (very common in Indian and Nepali songs). A faithful transcription
// keeps all of that, which on a piano sounds like a flurry of random notes. This
//   1. finds the song's key from all its notes,
//   2. moves short off-key notes (slides passing between scale notes) onto the scale,
//   3. folds ornaments (notes shorter than `minSeconds` that run straight into a
//      neighbour) into the main note they decorate.
// Longer notes, rests and genuinely separate short notes are left alone.

const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11];
const MINOR_SCALE = [0, 2, 3, 5, 7, 8, 10, 11]; // natural minor plus the raised 7th

const JOIN_GAP = 0.08; // seconds: notes closer than this count as one sung gesture
const MAX_ORNAMENT_LEAP = 4; // semitones: further than this is a real melodic jump
const SNAP_MAX_SECONDS = 0.35; // longer off-key notes are probably intended

// Krumhansl–Schmuckler key estimate. Returns { tonic, mode, scale: Set of pitch classes }.
export function detectKey(notes) {
  const weight = new Array(12).fill(0);
  for (const n of notes) weight[((n.midi % 12) + 12) % 12] += Math.min(n.d, 2);
  let best = { score: -Infinity, tonic: 0, mode: "major" };
  for (let tonic = 0; tonic < 12; tonic += 1) {
    for (const [profile, mode] of [
      [MAJOR, "major"],
      [MINOR, "minor"],
    ]) {
      let score = 0;
      for (let i = 0; i < 12; i += 1) score += weight[(i + tonic) % 12] * profile[i];
      if (score > best.score) best = { score, tonic, mode };
    }
  }
  const steps = best.mode === "major" ? MAJOR_SCALE : MINOR_SCALE;
  return { tonic: best.tonic, mode: best.mode, scale: new Set(steps.map((s) => (s + best.tonic) % 12)) };
}

const inScale = (scale, midi) => scale.has(((midi % 12) + 12) % 12);

// melody: notes of the tune; allNotes: the whole song (for the key).
// Returns new note objects; each lists the original notes it replaced in `from`.
export function simplifyMelody(melody, allNotes, { minSeconds = 0.2 } = {}) {
  if (melody.length < 2) return melody.map((n) => ({ ...n, from: [n] }));
  const { scale } = detectKey(allNotes.length ? allNotes : melody);
  const notes = [...melody].sort((a, b) => a.t - b.t).map((n) => ({ ...n, from: [n] }));

  // 1. Short off-key notes go to the nearest scale note, leaning towards a neighbour's pitch.
  notes.forEach((n, i) => {
    if (inScale(scale, n.midi) || n.d >= SNAP_MAX_SECONDS) return;
    const options = [n.midi - 1, n.midi + 1].filter((m) => inScale(scale, m));
    if (!options.length) return;
    const neighbours = [notes[i - 1]?.midi, notes[i + 1]?.midi].filter((m) => m !== undefined);
    options.sort((a, b) => Number(neighbours.includes(b)) - Number(neighbours.includes(a)));
    n.midi = options[0];
  });

  // 2. Fold ornaments into the note they lead into or out of, shortest first.
  const end = (n) => n.t + n.d;
  for (;;) {
    let pick = -1;
    for (let i = 0; i < notes.length; i += 1) {
      const n = notes[i];
      if (n.d >= minSeconds) continue;
      const prev = notes[i - 1];
      const next = notes[i + 1];
      const joinsPrev = prev && n.t - end(prev) <= JOIN_GAP && Math.abs(prev.midi - n.midi) <= MAX_ORNAMENT_LEAP;
      const joinsNext = next && next.t - end(n) <= JOIN_GAP && Math.abs(next.midi - n.midi) <= MAX_ORNAMENT_LEAP;
      if (!joinsPrev && !joinsNext) continue;
      if (pick < 0 || n.d < notes[pick].d) pick = i;
    }
    if (pick < 0) break;
    const n = notes[pick];
    const prev = notes[pick - 1];
    const next = notes[pick + 1];
    const joinsPrev = prev && n.t - end(prev) <= JOIN_GAP && Math.abs(prev.midi - n.midi) <= MAX_ORNAMENT_LEAP;
    const joinsNext = next && next.t - end(n) <= JOIN_GAP && Math.abs(next.midi - n.midi) <= MAX_ORNAMENT_LEAP;
    // A note leading into a longer one is a grace note: the main note starts with it.
    // Otherwise it trails off the previous note.
    const into = joinsNext && (!joinsPrev || next.d >= prev.d) ? next : prev;
    const start = Math.min(into.t, n.t);
    const stop = Math.max(end(into), end(n));
    into.t = start;
    into.d = stop - start;
    into.v = Math.max(into.v || 0, n.v || 0);
    into.from.push(...n.from);
    notes.splice(pick, 1);
  }

  // 3. Snapping can leave the same pitch twice in a row with no gap: one held note.
  const out = [];
  for (const n of notes) {
    const prev = out[out.length - 1];
    if (prev && prev.midi === n.midi && n.t - end(prev) <= 0.02 && (prev.from.length > 1 || n.from.length > 1)) {
      prev.d = end(n) - prev.t;
      prev.from.push(...n.from);
      continue;
    }
    out.push(n);
  }
  return out;
}
