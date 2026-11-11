// Predominant-melody extraction from Basic Pitch's pitch-salience "contour" output.
//
// The old approach ("highest note at each moment") hands the player overtones,
// cymbals and high accompaniment instead of the tune. This instead finds the
// single strongest *continuous* pitch line in the singing range with a Viterbi
// search: staying on a pitch is free, moving costs a little per step, and an
// "unvoiced" state covers rests. The line is then cut into notes.
//
// contours: frames × 264 bins (3 bins per semitone, bin 0 = A0 = MIDI 21)
// onsets:   frames × 88 semitones (index 0 = MIDI 21)

const SAMPLE_RATE = 22050;
const FFT_HOP = 256;
const FPS = SAMPLE_RATE / FFT_HOP; // nominal frame rate, only used for short durations
const BINS_PER_SEMITONE = 3;

// Basic Pitch's own frame→seconds mapping. Its frames aren't exactly 256 samples
// apart (overlapping windows are trimmed), so a plain frame/FPS drifts ~0.5%:
// over a second by the end of a 4-minute song. This matches the note builder.
const ANNOT_N_FRAMES = Math.floor(SAMPLE_RATE / FFT_HOP) * 2;
const AUDIO_N_SAMPLES = SAMPLE_RATE * 2 - FFT_HOP;
const WINDOW_OFFSET = (FFT_HOP / SAMPLE_RATE) * (ANNOT_N_FRAMES - AUDIO_N_SAMPLES / FFT_HOP) + 0.0018;
export const frameToTime = (frame) => (frame * FFT_HOP) / SAMPLE_RATE - WINDOW_OFFSET * Math.floor(frame / ANNOT_N_FRAMES);
const MIDI_OFFSET = 21;

export const MELODY_DEFAULTS = {
  minMidi: 48, // C3 – lowest melody note considered
  maxMidi: 88, // E6 – highest
  // Tuned on real recordings (low male voice + orchestra, high female voice,
  // Nepali pop) scored against their separated vocal lines.
  centerMidi: "auto", // register prior centre: "auto" detects it per song, or a MIDI number
  fallbackCenter: 68,
  priorWeight: 0.6,
  priorWidth: 14,
  voicingThreshold: 0.28, // salience below this is treated as "no melody"
  moveCost: 0.1, // per contour bin (1/3 semitone) of pitch movement: discourages octave hops
  changeCost: 0.2, // extra cost for any pitch change
  voicingCost: 3, // cost to switch between melody and silence: fewer stray fill notes
  onsetWeight: 1.5, // pull the line onto a pitch at the moment a note starts there
  hysteresis: 0.5, // semitones the pitch must move before a new note starts
  minNoteSeconds: 0.1, // shorter blips merge into a neighbour or are dropped
  reattackOnset: 0.6, // onset strength that may re-strike a repeated pitch…
  reattackDip: 0.55, // …but only if loudness dipped below this share of the note's average first
  minReattackSeconds: 0.15,
};

export function extractMelody(contours, onsets, options = {}) {
  const o = { ...MELODY_DEFAULTS, ...options };
  if (o.centerMidi !== "auto") return trackMelody(contours, onsets, o);
  // Singers sit anywhere from a low male voice (~G3) to a high female one (~G5).
  // Find where this song's line lives with an unbiased pass, then track again
  // with the register prior centred there.
  const first = trackMelody(contours, onsets, { ...o, centerMidi: o.fallbackCenter, priorWeight: 0 });
  return trackMelody(contours, onsets, { ...o, centerMidi: registerOf(first, o) });
}

function registerOf(notes, o) {
  const total = notes.reduce((sum, n) => sum + n.d, 0);
  if (!total) return o.fallbackCenter;
  const sorted = [...notes].sort((a, b) => a.midi - b.midi);
  let acc = 0;
  for (const n of sorted) {
    acc += n.d;
    if (acc >= total / 2) return Math.max(o.minMidi + 4, Math.min(o.maxMidi - 4, n.midi));
  }
  return o.fallbackCenter;
}

