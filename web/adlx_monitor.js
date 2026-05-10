/**
 * adlx_monitor.js — ComfyUI-ADLX-Monitor  (entry point)
 *
 * Responsibilities: constants, settings, toolbar chip, chip render,
 * chip hover tooltip, API polling / WS, and extension registration.
 *
 * Heavy lifting is delegated to:
 *   adlx_panel.js      — floating panel, sparklines, drag, tabs
 *   adlx_predictor.js  — VRAM prediction math + model-file scanning
 */

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

import {
  buildPanel, mountPanel, togglePanel,
  renderPanel, setActivePanelTab,
  history, pushHistoryValue,
} from "./adlx_panel.js";

import {
  calcPrediction, getPredModels,
  applyModelHook, schedulePredictor,
} from "./adlx_predictor.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NS      = "ADLX_Mon";
const VERSION = "1.1.0";
const GITHUB  = "https://github.com/zvonac99/ComfyUI-ADLX-Monitor";
const GITHUB_LABEL = "GitHub";
const S = {
  providerMode:  `${NS}.ProviderMode`,
  showBarValues: `${NS}.ShowBarValues`,
  fontSize:      `${NS}.FontSize`,
  refreshMs:     `${NS}.RefreshInterval`,
  uiMode:        `${NS}.UiMode`,
};

const CHIP_POS_KEY = `${NS}.ChipPosition`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getSetting(id, def) {
  try { const v = app.extensionManager?.setting?.get(id); if (v !== undefined) return v; } catch (_) {}
  try { return app.ui.settings.getSettingValue(id, def); } catch (_) {}
  return def;
}

// ---------------------------------------------------------------------------
// Settings widget factories
// ---------------------------------------------------------------------------

function makeSliderType(min, max, step, liveUpdate = false) {
  return (_name, setter, value) => {
    const wrap = document.createElement("div");
    wrap.style.cssText = "display:flex;align-items:center;gap:8px;width:100%;";

    const slider = document.createElement("input");
    slider.type  = "range"; slider.min = min; slider.max = max; slider.step = step;
    slider.value = value ?? min;
    slider.style.cssText = "flex:1;cursor:pointer;";

    const box = document.createElement("input");
    box.type  = "number"; box.min = min; box.max = max; box.step = step;
    box.value = value ?? min;
    box.style.cssText = "width:62px;padding:2px 4px;background:transparent;" +
                        "border:1px solid #555;border-radius:3px;color:inherit;" +
                        "text-align:center;font-size:inherit;";

    slider.addEventListener("input", () => {
      const c = Math.max(min, Math.min(max, Number(slider.value)));
      box.value = c;
    });
    slider.addEventListener("mouseover", () => {
      const c = Math.max(min, Math.min(max, Number(slider.value)));
      box.value = c;
      if (liveUpdate) setter(c);
    });
    slider.addEventListener("change", () => {
      const c = Math.max(min, Math.min(max, Number(slider.value)));
      slider.value = c; box.value = c; setter(c);
    });
    box.addEventListener("change", () => {
      const c = Math.max(min, Math.min(max, Number(box.value)));
      slider.value = c; box.value = c; setter(c);
    });
    wrap.appendChild(slider); wrap.appendChild(box);
    return wrap;
  };
}

function makeProviderModeSelectType() {
  return (_name, setter, value) => {
    const sel = document.createElement("select");
    sel.style.cssText = "background:#2a2a2a;border:1px solid #555;border-radius:4px;" +
                        "color:inherit;padding:3px 8px;font-size:inherit;cursor:pointer;";
    const options = [
      { label: "Auto",       value: "auto" },
      { label: "Prefer AMD", value: "prefer-amd" },
      { label: "Force AMD",  value: "force-amd" },
    ];
    const normalized = value || "auto";
    options.forEach(optData => {
      const opt = document.createElement("option");
      opt.value       = optData.value;
      opt.textContent = optData.label;
      if (normalized === optData.value) opt.selected = true;
      sel.appendChild(opt);
    });
    sel.addEventListener("change", () => setter(sel.value));
    return sel;
  };
}

