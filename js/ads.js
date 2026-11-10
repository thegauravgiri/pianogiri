import { ADS } from "./config.js";

// Google AdSense, loaded lazily and only when configured.
// Placement rules we follow (AdSense programme policies):
//   * Never during gameplay or next to the piano keys (accidental clicks).
//   * Clearly labelled "Advertisement".
//   * Space reserved up front so the page doesn't jump (CLS).
// EEA/UK consent: enable Google's built-in "Privacy & messaging" CMP in the
// AdSense dashboard; it hooks into this same script, no extra code needed.
let scriptPromise = null;

export function adsEnabled() {
  return Boolean(ADS.client);
}

function loadScript() {
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.async = true;
    script.crossOrigin = "anonymous";
    script.src = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${encodeURIComponent(ADS.client)}`;
    script.onload = resolve;
    script.onerror = reject;
    document.head.appendChild(script);
  });
  return scriptPromise;
}

// Fills `container` (an element with class .ad-slot) with a fresh ad unit.
export function renderAd(container, placement) {
  const slot = ADS.slots[placement];
  if (!container) return;
  if (!adsEnabled() || !slot) {
    container.hidden = true;
    return;
  }

  container.hidden = false;
  container.innerHTML = '<span class="ad-label">Advertisement</span>';
  const ins = document.createElement("ins");
  ins.className = "adsbygoogle";
  ins.style.display = "block";
  ins.dataset.adClient = ADS.client;
  ins.dataset.adSlot = slot;
  ins.dataset.adFormat = "auto";
  ins.dataset.fullWidthResponsive = "true";
  container.appendChild(ins);

  loadScript()
    .then(() => {
      (window.adsbygoogle = window.adsbygoogle || []).push({});
    })
    .catch(() => {
      // Blocked by an ad blocker or offline: collapse the slot quietly.
      container.hidden = true;
    });
}
