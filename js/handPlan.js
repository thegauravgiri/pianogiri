// Plans where the 18 computer keys sit during a song ("hand positions").
//
// Squeezing a whole song into 18 keys by moving notes an octave breaks the
// tune: a melody that crosses the window's edge jumps around, and bass notes
// land in the middle of the melody. Instead the keys follow the music:
//   * melody notes always keep their real pitch, so the keys move to them;
//   * a move costs something, a move in the middle of a quick passage costs a
//     lot, so the keys stay put unless the tune really goes somewhere else;
//   * when notes played together don't fit in 18 keys (a high melody note over
//     a low bass note), the melody wins. The other note moves by an octave into
//     reach if that doesn't collide with anything, otherwise the computer plays it.
//
// Windows start on a C (the computer keys' layout is C to F an octave up).

import { COMPUTER_WINDOW_SPAN, GAME, MIN_MIDI, MAX_MIDI } from "./config.js";

const CLUSTER_SECONDS = 0.06;
const MELODY_FOLD_COST = 25; // a melody note moved an octave: breaks the tune, so only for brief excursions
const FOLD_COST = 1; // an accompaniment note that has to move or be dropped
const MOVE_COST = 15; // any move of the keys (going somewhere and back > folding one note)
const RUSHED_MOVE_COST = 200; // a move with less than RELAXED_GAP to see it coming
const RELAXED_GAP = 0.6; // song-seconds between the notes either side of a move
export const MOVE_LEAD = 0.6; // the keys move this long before the note that needs them

// play: notes the player will play (true pitches), sorted or not.
// Returns { play, dropped, hand: [{ t, base }] } where hand[0].t is -Infinity,
// play notes that had to move carry `originalMidi`, and `dropped` notes go to the backing.
export function planHands(play) {
  const notes = [...play].sort((a, b) => a.t - b.t || b.midi - a.midi);
  if (!notes.length) return { play: notes, dropped: [], hand: [{ t: -Infinity, base: 60 }] };

  const clusters = [];
  for (const note of notes) {
    const last = clusters[clusters.length - 1];
    if (last && note.t - last.t <= CLUSTER_SECONDS) last.notes.push(note);
    else clusters.push({ t: note.t, notes: [note] });
  }
  // The tune decides where the keys go: melody notes, or each cluster's top note
  // for songs without a melody. Bass-only moments never pull the keys down.
  const hasMelody = notes.some((n) => n.m);
  for (const c of clusters) {
    c.lead = hasMelody ? c.notes.filter((n) => n.m) : [c.notes.reduce((a, b) => (b.midi > a.midi ? b : a))];
  }

  const pitches = clusters.flatMap((c) => c.lead.map((n) => n.midi));
  // Every C from which some note is reachable, within the piano (C1 .. C7).
  const lowest = Math.ceil(Math.max(MIN_MIDI + 3, Math.min(...pitches) - COMPUTER_WINDOW_SPAN) / 12) * 12;
  const highest = Math.floor(Math.min(MAX_MIDI - COMPUTER_WINDOW_SPAN, Math.max(...pitches)) / 12) * 12;
  const bases = [];
  for (let b = Math.min(lowest, highest); b <= Math.max(lowest, highest); b += 12) bases.push(b);

  const cost = (c, base) => {
    let total = 0;
    const lo = base;
    const hi = base + COMPUTER_WINDOW_SPAN;
    for (const n of c.notes) {
      if (n.midi >= lo && n.midi <= hi) continue;
      total += c.lead.includes(n) ? MELODY_FOLD_COST : FOLD_COST;
    }
    // Tie-break towards windows centred on the tune.
    for (const n of c.lead) total += Math.abs(n.midi - (lo + hi) / 2) * 0.001;
    return total;
  };

  // Viterbi over clusters × window positions.
  const K = bases.length;
  let prev = bases.map((b) => cost(clusters[0], b));
  const back = [];
  for (let i = 1; i < clusters.length; i += 1) {
    const gap = clusters[i].t - clusters[i - 1].t;
    const cur = new Array(K);
    const from = new Array(K);
    for (let k = 0; k < K; k += 1) {
      let best = Infinity;
      let arg = k;
      for (let j = 0; j < K; j += 1) {
        const steps = Math.abs(j - k);
        const move = steps ? MOVE_COST * steps + (gap < RELAXED_GAP ? RUSHED_MOVE_COST : 0) : 0;
        const value = prev[j] + move;
        if (value < best) {
          best = value;
          arg = j;
        }
      }
      cur[k] = best + cost(clusters[i], bases[k]);
      from[k] = arg;
    }
    back.push(from);
    prev = cur;
  }
  let k = prev.indexOf(Math.min(...prev));
  const chosen = new Array(clusters.length);
  for (let i = clusters.length - 1; i >= 0; i -= 1) {
    chosen[i] = bases[k];
    if (i > 0) k = back[i - 1][k];
  }

  // When the keys move: well before the note that needs them, but only after
  // the previous notes can no longer be played late.
  const hand = [{ t: -Infinity, base: chosen[0] }];
  for (let i = 1; i < clusters.length; i += 1) {
    if (chosen[i] === chosen[i - 1]) continue;
    const earliest = clusters[i - 1].t + GAME.windows.good + 0.02;
    const latest = clusters[i].t - 0.05;
    const t = earliest <= latest ? Math.max(earliest, clusters[i].t - MOVE_LEAD) : (clusters[i - 1].t + clusters[i].t) / 2;
    hand.push({ t, base: chosen[i] });
  }

  // Bring stray accompaniment notes into reach, or hand them to the backing.
  const out = [];
  const dropped = [];
  clusters.forEach((c, i) => {
    const lo = chosen[i];
    const hi = lo + COMPUTER_WINDOW_SPAN;
    for (const n of c.notes) {
      if (n.midi >= lo && n.midi <= hi) {
        out.push({ ...n, originalMidi: n.originalMidi ?? n.midi });
        continue;
      }
      let m = n.midi;
      while (m < lo) m += 12;
      while (m > hi) m -= 12;
      const clash = c.notes.some((o) => o !== n && o.midi === m) || out.some((o) => o.midi === m && o.t + o.d > n.t - 0.04 && o.t < n.t + n.d);
      if (clash || m < lo) dropped.push(n);
      else out.push({ ...n, midi: m, originalMidi: n.originalMidi ?? n.midi });
    }
  });
  return { play: out, dropped, hand };
}

export function baseAt(hand, t) {
  let base = hand[0].base;
  for (const step of hand) {
    if (step.t > t) break;
    base = step.base;
  }
  return base;
}