function makeUiModeSelectType() {
  return (_name, setter, value) => {
    const sel = document.createElement("select");
    sel.style.cssText = "background:#2a2a2a;border:1px solid #555;border-radius:4px;" +
                        "color:inherit;padding:3px 8px;font-size:inherit;cursor:pointer;";
    const options = [
      { label: "Top Bar (new menu)", value: "top-bar" },
      { label: "Floating Overlay",   value: "overlay"  },
    ];
    const normalized = value || "top-bar";
    options.forEach(optData => {
      const opt = document.createElement("option");
      opt.value       = optData.value;
      opt.textContent = optData.label;
      if (normalized === optData.value) opt.selected = true;
      sel.appendChild(opt);
    });
    sel.addEventListener("change", () => setter(sel.value));
    return sel;
  };
}

// ---------------------------------------------------------------------------
// CSS injection
// ---------------------------------------------------------------------------

function injectStyles() {
  if (document.getElementById("adlx-monitor-styles")) return;
  const link = document.createElement("link");
  link.id   = "adlx-monitor-styles";
  link.rel  = "stylesheet";
  link.href = new URL("./adlx_monitor.css", import.meta.url).href;
  document.head.appendChild(link);
}

// ---------------------------------------------------------------------------
// Backend config
// ---------------------------------------------------------------------------

async function saveBackendConfig(patch) {
  const response = await api.fetchApi("/adlxmon/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!response.ok) throw new Error(`Config save failed with status ${response.status}`);
  return response.json();
}

async function applyProviderMode(value) {
  try {
    await saveBackendConfig({ provider_mode: value });
    console.info("ADLXMonitor: provider mode saved. Restart ComfyUI to apply the new backend selection.");
  } catch (error) {
    console.warn("ADLXMonitor: failed to save provider mode", error);
  }
}

// ---------------------------------------------------------------------------
// Tooltip engine
// ---------------------------------------------------------------------------

let _tipEl     = null;
let _tipTarget = null;

function createTooltip() {
  _tipEl = document.createElement("div");
  _tipEl.className     = "adlx-tooltip";
  _tipEl.style.display = "none";
  document.body.appendChild(_tipEl);
}

function showTooltip(el, html) {
  _tipTarget           = el;
  _tipEl.innerHTML     = html;
  _tipEl.style.display = "block";
  positionTooltip(el);
}

function positionTooltip(el) {
  const r  = el.getBoundingClientRect();
  const tw = _tipEl.offsetWidth, th = _tipEl.offsetHeight;
  let x = r.left + r.width / 2 - tw / 2;
  let y = r.bottom + 6;
  x = Math.max(6, Math.min(x, window.innerWidth  - tw - 6));
  if (y + th > window.innerHeight - 6) y = r.top - th - 6;
  _tipEl.style.left = x + "px";
  _tipEl.style.top  = y + "px";
}

function hideTooltip() {
  if (_tipEl) _tipEl.style.display = "none";
  _tipTarget = null;
}

function tipRow(key, val, color) {
  const vc = color ? ` style="color:${color}"` : "";
  return `<div class="adlx-tooltip-row">` +
         `<span class="adlx-tooltip-key">${key}</span>` +
         `<span class="adlx-tooltip-val"${vc}>${val}</span>` +
         `</div>`;
}
function tipTitle(t) { return `<div class="adlx-tooltip-title">${t}</div>`; }
function tipNote(t)  { return `<div class="adlx-tooltip-note">${t}</div>`; }

// Chip hover: quick GPU engine summary.
function buildChipTooltip(snap) {
  const load = snap.gpu_load_pct ?? 0;
  const freq = snap.gpu_freq_mhz ?? 0;
  const temp = snap.gpu_temp_c   ?? -1;
  const c    = load > 95 ? "#ff4d4f" : load > 80 ? "#faad14" : "#52c41a";
  const tc   = temp > 85 ? "#ff4d4f" : temp > 70 ? "#faad14" : "#36cfc9";
  return tipTitle("📊 GPU Engine")
    + tipRow("Load",  load.toFixed(1) + " %", c)
    + (freq > 0  ? tipRow("Clock", Math.round(freq) + " MHz") : "")
    + (temp >= 0 ? tipRow("Temp",  Math.round(temp) + " °C", tc) : "")
    + tipNote("Click to open detail panel");
}

// ---------------------------------------------------------------------------
// Chip position persistence + drag  (Overlay mode)
// ---------------------------------------------------------------------------

function saveChipPosition(left, top) {
  try { localStorage.setItem(CHIP_POS_KEY, JSON.stringify({ left, top })); } catch (_) {}
}

function applyChipPosition(bar, left, top) {
  const w    = bar.offsetWidth  || 200;
  const h    = bar.offsetHeight || 36;
  const maxL = Math.max(8, window.innerWidth  - w - 8);
  const maxT = Math.max(8, window.innerHeight - h - 8);
  const l    = Math.min(Math.max(8, left), maxL);
  const t    = Math.min(Math.max(8, top),  maxT);
  bar.style.left   = `${l}px`;
  bar.style.top    = `${t}px`;
  bar.style.bottom = "auto";
  bar.style.right  = "auto";
}

function restoreChipPosition(bar) {
  try {
    const raw = localStorage.getItem(CHIP_POS_KEY);
    if (!raw) return false;
    const { left, top } = JSON.parse(raw);
    if (typeof left !== "number" || typeof top !== "number") return false;
    applyChipPosition(bar, left, top);
    return true;
  } catch (_) {}
  return false;
}

function enableChipDrag(bar) {
  let dragState = null;

  const onPointerMove = (e) => {
    if (!dragState) return;
    const dx = e.clientX - dragState.startX;
    const dy = e.clientY - dragState.startY;
    if (!dragState.hasMoved && Math.hypot(dx, dy) < 4) return;
    dragState.hasMoved = true;
    bar.classList.add("is-dragging");
    applyChipPosition(bar, e.clientX - dragState.offsetX, e.clientY - dragState.offsetY);
  };

  const stopDrag = () => {
    if (!dragState) return;
    const wasDragging = dragState.hasMoved;
    dragState = null;
    bar.classList.remove("is-dragging");
    window.removeEventListener("pointermove",   onPointerMove);
    window.removeEventListener("pointerup",     stopDrag);
    window.removeEventListener("pointercancel", stopDrag);
    // Save position only after a real drag — never during click or initial layout.
    if (wasDragging) {
      const rect = bar.getBoundingClientRect();
      saveChipPosition(rect.left, rect.top);
    }
  };

  bar.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    if (e.target.closest("button, a")) return;
    const rect = bar.getBoundingClientRect();
    dragState = {
      offsetX:  e.clientX - rect.left,
      offsetY:  e.clientY - rect.top,
      startX:   e.clientX,
      startY:   e.clientY,
      hasMoved: false,
    };
    window.addEventListener("pointermove",   onPointerMove);
    window.addEventListener("pointerup",     stopDrag);
    window.addEventListener("pointercancel", stopDrag);
  });
  // No window resize handler — avoids corrupting saved position during initial layout.
  // (The panel uses the same approach and works correctly.)
}

