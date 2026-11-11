import { extractMelody, accompanimentFrom, MELODY_DEFAULTS, MELODY_HYBRID } from "./melody.js";
import { loadSeparatorModel, createVocalSeparator } from "./vocalSeparator.js";

// Runs Spotify's Basic Pitch model (the model behind NeuralNote) off the main
// thread. Audio (mono, 22.05 kHz) can arrive all at once (files) or bit by bit
// while it's being recorded (YouTube tabs): each 2-second model window is run as
// soon as its audio exists, exactly as Basic Pitch would batch it, so a live
// recording is ready the moment it ends and matches a whole-file conversion.
//
// Two passes run side by side:
//   * the full mix  → accompaniment notes (bass, chords) and backup melody evidence
//   * the voice alone (split off with Spleeter) → the melody while someone sings
// If the voice model can't load, the melody comes from the mix alone.
//
// Messages in:  start {urls, options, capacitySeconds, batch} · append {samples} · finish
// Messages out: stage · ready · progress {percent | seconds} · done {notes} · error

const SAMPLE_RATE = 22050;
const FFT_HOP = 256;
const WINDOW = SAMPLE_RATE * 2 - FFT_HOP; // 43,844 samples per model window
const OVERLAP = 30 * FFT_HOP; // 7,680 samples shared by neighbouring windows
const HOP = WINDOW - OVERLAP; // 36,164 new samples per window
const PAD = OVERLAP / 2; // Basic Pitch pads the start with this much silence
const TRIM = 15; // frames trimmed from each side of a window's output
const ANNOTATIONS_FPS = Math.floor(SAMPLE_RATE / FFT_HOP);
const MIX_WEIGHT = 0.35; // share of melody evidence taken from the full mix

let modulesPromise = null;
let separatorPromise = null;
let job = null;

function loadModules(urls) {
  if (!modulesPromise) {
    modulesPromise = Promise.all([import(urls.tfModule), import(urls.basicPitchModule)]).then(async ([tf, bp]) => {
      try {
        await tf.setBackend("webgl");
      } catch (_error) {
        await tf.setBackend("cpu");
      }
      await tf.ready();
      const model = new bp.BasicPitch(urls.basicPitchModel);
      await model.model;
      return { tf, bp, model };
    });
  }
  return modulesPromise;
}

// Resolves to { ort, session, backend } or null when the voice model isn't available.
function loadSeparator(urls) {
  if (!urls.ortModule || !urls.separatorModel) return Promise.resolve(null);
  if (!separatorPromise) {
    separatorPromise = import(urls.ortModule)
      .then(async (ort) => {
        ort.env.wasm.wasmPaths = urls.ortWasmPaths;
        const { session, backend } = await loadSeparatorModel(ort, urls.separatorModel);
        return { ort, session, backend };
      })
      .catch((error) => {
        console.warn("Voice separation unavailable, using the full mix:", error);
        separatorPromise = null; // try again next time
        return null;
      });
  }
  return separatorPromise;
}

function newTrack(capacity) {
  return { audio: new Float32Array(capacity), length: 0, windowsDone: 0, out: [[], [], []] };
}

function appendTo(track, samples) {
  const room = track.audio.length - track.length;
  const chunk = samples.length > room ? samples.subarray(0, room) : samples;
  track.audio.set(chunk, track.length);
  track.length += chunk.length;
}

// Window `index` of the padded signal (PAD zeros, the audio, then zeros).
function windowSamples(track, index) {
  const out = new Float32Array(WINDOW);
  const start = index * HOP - PAD; // position in the unpadded audio
  for (let i = 0; i < WINDOW; i += 1) {
    const j = start + i;
    if (j >= 0 && j < track.length) out[i] = track.audio[j];
  }
  return out;
}