function trackMelody(contours, onsets, o) {
  const nFrames = contours.length;
  if (!nFrames) return [];

  const lo = (o.minMidi - MIDI_OFFSET) * BINS_PER_SEMITONE;
  const hi = Math.min(contours[0].length - 1, (o.maxMidi - MIDI_OFFSET) * BINS_PER_SEMITONE);
  const K = hi - lo + 1; // voiced states; state K = unvoiced
  const U = K;

  // Register prior (in log space), small enough to only break ties.
  const prior = new Float32Array(K);
  for (let k = 0; k < K; k += 1) {
    const midi = MIDI_OFFSET + (lo + k) / BINS_PER_SEMITONE;
    prior[k] = -0.5 * ((midi - o.centerMidi) / o.priorWidth) ** 2 * o.priorWeight;
  }
  const unvoicedScore = Math.log(o.voicingThreshold);

  let prev = new Float32Array(K + 1);
  let cur = new Float32Array(K + 1);
  const fwdVal = new Float32Array(K);
  const fwdIdx = new Int32Array(K);
  const back = new Int16Array(nFrames * (K + 1));

  // Salience (log) + register prior + a bonus where a note attack is heard at that pitch.
  const semitoneOf = new Int16Array(K);
  for (let k = 0; k < K; k += 1) semitoneOf[k] = Math.round((lo + k) / BINS_PER_SEMITONE);
  const emit = (t, k) => {
    let score = Math.log(Math.max(contours[t][lo + k], 1e-4)) + prior[k];
    const row = onsets?.[t];
    if (row) score += o.onsetWeight * (row[semitoneOf[k]] || 0);
    return score;
  };
  for (let k = 0; k < K; k += 1) prev[k] = emit(0, k) - o.voicingCost;
  prev[U] = unvoicedScore;

  for (let t = 1; t < nFrames; t += 1) {
    // Best predecessor under cost a·|Δ| via a two-pass L1 distance transform: O(K).
    const a = o.moveCost;
    fwdVal[0] = prev[0];
    fwdIdx[0] = 0;
    for (let k = 1; k < K; k += 1) {
      const carried = fwdVal[k - 1] - a;
      if (carried > prev[k]) {
        fwdVal[k] = carried;
        fwdIdx[k] = fwdIdx[k - 1];
      } else {
        fwdVal[k] = prev[k];
        fwdIdx[k] = k;
      }
    }
    for (let k = K - 2; k >= 0; k -= 1) {
      const carried = fwdVal[k + 1] - a;
      if (carried > fwdVal[k]) {
        fwdVal[k] = carried;
        fwdIdx[k] = fwdIdx[k + 1];
      }
    }

    const row = t * (K + 1);
    let bestVoiced = -Infinity;
    let bestVoicedIdx = 0;
    for (let k = 0; k < K; k += 1) {
      // Stay put (free) vs. move (distance cost + change penalty) vs. start after silence.
      let best = prev[k];
      let from = k;
      const moved = fwdVal[k] - o.changeCost;
      if (fwdIdx[k] !== k && moved > best) {
        best = moved;
        from = fwdIdx[k];
      }
      const fromSilence = prev[U] - o.voicingCost;
      if (fromSilence > best) {
        best = fromSilence;
        from = U;
      }
      cur[k] = best + emit(t, k);
      back[row + k] = from;
      if (prev[k] > bestVoiced) {
        bestVoiced = prev[k];
        bestVoicedIdx = k;
      }
    }
    // Unvoiced: stay silent, or fall silent from the best voiced state.
    if (prev[U] >= bestVoiced - o.voicingCost) {
      cur[U] = prev[U] + unvoicedScore;
      back[row + U] = U;
    } else {
      cur[U] = bestVoiced - o.voicingCost + unvoicedScore;
      back[row + U] = bestVoicedIdx;
    }
    [prev, cur] = [cur, prev];
  }

  // Backtrack.
  const path = new Int16Array(nFrames);
  let state = 0;
  for (let k = 1; k <= K; k += 1) if (prev[k] > prev[state]) state = k;
  for (let t = nFrames - 1; t >= 0; t -= 1) {
    path[t] = state;
    if (t > 0) state = back[t * (K + 1) + state];
  }

  // Frame pitch (fractional MIDI) or null when unvoiced.
  const pitch = new Array(nFrames);
  const strength = new Float32Array(nFrames);
  for (let t = 0; t < nFrames; t += 1) {
    const k = path[t];
    if (k === U) {
      pitch[t] = null;
    } else {
      pitch[t] = MIDI_OFFSET + (lo + k) / BINS_PER_SEMITONE;
      strength[t] = contours[t][lo + k];
    }
  }

  return segmentNotes(pitch, strength, onsets, o);
}