// ---------------------------------------------------------------------------
// Toolbar chip
// ---------------------------------------------------------------------------

let _bar  = null;
let _chip = null;

function buildBar() {
  const bar     = document.createElement("div");
  bar.id        = "adlx-bar";
  bar.className = "adlx-monitor-bar";

  const chipEl     = document.createElement("div");
  chipEl.className = "adlx-monitor-chip";
  const valEl      = document.createElement("span");
  valEl.className   = "adlx-value";
  valEl.textContent = "ADLX";
  chipEl.appendChild(valEl);
  _chip = { el: chipEl, valEl };

  _bar = bar;
  bar.appendChild(chipEl);
  chipEl.addEventListener("click",      () => togglePanel(undefined, chipEl));
  chipEl.addEventListener("mouseenter", () => { if (_snap) showTooltip(chipEl, buildChipTooltip(_snap)); });
  chipEl.addEventListener("mousemove",  () => { if (_tipTarget === chipEl && _snap) positionTooltip(chipEl); });
  chipEl.addEventListener("mouseleave", hideTooltip);

  return bar;
}

function mountBar(bar) {
  const mode       = getSetting(S.uiMode, "top-bar");
  const hasNewMenu = !!app.menu?.settingsGroup?.element;

  if (mode === "top-bar" && hasNewMenu) {
    bar.classList.remove("adlx-overlay-mode");
    bar.style.cssText = "";
    app.menu.settingsGroup.element.before(bar);
  } else {
    bar.classList.add("adlx-overlay-mode");
    document.body.appendChild(bar);
    if (!bar._dragEnabled) {
      enableChipDrag(bar);
      bar._dragEnabled = true;
    }
    // Use rAF so the bar is rendered and has correct offsetWidth/Height before
    // we compute the clamped position.
    requestAnimationFrame(() => {
      if (!restoreChipPosition(bar)) {
        const w = bar.offsetWidth  || 200;
        const h = bar.offsetHeight || 36;
        applyChipPosition(bar, window.innerWidth - w - 16, window.innerHeight - h - 20);
      }
    });
  }
}

