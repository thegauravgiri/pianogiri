export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function isTypingTarget(target) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  if (target.isContentEditable) {
    return true;
  }

  const tagName = target.tagName;
  return tagName === "INPUT" || tagName === "TEXTAREA" || tagName === "SELECT";
}

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const BLACK_PITCH_CLASSES = new Set([1, 3, 6, 8, 10]);

export function isBlackKey(midi) {
  return BLACK_PITCH_CLASSES.has(((midi % 12) + 12) % 12);
}

export function pitchClassName(midi) {
  return NOTE_NAMES[((midi % 12) + 12) % 12];
}

export function midiToName(midi) {
  return `${pitchClassName(midi)}${Math.floor(midi / 12) - 1}`;
}

export function formatDuration(seconds) {
  const total = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(total / 60);
  const rest = String(total % 60).padStart(2, "0");
  return `${minutes}:${rest}`;
}

export function todayKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function prefersReducedMotion() {
  return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

// localStorage can be unavailable (private mode, blocked storage) or full.
export const storage = {
  get(key, fallback) {
    try {
      const raw = window.localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch (_error) {
      return fallback;
    }
  },
  set(key, value) {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (_error) {
      return false;
    }
  },
};

export function loadScriptOnce(src) {
  const existing = document.querySelector(`script[data-src="${src}"]`);
  if (existing) {
    return existing._loadPromise;
  }

  const script = document.createElement("script");
  script.src = src;
  script.async = true;
  script.dataset.src = src;
  script._loadPromise = new Promise((resolve, reject) => {
    script.onload = resolve;
    script.onerror = () => reject(new Error(`Could not load ${src}`));
  });
  document.head.appendChild(script);
  return script._loadPromise;
}

export function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
}
