// Records the audio of another browser tab (e.g. a YouTube video) with
// getDisplayMedia. Everything stays in the browser; nothing is downloaded
// from YouTube. Works in desktop Chrome and Edge, which can share tab audio.
import { IMPORT } from "./config.js";

const SILENCE_RMS = 0.004; // below this counts as silence
const SILENCE_STOP_SECONDS = 5; // after music has played, this much silence ends the recording

export function tabCaptureSupport() {
  const hasApi = Boolean(navigator.mediaDevices?.getDisplayMedia) && typeof MediaRecorder !== "undefined";
  const mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || navigator.userAgentData?.mobile;
  const chromium = Boolean(navigator.userAgentData?.brands?.some((b) => /Chromium|Google Chrome|Microsoft Edge/.test(b.brand)));
  if (!hasApi || mobile) return { ok: false, reason: "Recording from a YouTube tab needs Chrome or Edge on a computer." };
  if (!chromium) return { ok: false, reason: "Your browser can't share a tab's audio. Use Chrome or Edge on a computer, or upload an audio file." };
  return { ok: true };
}

// Starts a capture. Resolves once the user has picked a tab with audio.
// Returns { stop(), done: Promise<Blob> }. Callbacks: onTick(seconds), onLevel(0..1), onAutoStop(reason).
export async function startTabCapture({ onTick, onLevel, onAutoStop } = {}) {
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: "browser", frameRate: 1, width: 320, height: 180 },
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, suppressLocalAudioPlayback: false },
      preferCurrentTab: false,
      selfBrowserSurface: "exclude",
      surfaceSwitching: "exclude",
      systemAudio: "exclude",
      monitorTypeSurfaces: "exclude",
    });
  } catch (error) {
    if (error?.name === "NotAllowedError") throw new Error("Sharing was cancelled. Click “Share & record” and pick the YouTube tab.");
    throw new Error("Couldn't start tab sharing in this browser.");
  }

  const audioTracks = stream.getAudioTracks();
  if (!audioTracks.length) {
    stream.getTracks().forEach((t) => t.stop());
    throw new Error("No audio was shared. Pick the YouTube tab and keep “Also share tab audio” switched on.");
  }

  const audioStream = new MediaStream(audioTracks);
  const mimeType = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((t) => MediaRecorder.isTypeSupported(t)) || "";
  const recorder = new MediaRecorder(audioStream, mimeType ? { mimeType, audioBitsPerSecond: 128000 } : undefined);
  const chunks = [];
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);

  // Level meter + silence detection on the shared audio.
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const source = ctx.createMediaStreamSource(audioStream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  source.connect(analyser);
  const buf = new Float32Array(analyser.fftSize);

  const started = performance.now();
  let heardMusic = false;
  let silentSince = null;
  let stopped = false;

  const done = new Promise((resolve, reject) => {
    recorder.onstop = () => {
      cleanup();
      const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
      if (!heardMusic || blob.size < 2000) reject(new Error("No sound was recorded. Make sure the video was playing and its tab audio was shared."));
      else resolve(blob);
    };
    recorder.onerror = () => {
      cleanup();
      reject(new Error("Recording failed."));
    };
  });

  const timer = setInterval(() => {
    const seconds = (performance.now() - started) / 1000;
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i += 1) sum += buf[i] * buf[i];
    const rms = Math.sqrt(sum / buf.length);
    onLevel?.(Math.min(1, rms * 6));
    onTick?.(seconds);

    if (rms > SILENCE_RMS) {
      heardMusic = true;
      silentSince = null;
    } else if (heardMusic) {
      silentSince ??= seconds;
      if (seconds - silentSince >= SILENCE_STOP_SECONDS) autoStop("ended");
    }
    if (seconds >= IMPORT.maxAudioSeconds) autoStop("limit");
  }, 200);

  // The user pressed Chrome's own "Stop sharing" button.
  audioTracks[0].addEventListener("ended", () => autoStop("unshared"));

  function autoStop(reason) {
    if (stopped) return;
    onAutoStop?.(reason);
    stop();
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    if (recorder.state !== "inactive") recorder.stop();
    else cleanup();
  }

  function cleanup() {
    clearInterval(timer);
    stream.getTracks().forEach((t) => t.stop());
    ctx.close?.();
  }

  recorder.start(1000);
  return { stop, done };
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
