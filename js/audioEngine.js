import { MIN_MIDI, MAX_MIDI } from "./config.js";
import { clamp } from "./utils.js";

const SAMPLE_URLS = {
  A0: "A0.mp3",
  C1: "C1.mp3",
  "D#1": "Ds1.mp3",
  "F#1": "Fs1.mp3",
  A1: "A1.mp3",
  C2: "C2.mp3",
  "D#2": "Ds2.mp3",
  "F#2": "Fs2.mp3",
  A2: "A2.mp3",
  C3: "C3.mp3",
  "D#3": "Ds3.mp3",
  "F#3": "Fs3.mp3",
  A3: "A3.mp3",
  C4: "C4.mp3",
  "D#4": "Ds4.mp3",
  "F#4": "Fs4.mp3",
  A4: "A4.mp3",
  C5: "C5.mp3",
  "D#5": "Ds5.mp3",
  "F#5": "Fs5.mp3",
  A5: "A5.mp3",
  C6: "C6.mp3",
  "D#6": "Ds6.mp3",
  "F#6": "Fs6.mp3",
  A6: "A6.mp3",
  C7: "C7.mp3",
  "D#7": "Ds7.mp3",
  "F#7": "Fs7.mp3",
  A7: "A7.mp3",
  C8: "C8.mp3",
};

// MIDI-number based piano. Live (player) voices and automatic (backing /
// demo) voices are tracked separately so they never cut each other off.
export function createAudioEngine() {
  const liveVoices = new Map(); // midi -> note name currently held by the player
  const sustainedMidis = new Set();

  let loadPromise = null;
  let ready = false;
  let sampler = null;
  let velocity = 98;
  let sustainOn = false;

  function hasTone() {
    return typeof Tone !== "undefined";
  }

  function noteName(midi) {
    return Tone.Frequency(clamp(midi, MIN_MIDI, MAX_MIDI), "midi").toNote();
  }

  function gainFor(velocityValue) {
    return clamp(Math.pow(velocityValue / 127, 1.5), 0.05, 1);
  }

  function init() {
    if (loadPromise) {
      return loadPromise;
    }

    if (!hasTone()) {
      loadPromise = Promise.resolve();
      return loadPromise;
    }

    loadPromise = new Promise((resolve) => {
      Tone.Destination.volume.value = -3;
      Tone.context.lookAhead = 0;
      Tone.context.updateInterval = 0.01;

      const limiter = new Tone.Limiter(-1).toDestination();
      const compressor = new Tone.Compressor({ threshold: -18, ratio: 3, attack: 0.003, release: 0.2 });
      const eq = new Tone.EQ3({ low: -1.8, mid: 0.9, high: 1.8 });
      const reverb = new Tone.Reverb({ decay: 2.8, preDelay: 0.012, wet: 0.2 });

      eq.connect(compressor);
      compressor.connect(reverb);
      reverb.connect(limiter);

      sampler = new Tone.Sampler({
        urls: SAMPLE_URLS,
        release: 1.4,
        baseUrl: "https://tonejs.github.io/audio/salamander/",
        onload: () => {
          ready = true;
          resolve();
        },
        onerror: () => resolve(),
      }).connect(eq);
    });

    return loadPromise;
  }

  async function resume() {
    if (!hasTone()) {
      return;
    }

    if (Tone.context.state !== "running") {
      await Tone.start();
    }
    await init();
  }

  function isReady() {
    return ready;
  }

  function noteOn(midi, velocityOverride) {
    if (!ready || !sampler || liveVoices.has(midi)) {
      return;
    }

    sustainedMidis.delete(midi);
    const name = noteName(midi);
    sampler.triggerAttack(name, undefined, gainFor(velocityOverride ?? velocity));
    liveVoices.set(midi, name);
  }

  function noteOff(midi) {
    const name = liveVoices.get(midi);
    if (!name) {
      return;
    }

    if (sustainOn) {
      sustainedMidis.add(midi);
      return;
    }

    sampler.triggerRelease(name);
    liveVoices.delete(midi);
  }

  // Fire-and-forget note for backing tracks and demo playback.
  function playNote(midi, durationSeconds, velocityValue = 80) {
    if (!ready || !sampler) {
      return;
    }

    sampler.triggerAttackRelease(noteName(midi), Math.max(0.08, durationSeconds), undefined, gainFor(velocityValue));
  }

  function releaseSustained() {
    for (const midi of sustainedMidis) {
      const name = liveVoices.get(midi);
      if (name && sampler) {
        sampler.triggerRelease(name);
      }
      liveVoices.delete(midi);
    }
    sustainedMidis.clear();
  }

  function panic() {
    if (sampler) {
      sampler.releaseAll();
    }
    liveVoices.clear();
    sustainedMidis.clear();
  }

  function setSustain(on) {
    sustainOn = on;
    if (!sustainOn) {
      releaseSustained();
    }
  }

  return {
    init,
    resume,
    isReady,
    noteOn,
    noteOff,
    playNote,
    panic,
    toggleSustain: () => setSustain(!sustainOn),
    isSustainOn: () => sustainOn,
    changeVelocity: (delta) => {
      velocity = clamp(velocity + delta, 20, 127);
    },
    getVelocity: () => velocity,
  };
}
