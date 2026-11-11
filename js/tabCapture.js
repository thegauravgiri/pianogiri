// Records the audio of another browser tab (e.g. a YouTube video) with
// getDisplayMedia. Everything stays in the browser; nothing is downloaded
// from YouTube. Works in desktop Chrome and Edge, which can share tab audio.
//
// Audio is tapped as raw samples at 22.05 kHz (the note model's rate) and
// passed through a gate before anyone sees it:
//   * nothing is kept until the music starts (ads/pauses before it are skipped
//     as long as they're silent),
//   * silences longer than MAX_GAP (pauses, buffering) are shortened to MAX_GAP,
//   * FINISH_AFTER seconds of continuous silence ends the recording.
// The live note converter and the saved song audio get the same gated samples,
// so notes and play-along music line up exactly.
import { IMPORT } from "./config.js";

export const CAPTURE_RATE = 22050;
const CHUNK = 2048; // samples per worklet message (~93 ms)
const SOUND_RMS = 0.003; // above this counts as music
const SILENCE_RMS = 0.0015; // below this counts as silence (a paused video is ~0)
const MAX_GAP = 2; // seconds of silence kept inside the song
const PRE_ROLL = 0.25; // seconds kept from just before the music starts
export const FINISH_AFTER = 8; // seconds of silence that end the recording

const WORKLET = `
class PgTap extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(${CHUNK}); this.n = 0; }
  process(inputs) {
    const input = inputs[0];
    if (input && input.length) {
      const frames = input[0].length, channels = input.length;
      for (let i = 0; i < frames; i++) {
        let v = 0;
        for (let c = 0; c < channels; c++) v += input[c][i];
        this.buf[this.n++] = v / channels;
        if (this.n === this.buf.length) { this.port.postMessage(this.buf, [this.buf.buffer]); this.buf = new Float32Array(${CHUNK}); this.n = 0; }
      }
    }
    return true;
  }
}
registerProcessor("pg-tap", PgTap);`;

export function tabCaptureSupport() {
  const hasApi = Boolean(navigator.mediaDevices?.getDisplayMedia) && typeof AudioWorkletNode !== "undefined";
  const mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || navigator.userAgentData?.mobile;
  const chromium = Boolean(navigator.userAgentData?.brands?.some((b) => /Chromium|Google Chrome|Microsoft Edge/.test(b.brand)));
  if (!hasApi || mobile) return { ok: false, reason: "Recording from a YouTube tab needs Chrome or Edge on a computer." };
  if (!chromium) return { ok: false, reason: "Your browser can't share a tab's audio. Use Chrome or Edge on a computer, or upload an audio file." };
  return { ok: true };
}

