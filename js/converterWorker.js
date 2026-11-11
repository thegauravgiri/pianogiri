import { extractMelody, accompanimentFrom } from "./melody.js";

// Runs Spotify's Basic Pitch model (the model behind NeuralNote) off the main
// thread. Audio (mono, 22.05 kHz) can arrive all at once (files) or bit by bit
// while it's being recorded (YouTube tabs): each 2-second model window is run as
// soon as its audio exists, exactly as Basic Pitch would batch it, so a live
// recording is ready the moment it ends and matches a whole-file conversion.
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

let modulesPromise = null;
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

// Window `index` of the padded signal (PAD zeros, the audio, then zeros).
function windowSamples(audio, length, index) {
  const out = new Float32Array(WINDOW);
  const start = index * HOP - PAD; // position in the unpadded audio
  for (let i = 0; i < WINDOW; i += 1) {
    const j = start + i;
    if (j >= 0 && j < length) out[i] = audio[j];
  }
  return out;
}

async function runWindow(index) {
  const { tf, model } = await job.modules;
  const input = tf.tensor(windowSamples(job.audio, job.length, index), [1, WINDOW, 1]);
  const outputs = await model.evaluateSingleFrame(input, 0);
  input.dispose();
  for (let k = 0; k < 3; k += 1) {
    const trimmed = outputs[k].slice([0, TRIM, 0], [-1, outputs[k].shape[1] - 2 * TRIM, -1]);
    const rows = (await trimmed.array())[0];
    trimmed.dispose();
    outputs[k].dispose();
    for (const row of rows) job.out[k].push(row);
  }
  job.windowsDone = index + 1;
}

// Run every window whose audio is complete (or all remaining ones when finishing).
async function pump(final) {
  while (job.pumping) await job.pumping;
  job.pumping = (async () => {
    for (;;) {
      const next = job.windowsDone;
      const total = Math.ceil((job.length + PAD) / HOP);
      const needed = next * HOP - PAD + WINDOW; // audio samples this window covers
      if (final ? next >= total : needed > job.length) break;
      await runWindow(next);
      self.postMessage(
        job.batch
          ? { type: "progress", percent: Math.min(1, job.windowsDone / total) }
          : { type: "progress", seconds: Math.max(0, (job.windowsDone * HOP - PAD) / SAMPLE_RATE) }
      );
    }
  })();
  try {
    await job.pumping;
  } finally {
    job.pumping = null;
  }
}

function buildNotes(bp, options) {
  const nFrames = Math.floor(job.length * (ANNOTATIONS_FPS / SAMPLE_RATE));
  const [frames, onsets, contours] = job.out.map((rows) => rows.slice(0, nFrames));
  // Track the melody first, on the raw model output (the note builder may adjust it in place).
  const melody = extractMelody(contours, onsets);
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

self.onmessage = async (event) => {
  const msg = event.data;
  try {
    if (msg.type === "start") {
      job = {
        audio: new Float32Array(Math.ceil((msg.capacitySeconds || 480) * SAMPLE_RATE)),
        length: 0,
        windowsDone: 0,
        out: [[], [], []],
        options: msg.options,
        batch: Boolean(msg.batch),
        pumping: null,
        modules: loadModules(msg.urls),
      };
      self.postMessage({ type: "stage", stage: "model" });
      const { tf } = await job.modules;
      self.postMessage({ type: "stage", stage: "listen", backend: tf.getBackend() });
      self.postMessage({ type: "ready" });
    } else if (msg.type === "append") {
      if (!job) return;
      const room = job.audio.length - job.length;
      const chunk = msg.samples.length > room ? msg.samples.subarray(0, room) : msg.samples;
      job.audio.set(chunk, job.length);
      job.length += chunk.length;
      if (!job.batch) {
        await job.modules;
        if (job) await pump(false);
      }
    } else if (msg.type === "finish") {
      if (!job) return;
      const current = job;
      const { bp } = await current.modules;
      await pump(true);
      self.postMessage({ type: "stage", stage: "notes" });
      const notes = buildNotes(bp, current.options);
      job = null;
      self.postMessage({ type: "done", notes });
    }
  } catch (error) {
    job = null;
    self.postMessage({ type: "error", message: error?.message || String(error) });
  }
};
