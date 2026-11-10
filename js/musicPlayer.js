// Plays a song's original recording in lockstep with the game clock.
// audioTime = songTime + offset (offset = silence trimmed before the first note).
const MAX_DRIFT = 0.12; // seconds before we hard-correct by seeking
const START_LEAD = 0.06; // play() takes ~50–70 ms to become audible; start that far ahead

export function createMusicPlayer() {
  const el = new Audio();
  el.preload = "auto";
  el.preservesPitch = true; // slow practice speeds keep the song's key
  el.webkitPreservesPitch = true;
  let url = null;
  let offset = 0;
  let loaded = false;
  let wantPlaying = false;

  async function load(blob, audioOffset = 0) {
    unload();
    if (!blob) return false;
    url = URL.createObjectURL(blob);
    el.src = url;
    offset = audioOffset;
    loaded = await new Promise((resolve) => {
      const done = (ok) => {
        el.removeEventListener("loadedmetadata", onOk);
        el.removeEventListener("error", onErr);
        resolve(ok);
      };
      const onOk = () => done(true);
      const onErr = () => done(false);
      el.addEventListener("loadedmetadata", onOk);
      el.addEventListener("error", onErr);
    });
    return loaded;
  }

  function unload() {
    stop();
    loaded = false;
    if (url) URL.revokeObjectURL(url);
    url = null;
    el.removeAttribute("src");
    el.load();
  }

  function stop() {
    wantPlaying = false;
    if (!el.paused) el.pause();
  }

  // Called every frame. `active` = the game clock is moving and music is enabled.
  function sync(songTime, speed, active) {
    if (!loaded) return;
    const target = songTime + offset;
    const inRange = target >= 0 && (!Number.isFinite(el.duration) || target < el.duration);
    if (!active || !inRange) {
      if (wantPlaying) stop();
      return;
    }
    if (Math.abs(el.playbackRate - speed) > 0.001) el.playbackRate = speed;
    if (!wantPlaying) {
      wantPlaying = true;
      el.currentTime = target + START_LEAD * speed;
      el.play().catch(() => {
        wantPlaying = false;
      });
      return;
    }
    if (!el.seeking && Math.abs(el.currentTime - target) > MAX_DRIFT * Math.max(1, speed)) {
      el.currentTime = target;
    }
  }

  return {
    load,
    unload,
    stop,
    sync,
    setVolume: (v) => {
      el.volume = Math.max(0, Math.min(1, v));
    },
    get loaded() {
      return loaded;
    },
    get element() {
      return el;
    },
  };
}