// Must be called straight from a click: the audio context is created before
// the share picker opens so the browser lets it run.
// Callbacks: onPcm(Float32Array) gated audio · onLevel(0..1) · onTick({ recorded, silentFor, waiting }).
// Returns { stop(), keepWaiting(), done: Promise<{ wav: Blob, seconds }> }.
export async function startTabCapture({ onPcm, onLevel, onTick } = {}) {
  const ctx = new AudioContext({ sampleRate: CAPTURE_RATE });
  // After sharing, take the user straight to the video so they can press play.
  const focus = typeof CaptureController !== "undefined" ? new CaptureController() : undefined;
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      controller: focus,
      video: { displaySurface: "browser", frameRate: 1, width: 320, height: 180 },
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, suppressLocalAudioPlayback: false },
      preferCurrentTab: false,
      selfBrowserSurface: "exclude",
      surfaceSwitching: "exclude",
      systemAudio: "exclude",
      monitorTypeSurfaces: "exclude",
    });
  } catch (error) {
    ctx.close();
    if (error?.name === "NotAllowedError") throw new Error("Sharing was cancelled. Click Record and pick the YouTube tab.");
    throw new Error("Couldn't start tab sharing in this browser.");
  }

  try {
    focus?.setFocusBehavior?.("focus-captured-surface");
  } catch (_error) {
    // Too late or unsupported: Chrome's default also switches to the shared tab.
  }

  const audioTracks = stream.getAudioTracks();
  if (!audioTracks.length) {
    stream.getTracks().forEach((t) => t.stop());
    ctx.close();
    throw new Error("No audio was shared. Pick the YouTube tab and keep “Also share tab audio” switched on.");
  }

  const moduleUrl = URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" }));
  await ctx.audioWorklet.addModule(moduleUrl);
  URL.revokeObjectURL(moduleUrl);
  if (ctx.state !== "running") await ctx.resume().catch(() => {});

  const source = ctx.createMediaStreamSource(new MediaStream(audioTracks));
  const tap = new AudioWorkletNode(ctx, "pg-tap", { numberOfOutputs: 1, outputChannelCount: [1] });
  const mute = ctx.createGain();
  mute.gain.value = 0; // keep the graph running without playing the tab twice
  source.connect(tap);
  tap.connect(mute);
  mute.connect(ctx.destination);

  const kept = []; // gated chunks, for the saved song audio
  let keptSamples = 0;
  let started = false;
  let silentSamples = 0; // current run of silence
  let finishAt = FINISH_AFTER;
  const preRoll = [];
  let stopped = false;
  let settle;
  const done = new Promise((resolve, reject) => {
    settle = { resolve, reject };
  });

  function keep(chunk) {
    if (keptSamples >= IMPORT.maxAudioSeconds * CAPTURE_RATE) return finish();
    kept.push(chunk);
    keptSamples += chunk.length;
    onPcm?.(chunk.slice());
  }

  tap.port.onmessage = (event) => {
    if (stopped) return;
    const chunk = event.data;
    let sum = 0;
    for (let i = 0; i < chunk.length; i += 1) sum += chunk[i] * chunk[i];
    const rms = Math.sqrt(sum / chunk.length);
    onLevel?.(Math.min(1, rms * 6));

    if (!started) {
      if (rms >= SOUND_RMS) {
        started = true;
        preRoll.forEach(keep);
        preRoll.length = 0;
        keep(chunk);
      } else {
        preRoll.push(chunk);
        while (preRoll.length * CHUNK > PRE_ROLL * CAPTURE_RATE) preRoll.shift();
      }
    } else if (rms < SILENCE_RMS) {
      silentSamples += chunk.length;
      if (silentSamples <= MAX_GAP * CAPTURE_RATE) keep(chunk); // short rests are part of the song
      if (silentSamples >= finishAt * CAPTURE_RATE) return finish();
    } else {
      silentSamples = 0;
      finishAt = FINISH_AFTER;
      keep(chunk);
    }
    onTick?.({ recorded: keptSamples / CAPTURE_RATE, silentFor: started ? silentSamples / CAPTURE_RATE : 0, finishAt, waiting: !started });
  };

  // The user pressed Chrome's own "Stop sharing" button.
  audioTracks[0].addEventListener("ended", () => finish());

  function finish() {
    if (stopped) return;
    stopped = true;
    stream.getTracks().forEach((t) => t.stop());
    tap.port.onmessage = null;
    ctx.close();
    if (!started || keptSamples < CAPTURE_RATE) {
      settle.reject(new Error("No music was recorded. Make sure the video was playing and its tab audio was shared."));
      return;
    }
    // Drop the silence at the very end.
    let total = keptSamples - Math.min(silentSamples, MAX_GAP * CAPTURE_RATE);
    total = Math.max(CAPTURE_RATE, total);
    settle.resolve({ wav: encodeWav(kept, total), seconds: total / CAPTURE_RATE });
  }

  return {
    stop: finish,
    keepWaiting() {
      finishAt = silentSamples / CAPTURE_RATE + FINISH_AFTER;
    },
    done,
  };
}

// 16-bit mono WAV of the first `total` samples.
function encodeWav(chunks, total) {
  const buffer = new ArrayBuffer(44 + total * 2);
  const view = new DataView(buffer);
  const text = (offset, s) => [...s].forEach((ch, i) => view.setUint8(offset + i, ch.charCodeAt(0)));
  text(0, "RIFF");
  view.setUint32(4, 36 + total * 2, true);
  text(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, CAPTURE_RATE, true);
  view.setUint32(28, CAPTURE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, total * 2, true);
  let offset = 44;
  let written = 0;
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length && written < total; i += 1, written += 1) {
      const v = Math.max(-1, Math.min(1, chunk[i]));
      view.setInt16(offset, v < 0 ? v * 0x8000 : v * 0x7fff, true);
      offset += 2;
    }
  }
  return new Blob([buffer], { type: "audio/wav" });
}

// Title and channel for a YouTube link (oEmbed allows cross-site requests).
export async function youtubeTitle(url) {
  try {
    const response = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`);
    if (!response.ok) return null;
    const data = await response.json();
    return { title: data.title || "", artist: data.author_name || "" };
  } catch (_error) {
    return null;
  }
}
