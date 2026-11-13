import { isBlackKey, midiToName } from "./utils.js";

// Black-key offsets (fraction of a white key) for a realistic look.
const BLACK_OFFSET = { 1: -0.1, 3: 0.1, 6: -0.12, 8: 0, 10: 0.12 };
const BLACK_WIDTH = 0.62;

// Horizontal geometry shared by the keyboard and the falling-notes canvas.
// Returns Map(midi -> { left, width, black }) in fractions of the full width.
export function computeKeyLayout(lo, hi) {
  const whites = [];
  for (let m = lo; m <= hi; m += 1) if (!isBlackKey(m)) whites.push(m);
  const unit = 1 / whites.length;
  const layout = new Map();

  whites.forEach((m, i) => layout.set(m, { left: i * unit, width: unit, black: false }));
  for (let m = lo; m <= hi; m += 1) {
    if (!isBlackKey(m)) continue;
    const prevWhite = layout.get(m - 1);
    if (!prevWhite) continue;
    const center = prevWhite.left + unit + BLACK_OFFSET[m % 12] * unit;
    layout.set(m, { left: center - (BLACK_WIDTH * unit) / 2, width: BLACK_WIDTH * unit, black: true });
  }
  return layout;
}

export function createKeyboardView({ keybed, onPressStart, onPressEnd }) {
  const keyElements = new Map();
  const pointerNotes = new Map(); // pointerId -> midi
  let layout = new Map();
  let expected = new Set();

  function startPointer(pointerId, midi) {
    const previous = pointerNotes.get(pointerId);
    if (previous === midi) return;
    if (previous !== undefined) onPressEnd(previous, "pointer");
    pointerNotes.set(pointerId, midi);
    onPressStart(midi, "pointer");
  }

  function endPointer(pointerId) {
    const midi = pointerNotes.get(pointerId);
    if (midi === undefined) return;
    pointerNotes.delete(pointerId);
    onPressEnd(midi, "pointer");
  }

  keybed.addEventListener("pointerdown", (event) => {
    const key = event.target.closest(".key");
    if (!key) return;
    event.preventDefault();
    // Touch pointers are captured by default; release so sliding works.
    if (key.hasPointerCapture && key.hasPointerCapture(event.pointerId)) key.releasePointerCapture(event.pointerId);
    startPointer(event.pointerId, Number(key.dataset.midi));
  });

  keybed.addEventListener("pointerover", (event) => {
    if (!pointerNotes.has(event.pointerId)) return;
    const key = event.target.closest(".key");
    if (key) startPointer(event.pointerId, Number(key.dataset.midi));
  });

  for (const type of ["pointerup", "pointercancel"]) {
    window.addEventListener(type, (event) => endPointer(event.pointerId));
  }
  keybed.addEventListener("pointerleave", (event) => endPointer(event.pointerId));
  keybed.addEventListener("contextmenu", (event) => event.preventDefault());

  function build(lo, hi, labels = new Map()) {
    keybed.innerHTML = "";
    keyElements.clear();
    layout = computeKeyLayout(lo, hi);
    keybed.style.setProperty("--white-count", String([...layout.values()].filter((k) => !k.black).length));

    const sorted = [...layout.entries()].sort((a, b) => Number(a[1].black) - Number(b[1].black));
    for (const [midi, geo] of sorted) {
      const el = document.createElement("button");
      el.type = "button";
      el.className = `key ${geo.black ? "black" : "white"}`;
      el.dataset.midi = String(midi);
      el.style.left = `${geo.left * 100}%`;
      el.style.width = `${geo.width * 100}%`;
      el.setAttribute("aria-label", midiToName(midi));
      el.tabIndex = -1;
      el.innerHTML = `<span class="key-label"></span><span class="key-note"></span>`;
      keybed.appendChild(el);
      keyElements.set(midi, el);
    }
    setLabels(labels);
    return layout;
  }

  function setLabels(labels, showNoteNames = true) {
    for (const [midi, el] of keyElements) {
      el.querySelector(".key-label").textContent = labels.get(midi) || "";
      const name = midiToName(midi);
      el.querySelector(".key-note").textContent = showNoteNames && name.startsWith("C") && !isBlackKey(midi) ? name : "";
    }
  }

  // Dim keys outside [lo, hi] (null = no dimming).
  function setReach(lo, hi) {
    for (const [midi, el] of keyElements) el.classList.toggle("out-of-reach", lo !== null && (midi < lo || midi > hi));
  }

  function setPressed(midi, pressed) {
    const el = keyElements.get(midi);
    if (el) el.classList.toggle("active", pressed);
  }

  function flash(midi, className) {
    const el = keyElements.get(midi);
    if (!el) return;
    el.classList.remove(className);
    void el.offsetWidth;
    el.classList.add(className);
    window.setTimeout(() => el.classList.remove(className), 320);
  }

  function setExpected(midis) {
    const next = new Set(midis);
    for (const midi of expected) if (!next.has(midi)) keyElements.get(midi)?.classList.remove("expected");
    for (const midi of next) keyElements.get(midi)?.classList.add("expected");
    expected = next;
  }

  function setHolding(midi, holding) {
    keyElements.get(midi)?.classList.toggle("holding", holding);
  }

  function releaseAllPointers() {
    for (const pointerId of [...pointerNotes.keys()]) endPointer(pointerId);
  }

  return {
    build,
    setLabels,
    setReach,
    setPressed,
    flash,
    setExpected,
    setHolding,
    releaseAllPointers,
    has: (midi) => keyElements.has(midi),
    get layout() {
      return layout;
    },
  };
}
