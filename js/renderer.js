import { GAME } from "./config.js";
import { pitchClassName, prefersReducedMotion } from "./utils.js";

const JUDGMENT_STYLE = {
  perfect: { text: "PERFECT", color: "#ffd166" },
  great: { text: "GREAT", color: "#2fe0c5" },
  good: { text: "GOOD", color: "#9ad1ff" },
  miss: { text: "MISS", color: "#ff6b6b" },
  hold: { text: "HOLD!", color: "#ffd166" },
  wrong: { text: "✕", color: "#ff6b6b" },
};

// Canvas renderer for falling notes, particles and judgments.
export function createRenderer(canvas) {
  const ctx = canvas.getContext("2d");
  const reduceMotion = prefersReducedMotion();
  let width = 0;
  let height = 0;
  let dpr = 1;
  let layout = new Map();
  let particles = [];
  let popups = [];
  let freeBars = []; // free-play visualiser
  let shake = 0;
  let pulse = 0;

  function resize() {
    const rect = canvas.getBoundingClientRect();
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = Math.max(1, rect.width);
    height = Math.max(1, rect.height);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
  }

  function setLayout(nextLayout) {
    layout = nextLayout;
  }

  function keyX(midi) {
    const geo = layout.get(midi);
    if (!geo) return null;
    return { x: geo.left * width, w: geo.width * width, black: geo.black };
  }

  function colorsFor(note, black) {
    if (note.status === "missed") return ["rgba(120,135,150,0.45)", "rgba(90,100,115,0.35)"];
    if (black) return ["#2fe0c5", "#00a28e"];
    return ["#ffb15c", "#fb6b3d"];
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    if (w <= 0 || h <= 0) return;
    const rr = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  function drawLanes() {
    for (const [, geo] of layout) {
      if (!geo.black) {
        ctx.fillStyle = "rgba(255,255,255,0.025)";
        ctx.fillRect(geo.left * width, 0, 1, height);
      } else {
        ctx.fillStyle = "rgba(0,0,0,0.12)";
        ctx.fillRect(geo.left * width, 0, geo.width * width, height);
      }
    }
  }

  function drawHitLine() {
    const glow = 0.45 + 0.35 * pulse;
    const gradient = ctx.createLinearGradient(0, height - 26, 0, height);
    gradient.addColorStop(0, "rgba(251,107,61,0)");
    gradient.addColorStop(1, `rgba(251,107,61,${0.35 * glow})`);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, height - 26, width, 26);
    ctx.fillStyle = `rgba(255,209,102,${0.6 + 0.4 * pulse})`;
    ctx.fillRect(0, height - 2, width, 2);
  }

  function drawNotes(game, options) {
    const now = game.songTime;
    const pps = height / GAME.lookaheadSeconds;
    const nextSet = new Set(game.nextNotes());

    for (const note of game.notes) {
      const top = height - (note.t + note.d - now) * pps;
      if (top > height + 4) continue; // fully below the line
      const bottomRaw = height - (note.t - now) * pps;
      if (bottomRaw < -8) break; // notes are sorted; the rest are above the screen
      const pos = keyX(note.midi);
      if (!pos) continue;

      // Hit notes are consumed at the line; only the remaining tail is drawn.
      if (note.status === "hit" && !note.holding) continue;
      const bottom = note.status === "hit" || note.status === "auto" ? Math.min(bottomRaw, height) : bottomRaw;
      if (note.status === "auto" && top > height) continue;
      const h = Math.max(14, bottom - top);
      const inset = pos.black ? 1 : Math.max(2, pos.w * 0.08);
      const x = pos.x + inset;
      const w = pos.w - inset * 2;
      const y = bottom - h;

      const [c1, c2] = colorsFor(note, pos.black);
      const gradient = ctx.createLinearGradient(0, y, 0, y + h);
      gradient.addColorStop(0, c1);
      gradient.addColorStop(1, c2);

      ctx.save();
      if (nextSet.has(note) || note.holding) {
        ctx.shadowColor = note.holding ? "#ffd166" : c1;
        ctx.shadowBlur = note.holding ? 26 : 16 + 8 * pulse;
      }
      ctx.fillStyle = gradient;
      roundRect(x, y, w, h, Math.min(10, w / 3));
      ctx.fill();
      ctx.restore();

      if (note.isHold && note.status !== "missed") {
        // Hold tiles get a ribbed centre stripe so they read as "keep pressing".
        ctx.fillStyle = "rgba(255,255,255,0.28)";
        const stripeW = Math.max(3, w * 0.18);
        ctx.fillRect(x + w / 2 - stripeW / 2, y + 8, stripeW, Math.max(0, h - 22));
        ctx.fillStyle = "rgba(255,255,255,0.85)";
        roundRect(x + 2, bottom - 10, w - 4, 8, 4);
        ctx.fill();
      }

      if (options.labelMode !== "off" && h >= 18 && w >= 14) {
        const label = options.labelMode === "keys" ? options.keyLabels.get(note.midi) || pitchClassName(note.midi) : pitchClassName(note.midi);
        ctx.fillStyle = note.status === "missed" ? "rgba(255,255,255,0.5)" : "rgba(16,33,45,0.85)";
        ctx.font = `700 ${Math.min(15, Math.max(10, w * 0.42))}px "JetBrains Mono", monospace`;
        ctx.textAlign = "center";
        ctx.textBaseline = "bottom";
        ctx.fillText(label, x + w / 2, bottom - (note.isHold ? 13 : 3));
      }

      if (note.holding) {
        burst(note.midi, "#ffd166", 1, 0.6);
      }
    }
  }

  function burst(midi, color, count = 14, power = 1) {
    if (reduceMotion && count > 2) count = 4;
    const pos = keyX(midi);
    if (!pos) return;
    for (let i = 0; i < count; i += 1) {
      const angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 0.9;
      const speed = (120 + Math.random() * 260) * power;
      particles.push({
        x: pos.x + pos.w / 2 + (Math.random() - 0.5) * pos.w * 0.6,
        y: height - 4,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 0.5 + Math.random() * 0.4,
        age: 0,
        size: 2 + Math.random() * 3,
        color,
      });
    }
    if (particles.length > 600) particles = particles.slice(-600);
  }

  function popup(midi, kind, extra = "") {
    const pos = keyX(midi);
    const style = JUDGMENT_STYLE[kind];
    if (!style) return;
    popups.push({
      x: pos ? pos.x + pos.w / 2 : width / 2,
      y: height - 40,
      text: extra ? `${style.text} ${extra}` : style.text,
      color: style.color,
      age: 0,
      life: 0.7,
    });
    if (popups.length > 12) popups.shift();
  }

  function hit(midi, judgment) {
    const style = JUDGMENT_STYLE[judgment];
    if (judgment === "miss") {
      popup(midi, "miss");
      if (!reduceMotion) shake = Math.max(shake, 5);
      return;
    }
    burst(midi, style.color, judgment === "perfect" ? 22 : 14, judgment === "perfect" ? 1.2 : 0.9);
    popup(midi, judgment);
    pulse = 1;
  }

  function autoHit(midi) {
    burst(midi, "#9ad1ff", 8, 0.7);
    pulse = 0.6;
  }

  function wrong(midi) {
    popup(midi, "wrong");
    if (!reduceMotion) shake = Math.max(shake, 3);
  }

  function holdComplete(midi) {
    burst(midi, "#ffd166", 26, 1.3);
    popup(midi, "hold");
  }

  function freeNoteOn(midi) {
    freeBars.push({ midi, start: performance.now(), end: null });
    burst(midi, "#ffd166", 6, 0.7);
  }

  function freeNoteOff(midi) {
    for (const bar of freeBars) if (bar.midi === midi && bar.end === null) bar.end = performance.now();
  }

  function drawFreeBars(nowMs) {
    const speed = 140; // px per second upward
    freeBars = freeBars.filter((bar) => {
      const bottom = height - ((nowMs - (bar.end ?? nowMs)) / 1000) * speed;
      return bottom > -10;
    });
    for (const bar of freeBars) {
      const pos = keyX(bar.midi);
      if (!pos) continue;
      const top = height - ((nowMs - bar.start) / 1000) * speed;
      const bottom = height - ((nowMs - (bar.end ?? nowMs)) / 1000) * speed;
      const [c1, c2] = pos.black ? ["#2fe0c5", "#00a28e"] : ["#ffb15c", "#fb6b3d"];
      const gradient = ctx.createLinearGradient(0, top, 0, bottom);
      gradient.addColorStop(0, c1);
      gradient.addColorStop(1, c2);
      ctx.globalAlpha = Math.max(0.15, Math.min(1, bottom / height + 0.2));
      ctx.fillStyle = gradient;
      roundRect(pos.x + 2, top, pos.w - 4, Math.max(6, bottom - top), 6);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }

  function drawParticles(dt) {
    for (const p of particles) {
      p.age += dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += 520 * dt;
    }
    particles = particles.filter((p) => p.age < p.life);
    for (const p of particles) {
      ctx.globalAlpha = 1 - p.age / p.life;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function drawPopups(dt) {
    for (const p of popups) p.age += dt;
    popups = popups.filter((p) => p.age < p.life);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const p of popups) {
      const k = p.age / p.life;
      const scale = k < 0.15 ? 0.7 + k * 2.5 : 1.05;
      ctx.globalAlpha = 1 - Math.max(0, (k - 0.5) * 2);
      ctx.font = `800 ${Math.round(18 * scale)}px "Space Grotesk", sans-serif`;
      ctx.fillStyle = p.color;
      ctx.shadowColor = "rgba(0,0,0,0.5)";
      ctx.shadowBlur = 6;
      ctx.fillText(p.text, Math.min(width - 50, Math.max(50, p.x)), p.y - k * 46);
      ctx.shadowBlur = 0;
    }
    ctx.globalAlpha = 1;
  }

  function drawWaitHint(game) {
    if (!game.waiting) return;
    ctx.fillStyle = "rgba(255,209,102,0.08)";
    ctx.fillRect(0, height - 60, width, 60);
  }

  function frame({ game, options, dt, nowMs }) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    pulse = Math.max(0, pulse - dt * 3);

    ctx.save();
    if (shake > 0) {
      ctx.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake);
      shake = Math.max(0, shake - dt * 30);
    }
    drawLanes();
    if (game) {
      drawWaitHint(game);
      drawNotes(game, options);
    } else {
      drawFreeBars(nowMs);
    }
    drawHitLine();
    drawParticles(dt);
    drawPopups(dt);
    ctx.restore();
  }

  function reset() {
    particles = [];
    popups = [];
    freeBars = [];
    shake = 0;
  }

  return { resize, setLayout, frame, hit, autoHit, wrong, holdComplete, freeNoteOn, freeNoteOff, reset };
}
