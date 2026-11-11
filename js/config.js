// Computer-keyboard layout: 18 keys covering one and a half octaves (C to F).
// `semitone` is the offset from the window's base C.
export const WHITE_KEYS = [
  { code: "KeyA", label: "A", semitone: 0 },
  { code: "KeyS", label: "S", semitone: 2 },
  { code: "KeyD", label: "D", semitone: 4 },
  { code: "KeyF", label: "F", semitone: 5 },
  { code: "KeyG", label: "G", semitone: 7 },
  { code: "KeyH", label: "H", semitone: 9 },
  { code: "KeyJ", label: "J", semitone: 11 },
  { code: "KeyK", label: "K", semitone: 12 },
  { code: "KeyL", label: "L", semitone: 14 },
  { code: "Semicolon", label: ";", semitone: 16 },
  { code: "Quote", label: "'", semitone: 17 },
];

export const BLACK_KEYS = [
  { code: "KeyW", label: "W", semitone: 1 },
  { code: "KeyE", label: "E", semitone: 3 },
  { code: "KeyT", label: "T", semitone: 6 },
  { code: "KeyY", label: "Y", semitone: 8 },
  { code: "KeyU", label: "U", semitone: 10 },
  { code: "KeyO", label: "O", semitone: 13 },
  { code: "KeyP", label: "P", semitone: 15 },
];

export const KEY_CONFIG_BY_CODE = new Map([...WHITE_KEYS, ...BLACK_KEYS].map((key) => [key.code, key]));
export const COMPUTER_WINDOW_SPAN = 17; // semitones from base C to the top F

export const SONG_MANIFEST_PATH = "./songs/index.json";
export const DEFAULT_WINDOW_BASE = 60; // C4 (middle C)
export const MIN_MIDI = 21; // A0
export const MAX_MIDI = 108; // C8

// Gameplay tuning
export const GAME = {
  lookaheadSeconds: 2.4, // song-seconds visible above the hit line
  holdThreshold: 0.5, // notes at least this long (s) must be held
  holdReleaseTolerance: 0.14, // release this close to the end still counts as a full hold
  windows: { perfect: 0.06, great: 0.12, good: 0.18 }, // real-time seconds
  points: { perfect: 100, great: 70, good: 40, holdPerSecond: 120, holdBonus: 50 },
  weights: { perfect: 1, great: 0.8, good: 0.5 },
  wrongPenaltyWeight: 0.25,
  comboPerMultiplier: 10,
  maxMultiplier: 4,
  stars: [0.6, 0.8, 0.93],
  grades: [
    [0.97, "S"],
    [0.9, "A"],
    [0.8, "B"],
    [0.65, "C"],
    [0, "D"],
  ],
  dailyGoalMinutes: 5,
};

// Monetisation. Paste your AdSense publisher ID ("ca-pub-XXXXXXXXXXXXXXXX")
// and the ad-unit slot IDs from the AdSense dashboard. Ad slots stay hidden
// while these are empty, so local development shows no blank boxes.
export const ADS = {
  client: "",
  slots: {
    library: "",
    results: "",
  },
};

// Song import
export const IMPORT = {
  // Bump when the melody finder improves: older lessons with saved audio offer a re-analyze.
  analysisVersion: 3,
  maxAudioSeconds: 8 * 60,
  basicPitchModule: "https://cdn.jsdelivr.net/npm/@spotify/basic-pitch@1.0.1/+esm",
  basicPitchModel: "https://cdn.jsdelivr.net/npm/@spotify/basic-pitch@1.0.1/model/model.json",
  tfModule: "https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@3.19.0/+esm",
  midiLibrary: "https://cdn.jsdelivr.net/npm/@tonejs/midi@2.0.28/build/Midi.js",
};