function remountBar(_newMode) {
  if (!_bar) return;
  _bar.parentNode?.removeChild(_bar);
  mountBar(_bar);
}

// ---------------------------------------------------------------------------
// Toolbar chip render
// ---------------------------------------------------------------------------

let _snap = null;

function renderToolbarChip(snap) {
  if (!_chip) return;

  if (!snap) {
    _chip.el.classList.remove("adlx-error-state");
    _chip.el.title        = "";
    _chip.valEl.innerHTML = `<span class="adlx-chip-row"><span class="adlx-chip-brand">ADLX</span></span>`;
    _chip.valEl.className = "adlx-value";
    return;
  }

  if (snap.error) {
    _chip.el.classList.add("adlx-error-state");
    _chip.el.title        = snap.error;
    _chip.valEl.innerHTML =
      `<span class="adlx-chip-row">` +
      `<span class="adlx-chip-brand">ADLX</span>` +
      `<span class="adlx-chip-status adlx-chip-status-error">ERROR</span>` +
      `</span>`;
    _chip.valEl.className = "adlx-value";
    return;
  }

  _chip.el.classList.remove("adlx-error-state");
  _chip.el.title = "";

  const provider      = String(snap.gpu_vendor || "unknown").toUpperCase();
  const providerBadge = `<span class="adlx-chip-status adlx-chip-status-provider">${provider}</span>`;

  if (!getSetting(S.showBarValues, true)) {
    _chip.valEl.innerHTML = `<span class="adlx-chip-row"><span class="adlx-chip-brand">ADLX</span>${providerBadge}</span>`;
    _chip.valEl.className = "adlx-value";
    return;
  }

  const cpu      = Number(snap.cpu_pct ?? 0).toFixed(0);
  const ramUsed  = Number(snap.ram_used_gb ?? 0).toFixed(1);
  const ramTotal = Number(snap.ram_total_gb ?? 0).toFixed(1);
  const gpuUsed  = Number(snap.vram_driver_used_gb ?? 0).toFixed(1);
  const gpuTotal = Number(snap.vram_total_gb ?? 0).toFixed(1);
  const ramRatio = Math.max(0, Math.min(100,
    (Number(snap.ram_used_gb ?? 0) / Math.max(Number(snap.ram_total_gb ?? 0), 0.001)) * 100));
  const gpuRatio = Math.max(0, Math.min(100,
    (Number(snap.vram_driver_used_gb ?? 0) / Math.max(Number(snap.vram_total_gb ?? 0), 0.001)) * 100));

  const cpuIcon = `<span class="adlx-chip-icon adlx-chip-cpu"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 2h2v2h2V2h2v2.13A4 4 0 0 1 18.87 8H21v2h-2v2h2v2h-2.13A4 4 0 0 1 15 17.87V20h-2v-2h-2v2H9v-2.13A4 4 0 0 1 5.13 14H3v-2h2v-2H3V8h2.13A4 4 0 0 1 9 4.13V2zm0 4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2H9zm1 2h4v6h-4V8z"/></svg></span>`;
  const ramIcon = `<span class="adlx-chip-icon adlx-chip-ram"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7h18v10H3V7zm2 2v6h14V9H5zm1 1h2v4H6v-4zm3 0h2v4H9v-4zm3 0h2v4h-2v-4zm3 0h2v4h-2v-4zM5 4h2v2H5V4zm4 0h2v2H9V4zm4 0h2v2h-2V4zm4 0h2v2h-2V4z"/></svg></span>`;
  const gpuIcon = `<span class="adlx-chip-icon adlx-chip-gpu"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v7a3 3 0 0 1-3 3h-1v2h2v2H6v-2h2v-2H7a3 3 0 0 1-3-3V7zm3-1a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V7a1 1 0 0 0-1-1H7zm3 11v2h4v-2h-4zm-1-8h6v4H9V9z"/></svg></span>`;

  _chip.valEl.innerHTML =
    `<span class="adlx-chip-row">` +
    `<span class="adlx-chip-brand">ADLX</span>` +
    providerBadge +
    `<span class="adlx-chip-metric adlx-chip-metric-cpu">${cpuIcon}<span>${cpu}%</span></span>` +
    `<span class="adlx-chip-metric adlx-chip-metric-ram">${ramIcon}<span class="adlx-chip-stack"><span>${ramUsed}/${ramTotal}G</span><span class="adlx-chip-mini-track"><span class="adlx-chip-mini-fill adlx-chip-mini-fill-ram" style="width:${ramRatio.toFixed(1)}%"></span></span></span></span>` +
    `<span class="adlx-chip-metric adlx-chip-metric-gpu">${gpuIcon}<span class="adlx-chip-stack"><span>${gpuUsed}/${gpuTotal}G</span><span class="adlx-chip-mini-track"><span class="adlx-chip-mini-fill adlx-chip-mini-fill-gpu" style="width:${gpuRatio.toFixed(1)}%"></span></span></span></span>` +
    `</span>`;
  _chip.valEl.className = "adlx-value adlx-vram-ok";
}

