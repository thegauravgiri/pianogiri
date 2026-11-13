// Cleans a melody transcribed from singing without changing the tune.
//
// Two artefacts of transcribing a voice are removed:
//   * glides: when a singer slides from A down to E, the transcription catches
//     a brief G# and F# on the way. A short note that sits strictly between its
//     neighbours' pitches and runs straight into both is part of that slide,
//     so it's folded into the note the slide arrives at;
//   * split notes: one held note sometimes comes out as two back-to-back
//     notes of the same pitch; those are joined.
// Short off-key notes (also mostly slides) are moved onto the song's scale.
// Quick notes that zigzag (C# B C# A B G# A) are real melody and are kept.
// Checked against piano tutorials of a trending song: fewer extra notes,
// with none of the tune lost.

const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11];
const MINOR_SCALE = [0, 2, 3, 5, 7, 8, 10, 11]; // natural minor plus the raised 7th

const GLIDE_SECONDS = 0.2; // passing notes shorter than this are part of a slide
const SPLIT_SECONDS = 0.15; // a same-pitch fragment shorter than this is joined to its twin
const TOUCH_GAP = 0.06; // notes closer than this run into each other
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

const pitchClass = (midi) => ((midi % 12) + 12) % 12;
const end = (n) => n.t + n.d;

// melody: the tune's notes; allNotes: the whole song (for the key).
// Returns new note objects; each lists the original notes it replaced in `from`.
export function simplifyMelody(melody, allNotes) {
  const notes = [...melody].sort((a, b) => a.t - b.t).map((n) => ({ ...n, from: [n] }));
  if (notes.length < 2) return notes;
  const { scale } = detectKey(allNotes.length ? allNotes : melody);

  // Short off-key notes go to the nearest scale note, leaning towards a neighbour's pitch.
  notes.forEach((n, i) => {
    if (scale.has(pitchClass(n.midi)) || n.d >= SNAP_MAX_SECONDS) return;
    const options = [n.midi - 1, n.midi + 1].filter((m) => scale.has(pitchClass(m)));
    if (!options.length) return;
    const neighbours = [notes[i - 1]?.midi, notes[i + 1]?.midi];
    options.sort((a, b) => Number(neighbours.includes(b)) - Number(neighbours.includes(a)));
    n.midi = options[0];
  });

  // Glides: fold passing notes into the note the slide arrives at.
  for (let i = 1; i < notes.length - 1; ) {
    const prev = notes[i - 1];
    const n = notes[i];
    const next = notes[i + 1];
    const passing = (prev.midi < n.midi && n.midi < next.midi) || (prev.midi > n.midi && n.midi > next.midi);
    if (passing && n.d < GLIDE_SECONDS && n.t - end(prev) <= TOUCH_GAP && next.t - end(n) <= TOUCH_GAP) {
      next.d = end(next) - n.t;
      next.t = n.t;
      next.from.push(...n.from);
      notes.splice(i, 1);
      if (i > 1) i -= 1; // the new neighbour may now be a passing note too
    } else {
      i += 1;
    }
  }

  // Split notes: same pitch, touching, one of them a fragment.
  const out = [];
  for (const n of notes) {
    const prev = out[out.length - 1];
    if (prev && prev.midi === n.midi && n.t - end(prev) <= TOUCH_GAP && Math.min(prev.d, n.d) < SPLIT_SECONDS) {
      prev.d = end(n) - prev.t;
      prev.from.push(...n.from);
      continue;
    }
    out.push(n);
  }
  return out;
}