async function runWindow(track, index) {
  const { tf, model } = await job.modules;
  const input = tf.tensor(windowSamples(track, index), [1, WINDOW, 1]);
  const outputs = await model.evaluateSingleFrame(input, 0);
  input.dispose();
  for (let k = 0; k < 3; k += 1) {
    const trimmed = outputs[k].slice([0, TRIM, 0], [-1, outputs[k].shape[1] - 2 * TRIM, -1]);
    const rows = (await trimmed.array())[0];
    trimmed.dispose();
    outputs[k].dispose();
    for (const row of rows) track.out[k].push(row);
  }
  track.windowsDone = index + 1;
}

const windowsFor = (length) => Math.ceil((length + PAD) / HOP);
const readyWindow = (track, final) => (final ? track.windowsDone < windowsFor(track.length) : track.windowsDone * HOP - PAD + WINDOW <= track.length);

// Run every window whose audio is complete (or all remaining ones when finishing).
async function pump(final) {
  const tracks = [job.mix, job.voice].filter(Boolean);
  for (;;) {
    const track = tracks.find((t) => readyWindow(t, final));
    if (!track) break;
    await runWindow(track, track.windowsDone);
    if (job.batch) {
      const total = tracks.reduce((sum, t) => sum + windowsFor(t.length || job.mix.length), 0);
      const done = tracks.reduce((sum, t) => sum + t.windowsDone, 0);
      self.postMessage({ type: "progress", percent: Math.min(1, done / total) });
    } else {
      const analysed = Math.min(...tracks.map((t) => t.windowsDone * HOP - PAD));
      self.postMessage({ type: "progress", seconds: Math.max(0, analysed / SAMPLE_RATE) });
    }
  }
}

// Feed new mix audio to the voice separator; its output goes to the voice track.
async function separate(samples, final) {
  if (!job.separator) return;
  try {
    if (samples.length) appendTo(job.voice, await job.separator.push(samples));
    if (final) appendTo(job.voice, await job.separator.flush());
  } catch (error) {
    console.warn("Voice separation failed, using the full mix:", error);
    job.separator = null;
    job.voice = null;
  }
}

// How much each frame should trust the separated voice (1) or the full mix (0).
// While someone sings, the voice decides: short gaps between phrases stay
// silent instead of picking up band fills. Stretches of 4 s or more with no
// voice at all (intros, solos, instrumental songs) fall back to the mix so the
// lead instrument's tune is still there to play.
const VOICE_PRESENT = 0.15; // voice salience above the separator's noise floor (~0.11)
const MIN_BREAK_FRAMES = 4 * ANNOTATIONS_FPS;
const BRIDGE_FRAMES = 10; // ignore dips shorter than ~0.1 s
const FADE_FRAMES = 20;
function voiceWeights(voiceContours) {
  const lo = (MELODY_DEFAULTS.minMidi - 21) * 3;
  const hi = (MELODY_DEFAULTS.maxMidi - 21) * 3;
  const n = voiceContours.length;
  const level = new Float32Array(n);
  for (let t = 0; t < n; t += 1) {
    const row = voiceContours[t];
    let m = 0;
    for (let k = lo; k <= hi; k += 1) if (row[k] > m) m = row[k];
    level[t] = m;
  }
  const absent = new Uint8Array(n);
  for (let t = 0; t < n; t += 1) {
    let m = 0;
    for (let j = Math.max(0, t - BRIDGE_FRAMES); j <= Math.min(n - 1, t + BRIDGE_FRAMES); j += 1) if (level[j] > m) m = level[j];
    absent[t] = m < VOICE_PRESENT ? 1 : 0;
  }
  const weight = new Float32Array(n).fill(1);
  for (let t = 0; t < n; ) {
    if (!absent[t]) {
      t += 1;
      continue;
    }
    let end = t;
    while (end < n && absent[end]) end += 1;
    if (end - t >= MIN_BREAK_FRAMES) {
      for (let j = t; j < end; j += 1) weight[j] = Math.max(0, 1 - Math.min(j - t, end - 1 - j) / FADE_FRAMES);
    }
    t = end;
  }
  return weight;
}