function renderSnap(snap) {
  if (!snap) return;
  _snap = snap;
  pushHistoryValue(history.ramUsedGb,     Number(snap.ram_used_gb         ?? 0));
  pushHistoryValue(history.gpuVramUsedGb, Number(snap.vram_driver_used_gb ?? 0));
  renderToolbarChip(snap);
  renderPanel(snap);
  applyVisibility();
}

// ---------------------------------------------------------------------------
// Visibility & font
// ---------------------------------------------------------------------------

function applyVisibility() {
  if (!_chip) return;
  _chip.el.style.display = "";
  renderToolbarChip(_snap);
}

function applyFontSize(val) {
  const px = (val != null && !isNaN(Number(val))) ? Number(val) : Number(getSetting(S.fontSize, 18));
  document.documentElement.style.setProperty("--adlx-fs", px + "px");
}

// ---------------------------------------------------------------------------
// API — polling + WebSocket
// ---------------------------------------------------------------------------

let _pollTimer = null;

function onWsMessage(e) {
  if (e?.detail?.type !== "adlxmon_stats") return;
  renderSnap(e.detail.data);
}

async function pollOnce() {
  try {
    const r = await api.fetchApi("/adlxmon/stats");
    if (r.ok) renderSnap(await r.json());
  } catch (_) {}
}

function startPolling() {
  if (_pollTimer) clearInterval(_pollTimer);
  const ms = Math.max(200, getSetting(S.refreshMs, 1000));
  _pollTimer = setInterval(pollOnce, ms);
  pollOnce();
}

// ---------------------------------------------------------------------------
// Extension registration
// ---------------------------------------------------------------------------

