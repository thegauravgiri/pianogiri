import { KEY_CONFIG_BY_CODE, DEFAULT_WINDOW_BASE } from "./config.js";
import { storage } from "./utils.js";

const USER_SONGS_KEY = "pianogiri.userSongs.v1";
const LEGACY_STEP_SECONDS = 0.6;
const LEGACY_NOTE_SECONDS = 0.35;

// Songs are normalised to { id, title, artist, difficulty, source, notes }
// where notes = [{ t, d, midi, v }] sorted by start time (seconds).
//
// Accepted file formats:
//   { sequence: ["KeyA", ...], bpm? }          legacy step-by-step songs
//   { notes: [[t, d, midi, velocity?], ...] }  timed notes (compact)
//   { notes: [{ t, d, midi, v? }, ...] }       timed notes (verbose)
export function normalizeSong(raw, source) {
  if (!raw || typeof raw.id !== "string") {
    throw new Error("Song is missing an id.");
  }

  let notes;
  if (Array.isArray(raw.notes)) {
    notes = raw.notes.map((n) =>
      Array.isArray(n) ? { t: n[0], d: n[1], midi: n[2], v: n[3] ?? 80 } : { t: n.t, d: n.d, midi: n.midi, v: n.v ?? 80 }
    );
  } else if (Array.isArray(raw.sequence)) {
    const step = raw.bpm ? 60 / raw.bpm : LEGACY_STEP_SECONDS;
    notes = raw.sequence
      .map((code, index) => {
        const key = KEY_CONFIG_BY_CODE.get(code);
        return key ? { t: 1 + index * step, d: Math.min(LEGACY_NOTE_SECONDS, step * 0.85), midi: DEFAULT_WINDOW_BASE + key.semitone, v: 85 } : null;
      })
      .filter(Boolean);
  } else {
    throw new Error(`Song ${raw.id} has no notes.`);
  }

  notes = notes
    .filter((n) => Number.isFinite(n.t) && Number.isFinite(n.d) && Number.isFinite(n.midi))
    .map((n) => ({ t: Math.max(0, n.t), d: Math.max(0.05, n.d), midi: Math.round(n.midi), v: n.v }))
    .sort((a, b) => a.t - b.t || a.midi - b.midi);

  const last = notes.reduce((end, n) => Math.max(end, n.t + n.d), 0);

  return {
    id: raw.id,
    title: raw.title || "Untitled",
    artist: raw.artist || "",
    difficulty: raw.difficulty || guessDifficulty(notes, last),
    source,
    createdAt: raw.createdAt || null,
    origin: raw.origin || null,
    hasAudio: Boolean(raw.hasAudio),
    audioOffset: Number(raw.audioOffset) || 0,
    notes,
    duration: last,
  };
}

function guessDifficulty(notes, duration) {
  const density = notes.length / Math.max(1, duration);
  if (density < 1.5) return "Beginner";
  if (density < 3.5) return "Intermediate";
  return "Advanced";
}

function compact(song) {
  return {
    id: song.id,
    title: song.title,
    artist: song.artist,
    difficulty: song.difficulty,
    createdAt: song.createdAt,
    origin: song.origin,
    hasAudio: song.hasAudio,
    audioOffset: round3(song.audioOffset || 0),
    notes: song.notes.map((n) => [round3(n.t), round3(n.d), n.midi, Math.round(n.v ?? 80)]),
  };
}

function round3(x) {
  return Math.round(x * 1000) / 1000;
}

export function createSongService({ manifestPath }) {
  let builtIn = [];
  let user = [];

  async function loadSongs() {
    user = storage
      .get(USER_SONGS_KEY, [])
      .map((raw) => {
        try {
          return normalizeSong(raw, "user");
        } catch (_error) {
          return null;
        }
      })
      .filter(Boolean);

    const manifestResponse = await fetch(manifestPath);
    if (!manifestResponse.ok) {
      throw new Error("Could not load song manifest.");
    }

    const filenames = await manifestResponse.json();
    if (!Array.isArray(filenames)) {
      throw new Error("Song manifest format is invalid.");
    }

    const results = await Promise.allSettled(
      filenames.map(async (filename) => {
        const response = await fetch(`./songs/${filename}`);
        if (!response.ok) {
          throw new Error(`Could not load song file: ${filename}`);
        }
        return normalizeSong(await response.json(), "builtin");
      })
    );

    builtIn = results.filter((r) => r.status === "fulfilled").map((r) => r.value);
  }

  function getAll() {
    return [...user, ...builtIn];
  }

  function getById(id) {
    return getAll().find((song) => song.id === id) || null;
  }

  function persistUserSongs() {
    return storage.set(
      USER_SONGS_KEY,
      user.map((song) => compact(song))
    );
  }

  function addUserSong(song) {
    const normalized = normalizeSong({ ...song, createdAt: song.createdAt || Date.now() }, "user");
    user = [normalized, ...user.filter((s) => s.id !== normalized.id)];
    if (!persistUserSongs()) {
      user = user.filter((s) => s.id !== normalized.id);
      throw new Error("Your browser storage is full. Delete a song from My Songs and try again.");
    }
    return normalized;
  }

  function removeUserSong(id) {
    user = user.filter((s) => s.id !== id);
    persistUserSongs();
  }

  function markNoAudio(id) {
    const song = user.find((s) => s.id === id);
    if (song) {
      song.hasAudio = false;
      persistUserSongs();
    }
  }

  return { loadSongs, getAll, getById, addUserSong, removeUserSong, markNoAudio };
}
