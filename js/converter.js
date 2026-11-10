import { IMPORT } from "./config.js";
import { loadScriptOnce } from "./utils.js";

const MODEL_SAMPLE_RATE = 22050;
const MAX_NOTES = 8000;

// Detail presets for Basic Pitch post-processing.
export const DETAIL_PRESETS = {
  low: { onsetThreshold: 0.6, frameThreshold: 0.35, minNoteFrames: 11, minAmplitude: 0.35 },
  medium: { onsetThreshold: 0.5, frameThreshold: 0.3, minNoteFrames: 8, minAmplitude: 0.25 },
  high: { onsetThreshold: 0.35, frameThreshold: 0.25, minNoteFrames: 5, minAmplitude: 0.15 },
};

let worker = null;

function getWorker() {
  if (!worker) {
    worker = new Worker(new URL("./converterWorker.js", import.meta.url), { type: "module" });
  }
  return worker;
}

async function decodeToModelRate(arrayBuffer) {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  const decoderContext = new AudioCtx();
  let decoded;
  try {
    decoded = await decoderContext.decodeAudioData(arrayBuffer.slice(0));
  } catch (_error) {
    throw new Error("This file couldn't be read as audio. Try an MP3, WAV, M4A or OGG file.");
  } finally {
    decoderContext.close?.();
  }

  const seconds = Math.min(decoded.duration, IMPORT.maxAudioSeconds);
  const offline = new OfflineAudioContext(1, Math.ceil(seconds * MODEL_SAMPLE_RATE), MODEL_SAMPLE_RATE);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start(0);
  const rendered = await offline.startRendering();
  return { samples: rendered.getChannelData(0), seconds, trimmed: decoded.duration > IMPORT.maxAudioSeconds };
}

function cleanNotes(rawNotes, minAmplitude) {
  let notes = rawNotes
    .filter((n) => n.d >= 0.05 && (n.a ?? 1) >= minAmplitude && n.midi >= 21 && n.midi <= 108)
    .map(({ t, d, midi, v }) => ({ t, d, midi, v }))
    .sort((a, b) => a.t - b.t);

  if (notes.length > MAX_NOTES) notes = notes.slice(0, MAX_NOTES);

  // Trim leading silence so the first note arrives about a second in.
  // `shift` is kept so the original recording can be played back in sync.
  const shift = notes.length ? Math.max(0, notes[0].t - 1) : 0;
  return { notes: notes.map((n) => ({ ...n, t: n.t - shift })), shift };
}

// Converts an audio file/blob to notes with Basic Pitch in a Web Worker.
// onStage(stage) receives "decode" | "model" | "listen" | "notes";
// onProgress(0..1) reports model progress.
export async function audioToNotes(blob, { detail = "medium", onStage, onProgress } = {}) {
  if (typeof Worker === "undefined" || typeof OfflineAudioContext === "undefined") {
    throw new Error("Your browser can't convert audio. Try a recent Chrome, Edge, Firefox or Safari.");
  }

  onStage?.("decode");
  const { samples, seconds, trimmed } = await decodeToModelRate(await blob.arrayBuffer());
  const preset = DETAIL_PRESETS[detail] || DETAIL_PRESETS.medium;

  const notes = await new Promise((resolve, reject) => {
    const w = getWorker();
    w.onmessage = (event) => {
      const msg = event.data;
      if (msg.type === "stage") onStage?.(msg.stage, msg);
      else if (msg.type === "progress") onProgress?.(msg.percent);
      else if (msg.type === "done") resolve(msg.notes);
      else if (msg.type === "error") reject(new Error(`Conversion failed: ${msg.message}`));
    };
    w.onerror = (event) => {
      worker = null;
      reject(new Error(`Conversion failed to start: ${event.message || "worker error"}`));
    };
    w.postMessage({
      samples,
      urls: { tfModule: IMPORT.tfModule, basicPitchModule: IMPORT.basicPitchModule, basicPitchModel: IMPORT.basicPitchModel },
      options: preset,
    });
  });

  const { notes: cleaned, shift } = cleanNotes(notes, preset.minAmplitude);
  if (cleaned.length === 0) {
    throw new Error("No notes were detected. Try a clearer recording or raise the detail level.");
  }
  return { notes: cleaned, shift, seconds, trimmed };
}

async function loadMidiLibrary() {
  await loadScriptOnce(IMPORT.midiLibrary);
  if (!window.Midi) throw new Error("The MIDI library failed to load.");
  return window.Midi;
}

export async function midiFileToNotes(blob) {
  const Midi = await loadMidiLibrary();
  let midi;
  try {
    midi = new Midi(await blob.arrayBuffer());
  } catch (_error) {
    throw new Error("This doesn't look like a valid MIDI file.");
  }
  const notes = [];
  for (const track of midi.tracks) {
    if (track.channel === 9 || track.instrument?.percussion) continue; // skip drums
    for (const n of track.notes) {
      notes.push({ t: n.time, d: n.duration, midi: n.midi, v: Math.round(n.velocity * 127) });
    }
  }
  const { notes: cleaned } = cleanNotes(notes, 0);
  if (cleaned.length === 0) throw new Error("This MIDI file has no playable piano notes.");
  return { notes: cleaned, title: midi.name || "" };
}

export async function downloadSongAsMidi(song) {
  const Midi = await loadMidiLibrary();
  const midi = new Midi();
  midi.name = song.title;
  const track = midi.addTrack();
  for (const n of song.notes) {
    track.addNote({ midi: n.midi, time: n.t, duration: n.d, velocity: (n.v ?? 80) / 127 });
  }
  const blob = new Blob([midi.toArray()], { type: "audio/midi" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${song.title.replace(/[^\w\- ]+/g, "").trim() || "song"}.mid`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function isYoutubeUrl(text) {
  return /^(https?:\/\/)?(www\.|m\.|music\.)?(youtube\.com\/(watch\?v=|shorts\/)|youtu\.be\/)[\w-]{6,}/i.test(text.trim());
}
