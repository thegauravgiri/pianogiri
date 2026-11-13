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
    // Melody notes are kept as tracked; accompaniment drops quiet or very short blips (drums, noise).
    .filter((n) => n.midi >= 21 && n.midi <= 108 && (n.m ? n.d >= 0.05 : n.d >= 0.08 && (n.a ?? 1) >= minAmplitude))
    .map(({ t, d, midi, v, m }) => (m ? { t, d, midi, v, m: true } : { t, d, midi, v }))
    .sort((a, b) => a.t - b.t);

  if (notes.length > MAX_NOTES) notes = notes.slice(0, MAX_NOTES);

  // Trim leading silence so the first note arrives about a second in.
  // `shift` is kept so the original recording can be played back in sync.
  const shift = notes.length ? Math.max(0, notes[0].t - 1) : 0;
  return { notes: notes.map((n) => ({ ...n, t: n.t - shift })), shift };
}

const MODEL_URLS = {
  tfModule: IMPORT.tfModule,
  basicPitchModule: IMPORT.basicPitchModule,
  basicPitchModel: IMPORT.basicPitchModel,
  ortModule: IMPORT.ortModule,
  ortWasmPaths: IMPORT.ortWasmPaths,
  separatorModel: new URL("../models/spleeter-vocals.fp16.onnx", import.meta.url).href,
};

// One conversion session with the worker. Audio can be appended in pieces;
// each model window runs as soon as its audio is complete.
function openSession({ detail, kind, batch, onStage, onProgress, onLiveSeconds }) {
  if (typeof Worker === "undefined") throw new Error("Your browser can't convert audio. Try a recent Chrome, Edge, Firefox or Safari.");
  const preset = DETAIL_PRESETS[detail] || DETAIL_PRESETS.medium;
  const w = getWorker();
  let settle = null;
  const done = new Promise((resolve, reject) => {
    settle = { resolve, reject };
  });
  w.onmessage = (event) => {
    const msg = event.data;
    if (msg.type === "stage") onStage?.(msg.stage, msg);
    else if (msg.type === "progress") {
      if (msg.percent !== undefined) onProgress?.(msg.percent);
      else onLiveSeconds?.(msg.seconds);
    } else if (msg.type === "done") settle.resolve(msg.notes);
    else if (msg.type === "error") settle.reject(new Error(`Conversion failed: ${msg.message}`));
  };
  w.onerror = (event) => {
    worker = null;
    settle.reject(new Error(`Conversion failed to start: ${event.message || "worker error"}`));
  };
  w.postMessage({ type: "start", urls: MODEL_URLS, options: { ...preset, instrumental: kind === "instrumental" }, capacitySeconds: IMPORT.maxAudioSeconds, batch });

  return {
    append(samples) {
      w.postMessage({ type: "append", samples }); // copied: an AudioBuffer's data can't be transferred
    },
    async finish() {
      w.postMessage({ type: "finish" });
      const { notes, shift } = cleanNotes(await done, preset.minAmplitude);
      if (notes.length === 0) throw new Error("No notes were detected. Try a clearer recording or raise the detail level.");
      return { notes, shift };
    },
    cancel() {
      settle.reject(new Error("cancelled"));
      worker?.terminate();
      worker = null;
    },
  };
}

// Converts an audio file/blob to notes with Basic Pitch in a Web Worker.
// onStage(stage) receives "decode" | "model" | "listen" | "notes"; onProgress(0..1).
// kind: "sung" (singing with music: the melody follows the voice) or
// "instrumental" (piano covers etc.: the melody is the top line).
export async function audioToNotes(blob, { detail = "medium", kind = "sung", onStage, onProgress } = {}) {
  if (typeof OfflineAudioContext === "undefined") {
    throw new Error("Your browser can't convert audio. Try a recent Chrome, Edge, Firefox or Safari.");
  }
  onStage?.("decode");
  const { samples, seconds, trimmed } = await decodeToModelRate(await blob.arrayBuffer());
  const session = openSession({ detail, kind, batch: true, onStage, onProgress });
  session.append(samples);
  const result = await session.finish();
  return { ...result, seconds, trimmed };
}

// Live conversion for audio that's still being recorded (22.05 kHz mono chunks).
// onLiveSeconds(s) reports how much of the recording has already been analysed.
export function createLiveConverter({ detail = "medium", kind = "sung", onStage, onLiveSeconds } = {}) {
  return openSession({ detail, kind, batch: false, onStage, onLiveSeconds });
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
  const tracks = midi.tracks.filter((track) => track.notes.length && track.channel !== 9 && !track.instrument?.percussion); // skip drums
  const melodyTrack = pickMelodyTrack(tracks);
  const notes = [];
  for (const track of tracks) {
    const isMelody = track === melodyTrack;
    const melodyNotes = isMelody ? new Set(skyline(track.notes)) : null;
    for (const n of track.notes) {
      const note = { t: n.time, d: n.duration, midi: n.midi, v: Math.round(n.velocity * 127) };
      if (isMelody && melodyNotes.has(n)) note.m = true;
      notes.push(note);
    }
  }
  const { notes: cleaned } = cleanNotes(notes, 0);
  if (cleaned.length === 0) throw new Error("This MIDI file has no playable piano notes.");
  return { notes: cleaned, title: midi.name || "" };
}

// The melody track: mostly in singing range, mostly one note at a time, and
// the one that plays the most. Single-track files use their top line.
function pickMelodyTrack(tracks) {
  let best = null;
  let bestScore = -Infinity;
  for (const track of tracks) {
    const ns = track.notes;
    const inRange = ns.filter((n) => n.midi >= 55 && n.midi <= 88).length / ns.length;
    const mono = skyline(ns).length / ns.length; // 1 = never plays chords
    const meanPitch = ns.reduce((sum, n) => sum + n.midi, 0) / ns.length;
    const coverage = Math.min(1, ns.reduce((sum, n) => sum + n.duration, 0) / Math.max(1, ns[ns.length - 1].time));
    const nameHint = /melody|lead|vocal|voice|sing|right/i.test(track.name || "") ? 0.5 : 0;
    const score = inRange * 1.5 + mono + coverage + (meanPitch - 60) / 24 + nameHint;
    if (score > bestScore) {
      bestScore = score;
      best = track;
    }
  }
  return best;
}

// Top note of each chord (notes starting within 50 ms).
function skyline(notes) {
  const sorted = [...notes].sort((a, b) => a.time - b.time || b.midi - a.midi);
  const out = [];
  for (const n of sorted) {
    const prev = out[out.length - 1];
    if (prev && n.time - prev.time < 0.05) continue;
    out.push(n);
  }
  return out;
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
