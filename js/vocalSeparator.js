// Pulls the singing voice out of a mix with Deezer's Spleeter (2-stem vocal
// model, MIT licence) running on onnxruntime-web. The note model hears a voice
// much more clearly once the band is gone, so the melody tracker gets far fewer
// accompaniment notes.
//
// Spleeter works on 44.1 kHz audio with a 4096-point STFT (hop 1024), using the
// first 1024 frequency bins (0–11 kHz). Our audio is 22.05 kHz, where a
// 2048-point STFT (hop 512) gives exactly the same bins and frame times, so no
// resampling is needed. Magnitudes are doubled to match the larger window's scale.
//
// Streaming: push() takes audio as it arrives and returns the vocal samples that
// are final so far. The model runs once per 512 frames (~11.9 s of audio).

const N_FFT = 2048;
const HOP = 512;
const BINS = 1024; // bins the model sees (0–11 kHz)
const BLOCK = 512; // frames per model run
const HALF = N_FFT / 2;

// Periodic Hann window.
const WINDOW = new Float32Array(N_FFT);
for (let i = 0; i < N_FFT; i += 1) WINDOW[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N_FFT);

// Radix-2 complex FFT, in place. sign = -1 forward, +1 inverse (unscaled).
const LOG2 = Math.log2(N_FFT);
const REV = new Uint32Array(N_FFT);
for (let i = 0; i < N_FFT; i += 1) {
  let r = 0;
  for (let b = 0; b < LOG2; b += 1) r |= ((i >> b) & 1) << (LOG2 - 1 - b);
  REV[i] = r;
}
const COS = new Float64Array(HALF);
const SIN = new Float64Array(HALF);
for (let i = 0; i < HALF; i += 1) {
  COS[i] = Math.cos((2 * Math.PI * i) / N_FFT);
  SIN[i] = Math.sin((2 * Math.PI * i) / N_FFT);
}
function fft(re, im, sign) {
  for (let i = 0; i < N_FFT; i += 1) {
    const j = REV[i];
    if (j > i) {
      let t = re[i];
      re[i] = re[j];
      re[j] = t;
      t = im[i];
      im[i] = im[j];
      im[j] = t;
    }
  }
  for (let size = 2; size <= N_FFT; size <<= 1) {
    const half = size >> 1;
    const step = N_FFT / size;
    for (let start = 0; start < N_FFT; start += size) {
      for (let k = 0; k < half; k += 1) {
        const wr = COS[k * step];
        const wi = sign * SIN[k * step];
        const a = start + k;
        const b = a + half;
        const xr = re[b] * wr - im[b] * wi;
        const xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
      }
    }
  }
}