// Melody evidence: where the voice is trusted, mostly the voice and partly the
// mix (a weighted geometric mean); elsewhere the mix.
function blend(voice, mix, weight) {
  const n = Math.min(voice.length, mix.length);
  const out = new Array(n);
  for (let t = 0; t < n; t += 1) {
    const v = voice[t];
    const m = mix[t];
    const w = weight[t];
    const row = new Float32Array(v.length);
    for (let i = 0; i < row.length; i += 1) row[i] = w * Math.pow(v[i], 1 - MIX_WEIGHT) * Math.pow(m[i], MIX_WEIGHT) + (1 - w) * m[i];
    out[t] = row;
  }
  return out;
}

function buildNotes(bp, options) {
  const nFrames = Math.floor(job.mix.length * (ANNOTATIONS_FPS / SAMPLE_RATE));
  const [frames, onsets, contours] = job.mix.out.map((rows) => rows.slice(0, nFrames));
  let melody;
  if (job.voice) {
    const [, vOnsets, vContours] = job.voice.out.map((rows) => rows.slice(0, nFrames));
    const weight = voiceWeights(vContours);
    melody = extractMelody(blend(vContours, contours, weight), blend(vOnsets, onsets, weight), MELODY_HYBRID);
  } else {
    melody = extractMelody(contours, onsets);
  }
  const poly = bp
    .noteFramesToTime(
      bp.addPitchBendsToNoteEvents(
        contours,
        bp.outputToNotesPoly(frames, onsets, options.onsetThreshold, options.frameThreshold, options.minNoteFrames, true, 4186, 27.5, true)
      )
    )
    .map((n) => ({ t: n.startTimeSeconds, d: n.durationSeconds, midi: n.pitchMidi, v: Math.round(40 + Math.min(1, n.amplitude) * 87), a: n.amplitude }))
    .sort((a, b) => a.t - b.t);
  return [...melody, ...accompanimentFrom(poly, melody)];
}

async function handle(msg) {
  if (msg.type === "start") {
    const capacity = Math.ceil((msg.capacitySeconds || 480) * SAMPLE_RATE);
    job = {
      mix: newTrack(capacity),
      voice: null,
      separator: null,
      options: msg.options,
      batch: Boolean(msg.batch),
      modules: loadModules(msg.urls),
    };
    const current = job;
    self.postMessage({ type: "stage", stage: "model" });
    const [{ tf }, sep] = await Promise.all([current.modules, loadSeparator(msg.urls)]);
    if (job !== current) return;
    if (sep) {
      current.voice = newTrack(capacity);
      current.separator = createVocalSeparator(sep.ort, sep.session);
    }
    self.postMessage({ type: "stage", stage: "listen", backend: tf.getBackend(), voice: sep?.backend || null });
    self.postMessage({ type: "ready" });
  } else if (msg.type === "append") {
    if (!job) return;
    appendTo(job.mix, msg.samples);
    if (!job.batch) {
      await separate(msg.samples, false);
      await pump(false);
    }
  } else if (msg.type === "finish") {
    if (!job) return;
    const current = job;
    const { bp } = await current.modules;
    if (current.batch) {
      await separate(current.mix.audio.subarray(0, current.mix.length), true);
    } else {
      await separate(new Float32Array(0), true);
    }
    await pump(true);
    self.postMessage({ type: "stage", stage: "notes" });
    const notes = buildNotes(bp, current.options);
    job = null;
    self.postMessage({ type: "done", notes });
  }
}

// Messages are handled strictly one after another: appends can arrive while the
// models are still busy with earlier audio.
let queue = Promise.resolve();
self.onmessage = (event) => {
  const msg = event.data;
  queue = queue
    .then(() => handle(msg))
    .catch((error) => {
      job = null;
      self.postMessage({ type: "error", message: error?.message || String(error) });
    });
};
