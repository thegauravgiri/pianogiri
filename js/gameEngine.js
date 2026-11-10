import { GAME } from "./config.js";

// Modes:
//   practice: the song waits at each note until you press it (no misses).
//   perform:  the song keeps moving; timing is judged and notes can be missed.
//   watch:    the song plays itself so you can see and hear it first.
export function createGame({ arrangement, mode, speed, backingOn, callbacks = {} }) {
  const notes = arrangement.play.map((n) => ({
    ...n,
    status: "pending", // pending | hit | missed | auto
    judgment: null,
    isHold: n.d >= GAME.holdThreshold,
    holding: false,
    holdFraction: 0,
    holdDone: false,
  }));
  const backing = backingOn ? [...arrangement.backing].sort((a, b) => a.t - b.t) : [];

  const firstT = notes.length ? notes[0].t : 0;
  const endT = Math.max(
    notes.reduce((end, n) => Math.max(end, n.t + n.d), 0),
    backing.reduce((end, n) => Math.max(end, n.t + n.d), 0)
  );
  const startTime = Math.min(0, firstT - GAME.lookaheadSeconds) - 0.4;

  const holdingByMidi = new Map();
  const stats = {
    perfect: 0,
    great: 0,
    good: 0,
    miss: 0,
    wrong: 0,
    combo: 0,
    maxCombo: 0,
    score: 0,
    holdsTotal: notes.filter((n) => n.isHold).length,
    holdsCompleted: 0,
    weightSum: 0,
    total: notes.length,
  };

  let songTime = startTime;
  let lastNow = null;
  let state = "ready"; // ready | playing | paused | finished
  let pendingIndex = 0; // first note that may still be pending
  let backingIndex = 0;
  let waiting = false;
  let clusterHadWrong = false;
  let playedRealSeconds = 0;

  const emit = (name, ...args) => callbacks[name] && callbacks[name](...args);

  function multiplier() {
    return Math.min(GAME.maxMultiplier, 1 + Math.floor(stats.combo / GAME.comboPerMultiplier));
  }

  function advancePendingIndex() {
    while (pendingIndex < notes.length && notes[pendingIndex].status !== "pending") pendingIndex += 1;
  }

  function nextPendingT() {
    advancePendingIndex();
    return pendingIndex < notes.length ? notes[pendingIndex].t : null;
  }

  // Song time at a real timestamp, without committing it.
  function timeAt(now) {
    if (state !== "playing" || lastNow === null) return songTime;
    let t = songTime + ((now - lastNow) / 1000) * speed;
    if (mode === "practice") {
      const wait = nextPendingT();
      if (wait !== null && t >= wait) t = wait;
    }
    return t;
  }

  function begin(now) {
    state = "playing";
    lastNow = now;
  }

  function pause() {
    if (state === "playing") state = "paused";
  }

  function resume(now) {
    if (state === "paused") {
      state = "playing";
      lastNow = now;
    }
  }

  function update(now) {
    if (state !== "playing") return;
    const prevTime = songTime;
    const next = timeAt(now);
    playedRealSeconds += (now - lastNow) / 1000;
    lastNow = now;
    songTime = next;

    if (mode === "practice") {
      const wait = nextPendingT();
      const nowWaiting = wait !== null && songTime >= wait;
      if (nowWaiting && !waiting) clusterHadWrong = false;
      waiting = nowWaiting;
    }

    // Holds: score while held, complete when the tail passes the line.
    for (const note of holdingByMidi.values()) {
      const heldTo = Math.min(songTime, note.t + note.d);
      const gained = Math.max(0, heldTo - Math.max(prevTime, note.t));
      stats.score += Math.round(gained * GAME.points.holdPerSecond * multiplier());
      note.holdFraction = Math.min(1, (heldTo - note.t) / note.d);
      if (songTime >= note.t + note.d) finishHold(note, true);
    }

    for (let i = pendingIndex; i < notes.length; i += 1) {
      const note = notes[i];
      if (note.t > songTime) break;
      if (note.status !== "pending") continue;

      if (mode === "watch") {
        note.status = "auto";
        emit("onAutoNote", note);
      } else if (mode === "perform" && (songTime - note.t) / speed > GAME.windows.good) {
        note.status = "missed";
        note.judgment = "miss";
        stats.miss += 1;
        breakCombo();
        emit("onJudge", note, "miss");
      }
    }
    advancePendingIndex();

    while (backingIndex < backing.length && backing[backingIndex].t <= songTime) {
      emit("onBackingNote", backing[backingIndex]);
      backingIndex += 1;
    }

    if (songTime >= endT + 0.8 && holdingByMidi.size === 0) {
      state = "finished";
      emit("onFinish", getResults());
    }
  }

  function breakCombo() {
    stats.combo = 0;
  }

  function findCandidate(midi, time, lenientOctave) {
    const reach = mode === "practice" ? Math.max(GAME.windows.good * speed, 0.02) : GAME.windows.good * speed;
    let best = null;
    let bestDist = Infinity;
    for (const exact of lenientOctave ? [true, false] : [true]) {
      for (let i = pendingIndex; i < notes.length; i += 1) {
        const note = notes[i];
        if (note.t > time + reach) break;
        if (note.status !== "pending") continue;
        const match = exact ? note.midi === midi : (note.midi - midi) % 12 === 0;
        if (!match) continue;
        const dist = Math.abs(note.t - time);
        if (mode === "perform" && dist > reach) continue;
        if (dist < bestDist) {
          best = note;
          bestDist = dist;
        }
      }
      if (best) break;
    }
    return best;
  }

  function judge(note, time) {
    if (mode === "practice") {
      // Pressed before the tile arrived (or while waiting) counts as on time;
      // a wrong key in this chord downgrades it.
      return clusterHadWrong ? "good" : "perfect";
    }
    const offset = Math.abs(note.t - time) / speed;
    if (offset <= GAME.windows.perfect) return "perfect";
    if (offset <= GAME.windows.great) return "great";
    return "good";
  }

  // Returns "hit" | "wrong" | "ignored".
  function press(midi, now, { lenientOctave = false } = {}) {
    if (state !== "playing" || mode === "watch") return "ignored";
    const time = timeAt(now);
    const note = findCandidate(midi, time, lenientOctave);

    if (!note) {
      stats.wrong += 1;
      clusterHadWrong = true;
      breakCombo();
      emit("onWrong", midi);
      return "wrong";
    }

    const judgment = judge(note, time);
    note.status = "hit";
    note.judgment = judgment;
    note.hitMidi = midi;
    stats[judgment] += 1;
    stats.combo += 1;
    stats.maxCombo = Math.max(stats.maxCombo, stats.combo);
    stats.score += GAME.points[judgment] * multiplier();

    if (note.isHold) {
      note.holding = true;
      holdingByMidi.set(midi, note);
    } else {
      stats.weightSum += GAME.weights[judgment];
    }

    advancePendingIndex();
    emit("onJudge", note, judgment, { combo: stats.combo, multiplier: multiplier() });
    return "hit";
  }

  function finishHold(note, complete) {
    note.holding = false;
    note.holdDone = complete;
    holdingByMidi.delete(note.hitMidi);
    if (complete) {
      note.holdFraction = 1;
      stats.holdsCompleted += 1;
      stats.score += GAME.points.holdBonus * multiplier();
    }
    stats.weightSum += GAME.weights[note.judgment] * (0.5 + 0.5 * note.holdFraction);
    emit("onHoldEnd", note, complete);
  }

  function release(midi, now) {
    const note = holdingByMidi.get(midi);
    if (!note) return;
    const time = timeAt(now);
    note.holdFraction = Math.max(0, Math.min(1, (time - note.t) / note.d));
    finishHold(note, time >= note.t + note.d - GAME.holdReleaseTolerance);
  }

  function getResults() {
    const denominator = stats.total + stats.wrong * GAME.wrongPenaltyWeight;
    const accuracy = denominator > 0 ? Math.min(1, stats.weightSum / denominator) : 0;
    const stars = GAME.stars.filter((threshold) => accuracy >= threshold).length;
    const grade = GAME.grades.find(([threshold]) => accuracy >= threshold)[1];
    return {
      ...stats,
      accuracy,
      stars,
      grade,
      mode,
      playedSeconds: playedRealSeconds,
    };
  }

  function liveAccuracy() {
    const judged = stats.perfect + stats.great + stats.good + stats.miss;
    if (judged === 0 && stats.wrong === 0) return 1;
    const weights = stats.perfect + stats.great * GAME.weights.great + stats.good * GAME.weights.good;
    return weights / (judged + stats.wrong * GAME.wrongPenaltyWeight);
  }

  return {
    notes,
    begin,
    pause,
    resume,
    update,
    press,
    release,
    timeAt,
    getResults,
    liveAccuracy,
    multiplier,
    get stats() {
      return stats;
    },
    get state() {
      return state;
    },
    get songTime() {
      return songTime;
    },
    get waiting() {
      return waiting;
    },
    get progress() {
      return endT > 0 ? Math.max(0, Math.min(1, songTime / endT)) : 0;
    },
    nextNotes() {
      // Pending notes at the earliest upcoming time (the chord to play next).
      const t = nextPendingT();
      if (t === null) return [];
      const chord = [];
      for (let i = pendingIndex; i < notes.length && notes[i].t - t < 0.06; i += 1) {
        if (notes[i].status === "pending") chord.push(notes[i]);
      }
      return chord;
    },
    endT,
    startTime,
    mode,
    speed,
  };
}