// Turns a frame-level pitch line into notes. Hysteresis keeps vibrato and
// small slides inside one note; strong onsets re-strike repeated pitches.
function segmentNotes(pitch, strength, onsets, o) {
  const notes = [];
  let current = null;

  const close = (endFrame) => {
    if (current) {
      current.end = endFrame;
      notes.push(current);
      current = null;
    }
  };

  for (let t = 0; t < pitch.length; t += 1) {
    const p = pitch[t];
    if (p === null) {
      close(t);
      continue;
    }
    if (!current) {
      current = { midi: Math.round(p), start: t, sum: 0, n: 0 };
    } else if (Math.abs(p - current.midi) > o.hysteresis) {
      close(t);
      current = { midi: Math.round(p), start: t, sum: 0, n: 0 };
    } else if (
      onsets &&
      t - current.start >= Math.round(o.minReattackSeconds * FPS) &&
      isReattack(onsets, t, current.midi, o.reattackOnset) &&
      dippedBefore(strength, t, current.sum / Math.max(1, current.n), o.reattackDip)
    ) {
      close(t);
      current = { midi: Math.round(p), start: t, sum: 0, n: 0 };
    }
    current.sum += strength[t];
    current.n += 1;
  }
  close(pitch.length);

  // Merge blips: very short notes join a neighbour within a semitone, else drop.
  const minFrames = Math.round(o.minNoteSeconds * FPS);
  const merged = [];
  for (const note of notes) {
    const prev = merged[merged.length - 1];
    if (note.end - note.start < minFrames) {
      if (prev && prev.end === note.start && Math.abs(prev.midi - note.midi) <= 1) {
        prev.end = note.end;
        prev.sum += note.sum;
        prev.n += note.n;
      }
      continue;
    }
    merged.push(note);
  }

  return merged.map((n) => ({
    t: frameToTime(n.start),
    d: frameToTime(n.end) - frameToTime(n.start),
    midi: n.midi,
    v: Math.round(55 + Math.min(1, n.sum / Math.max(1, n.n)) * 70),
    m: true,
  }));
}

function dippedBefore(strength, t, mean, ratio) {
  for (let i = Math.max(0, t - 4); i < t; i += 1) if (strength[i] < mean * ratio) return true;
  return false;
}

function isReattack(onsets, t, midi, threshold) {
  const row = onsets[t];
  const idx = midi - MIDI_OFFSET;
  if (!row || idx < 0 || idx >= row.length) return false;
  const v = row[idx];
  return v >= threshold && v >= (onsets[t - 1]?.[idx] ?? 0) && v >= (onsets[t + 1]?.[idx] ?? 0);
}

// Accompaniment = polyphonic notes minus those that just duplicate the melody.
export function accompanimentFrom(polyNotes, melodyNotes) {
  return polyNotes.filter((n) => {
    for (const m of melodyNotes) {
      if (m.t > n.t + n.d) break;
      if (m.midi !== n.midi) continue;
      const overlap = Math.min(n.t + n.d, m.t + m.d) - Math.max(n.t, m.t);
      if (overlap > 0.5 * Math.min(n.d, m.d)) return false;
    }
    return true;
  });
}