app.registerExtension({
  name: `${NS}.Monitor`,

  async setup() {
    injectStyles();
    createTooltip();

    // ── 0 About ─────────────────────────────────────────────────────────────
    app.ui.settings.addSetting({
      id: `${NS}.About`,
      name: "About",
      type: (_name, _setter, _value) => {
        const wrap = document.createElement("div");
        wrap.style.cssText =
          "line-height:1.7;color:#ccc;font-size:15px;padding:4px 0 2px;max-width:520px;";
        wrap.innerHTML =
          `This fork focuses on AMD monitoring for ComfyUI, with ADLX as the primary Windows ` +
          `telemetry path and ROCm as the secondary fallback. Instead of chasing every GPU stack, ` +
          `it narrows scope to make the AMD path dependable.<br><br>` +
          `<span style="color:#36cfc9;font-weight:600;">Highlight:</span> ` +
          `Workflow VRAM prediction, a compact top-bar chip, a floating detail panel, and clearer ` +
          `AMD telemetry diagnostics before you launch a run.`;

        const bar = document.createElement("div");
        bar.style.cssText =
          "display:flex;align-items:center;justify-content:flex-end;gap:8px;" +
          "margin-top:16px;flex-wrap:wrap;border-top:1px solid #333;padding-top:10px;";

        const verBadge = document.createElement("span");
        verBadge.style.cssText =
          "display:inline-flex;align-items:center;gap:0;border-radius:4px;overflow:hidden;" +
          "font-size:12px;font-weight:600;line-height:1;";
        verBadge.innerHTML =
          `<span style="background:#555;color:#fff;padding:4px 7px;">Version</span>` +
          `<span style="background:#4caf50;color:#fff;padding:4px 7px;">${VERSION}</span>`;

        const ghBtn = document.createElement("a");
        ghBtn.href   = GITHUB;
        ghBtn.target = "_blank";
        ghBtn.rel    = "noopener noreferrer";
        ghBtn.style.cssText =
          "display:inline-flex;align-items:center;gap:5px;padding:4px 10px;" +
          "background:#24292e;color:#fff;border-radius:4px;font-size:12px;font-weight:600;" +
          "text-decoration:none;line-height:1;transition:background .15s;";
        ghBtn.onmouseenter = () => { ghBtn.style.background = "#444d56"; };
        ghBtn.onmouseleave = () => { ghBtn.style.background = "#24292e"; };
        ghBtn.innerHTML =
          `<svg width="14" height="14" viewBox="0 0 16 16" fill="#fff" style="flex-shrink:0;">` +
          `<path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38` +
          `0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52` +
          `-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07` +
          `-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12` +
          `0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82` +
          ` 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95` +
          `.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8` +
          `c0-4.42-3.58-8-8-8z"/></svg>` +
          `${GITHUB_LABEL}`;

        bar.appendChild(verBadge);
        bar.appendChild(ghBtn);
        wrap.appendChild(bar);
        return wrap;
      },
      defaultValue: "",
      category: [NS, "\uE000About", "\uE000Introduction"],
    });

    // ── 1 General Settings ──────────────────────────────────────────────────
    app.ui.settings.addSetting({
      id: S.providerMode, name: "Provider Mode",
      tooltip: "Choose the AMD telemetry startup mode. Changes require a ComfyUI restart.",
      type: makeProviderModeSelectType(), defaultValue: "auto",
      category: [NS, "\uE001General", "\uE004Provider Mode"],
      onChange: applyProviderMode,
    });
    app.ui.settings.addSetting({
      id: S.fontSize, name: "Font Size (px)",
      tooltip: "Status bar font size, range 12-22 px",
      type: makeSliderType(12, 22, 1, false), defaultValue: 16,
      category: [NS, "\uE001General", "\uE002Font Size"],
      onChange: applyFontSize,
    });
    app.ui.settings.addSetting({
      id: S.refreshMs, name: "Refresh Interval (ms)",
      tooltip: "Status bar update frequency, range 200-5000 ms",
      type: makeSliderType(200, 5000, 100), defaultValue: 1000,
      category: [NS, "\uE001General", "\uE001Refresh Interval"],
      onChange: startPolling,
    });
    app.ui.settings.addSetting({
      id: S.showBarValues, name: "Show Bar Values",
      tooltip: "When disabled, the top bar keeps only the ADLX label and provider badge.",
      type: "boolean", defaultValue: true,
      category: [NS, "\uE001General", "\uE005Bar Display"],
      onChange: applyVisibility,
    });
    app.ui.settings.addSetting({
      id: S.uiMode, name: "UI Mode",
      tooltip: "Top Bar: chip in the new ComfyUI menu. Floating Overlay: draggable chip over the canvas — works with both old and new menu.",
      type: makeUiModeSelectType(), defaultValue: "top-bar",
      category: [NS, "\uE001General", "\uE003UI Mode"],
      onChange: remountBar,
    });

    const bar   = buildBar();
    const panel = buildPanel(() => togglePanel(false));
    mountBar(bar);
    mountPanel(panel);
    setActivePanelTab("gpu");
    applyVisibility();
    applyFontSize();
    setTimeout(applyFontSize, 0);

    api.addEventListener("message", onWsMessage);
    startPolling();

    app.graph._nodes?.forEach(n => applyModelHook(n, () => schedulePredictor(() => renderPanel(_snap))));
    schedulePredictor(() => renderPanel(_snap));
  },

  nodeCreated(node) {
    setTimeout(() => {
      applyModelHook(node, () => schedulePredictor(() => renderPanel(_snap)));
      schedulePredictor(() => renderPanel(_snap));
    }, 200);
  },

  loadedGraphNode(node) {
    applyModelHook(node, () => schedulePredictor(() => renderPanel(_snap)));
  },

  async afterConfigureGraph() {
    app.graph._nodes?.forEach(n => applyModelHook(n, () => schedulePredictor(() => renderPanel(_snap))));
    schedulePredictor(() => renderPanel(_snap));
  },
});