export async function loadSeparatorModel(ort, url) {
  ort.env.wasm.numThreads = 1; // threads need cross-origin isolation, which static hosting can't give
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Vocal model download failed (${response.status})`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const providers = typeof navigator !== "undefined" && navigator.gpu ? [["webgpu"], ["wasm"]] : [["wasm"]];
  let lastError;
  for (const executionProviders of providers) {
    try {
      const session = await ort.InferenceSession.create(bytes, { executionProviders, graphOptimizationLevel: "all" });
      return { session, backend: executionProviders[0] };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

export function createVocalSeparator(ort, session) {
  // Input audio, kept from the first sample any pending frame still needs.
  let input = new Float32Array(1 << 18);
  let inputStart = -HALF; // absolute index of input[0] (centre padding = HALF zeros)
  let inputLength = HALF; // starts with the padding zeros
  let framesMade = 0; // STFT frames computed so far
  let totalSamples = 0;

  // Spectra of the current block.
  const mags = new Float32Array(BLOCK * BINS);
  const specRe = new Float32Array(BLOCK * (HALF + 1));
  const specIm = new Float32Array(BLOCK * (HALF + 1));
  let blockFrames = 0;

  // Overlap-add output, indexed from outStart (absolute sample index, may be negative).
  let out = new Float32Array(1 << 18);
  let norm = new Float32Array(1 << 18);
  let outStart = -HALF;
  let emitted = 0; // absolute index of the next vocal sample to hand out

  const re = new Float64Array(N_FFT);
  const im = new Float64Array(N_FFT);

  function ensureOut(endAbs) {
    const need = endAbs - outStart;
    if (need <= out.length) return;
    let size = out.length;
    while (size < need) size *= 2;
    const o = new Float32Array(size);
    o.set(out);
    out = o;
    const n = new Float32Array(size);
    n.set(norm);
    norm = n;
  }

  function appendInput(samples) {
    if (inputLength + samples.length > input.length) {
      let size = input.length;
      while (size < inputLength + samples.length) size *= 2;
      const next = new Float32Array(size);
      next.set(input.subarray(0, inputLength));
      input = next;
    }
    input.set(samples, inputLength);
    inputLength += samples.length;
  }

  // Compute every STFT frame whose samples are all present (or all, padded with zeros, when final).
  async function makeFrames(final) {
    for (;;) {
      const startAbs = framesMade * HOP - HALF;
      const endAbs = startAbs + N_FFT;
      const haveUntil = inputStart + inputLength;
      if (!final && endAbs > haveUntil) break;
      if (final && startAbs >= totalSamples) break;
      const offset = startAbs - inputStart;
      for (let i = 0; i < N_FFT; i += 1) {
        const j = offset + i;
        re[i] = (j < inputLength ? input[j] : 0) * WINDOW[i];
        im[i] = 0;
      }
      fft(re, im, -1);
      const base = blockFrames * (HALF + 1);
      for (let k = 0; k <= HALF; k += 1) {
        specRe[base + k] = re[k];
        specIm[base + k] = im[k];
      }
      const mbase = blockFrames * BINS;
      for (let k = 0; k < BINS; k += 1) mags[mbase + k] = 2 * Math.hypot(re[k], im[k]);
      framesMade += 1;
      blockFrames += 1;
      if (blockFrames === BLOCK) await runBlock();
      // Drop input no future frame needs.
      const keepFrom = framesMade * HOP - HALF - inputStart;
      if (keepFrom > 1 << 16) {
        input.copyWithin(0, keepFrom, inputLength);
        inputLength -= keepFrom;
        inputStart += keepFrom;
      }
    }
    if (final && blockFrames) await runBlock();
  }

  async function runBlock() {
    const frames = blockFrames;
    // Model input: [channels=2, splits=1, 512, 1024]; mono goes in both channels.
    const x = new Float32Array(2 * BLOCK * BINS);
    x.set(mags.subarray(0, frames * BINS), 0);
    x.set(mags.subarray(0, frames * BINS), BLOCK * BINS);
    const feeds = { [session.inputNames[0]]: new ort.Tensor("float32", x, [2, 1, BLOCK, BINS]) };
    const result = await session.run(feeds);
    const y = result[session.outputNames[0]].data;
    const firstFrame = framesMade - frames;
    for (let f = 0; f < frames; f += 1) {
      const sbase = f * (HALF + 1);
      for (let k = 0; k <= HALF; k += 1) {
        let mask = 0;
        if (k < BINS) {
          const v = 0.5 * (y[f * BINS + k] + y[BLOCK * BINS + f * BINS + k]);
          const m = mags[f * BINS + k];
          mask = m > 1e-8 ? Math.min(1, Math.max(0, v / m)) : 0;
        }
        re[k] = specRe[sbase + k] * mask;
        im[k] = specIm[sbase + k] * mask;
      }
      for (let k = 1; k < HALF; k += 1) {
        re[N_FFT - k] = re[k];
        im[N_FFT - k] = -im[k];
      }
      fft(re, im, 1);
      const startAbs = (firstFrame + f) * HOP - HALF;
      ensureOut(startAbs + N_FFT);
      const o = startAbs - outStart;
      for (let i = 0; i < N_FFT; i += 1) {
        out[o + i] += (re[i] / N_FFT) * WINDOW[i];
        norm[o + i] += WINDOW[i] * WINDOW[i];
      }
    }
    blockFrames = 0;
  }

  // Vocal samples that no future frame will touch.
  function take(final) {
    // Frames still waiting for the model haven't been added to the output yet.
    const readyUntil = final ? totalSamples : Math.min(totalSamples, (framesMade - blockFrames) * HOP - HALF);
    if (readyUntil <= emitted) return new Float32Array(0);
    const chunk = new Float32Array(readyUntil - emitted);
    for (let i = 0; i < chunk.length; i += 1) {
      const j = emitted + i - outStart;
      chunk[i] = norm[j] > 1e-6 ? out[j] / norm[j] : 0;
    }
    emitted = readyUntil;
    // Drop finished output.
    const drop = emitted - HALF - outStart;
    if (drop > 1 << 16) {
      out.copyWithin(0, drop);
      out.fill(0, out.length - drop);
      norm.copyWithin(0, drop);
      norm.fill(0, norm.length - drop);
      outStart += drop;
    }
    return chunk;
  }

  return {
    async push(samples) {
      appendInput(samples);
      totalSamples += samples.length;
      await makeFrames(false);
      return take(false);
    },
    async flush() {
      await makeFrames(true);
      return take(true);
    },
  };
}
