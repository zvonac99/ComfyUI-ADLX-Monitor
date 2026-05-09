/**
 * adlx_panel.js — Floating detail panel, sparklines, drag, tabs.
 * Imported by adlx_monitor.js.
 */

import { calcPrediction, getPredModels } from "./adlx_predictor.js";

// ---------------------------------------------------------------------------
// Helpers — shared with monitor (passed in or imported from state getters)
// ---------------------------------------------------------------------------

const HISTORY_LIMIT = 36;

// Shared history buckets (exported so monitor can push into them).
export const history = {
  ramUsedGb:    [],
  gpuVramUsedGb: [],
};

export function pushHistoryValue(bucket, value) {
  if (!Number.isFinite(value)) return;
  bucket.push(value);
  if (bucket.length > HISTORY_LIMIT) bucket.splice(0, bucket.length - HISTORY_LIMIT);
}

// ---------------------------------------------------------------------------
// Internal panel reference
// ---------------------------------------------------------------------------

let _panel = null;
let _activePanelTab = "gpu";

export function getPanel()      { return _panel; }

// ---------------------------------------------------------------------------
// Panel metric helpers
// ---------------------------------------------------------------------------

function makePanelMetric(label, value) {
  const metric  = document.createElement("div");
  metric.className = "adlx-panel-metric";

  const labelEl = document.createElement("div");
  labelEl.className   = "adlx-panel-metric-label";
  labelEl.textContent = label;

  const valueEl = document.createElement("div");
  valueEl.className   = "adlx-panel-metric-value";
  valueEl.textContent = value;

  metric.appendChild(labelEl);
  metric.appendChild(valueEl);
  return { metric, valueEl };
}

function makePanelSection(title, metrics) {
  const section = document.createElement("section");
  section.className = "adlx-panel-section";

  const titleEl = document.createElement("div");
  titleEl.className   = "adlx-panel-section-title";
  titleEl.textContent = title;

  const grid = document.createElement("div");
  grid.className = "adlx-panel-metrics";

  const valueRefs = {};
  for (const item of metrics) {
    const { metric, valueEl } = makePanelMetric(item.label, item.initial);
    grid.appendChild(metric);
    valueRefs[item.key] = valueEl;
  }

  section.appendChild(titleEl);
  section.appendChild(grid);
  return { section, valueRefs };
}

// ---------------------------------------------------------------------------
// Sparklines
// ---------------------------------------------------------------------------

function makeSparkline(color) {
  const wrap = document.createElement("div");
  wrap.className = "adlx-panel-sparkline";

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 220 46");
  svg.setAttribute("preserveAspectRatio", "none");

  const area = document.createElementNS("http://www.w3.org/2000/svg", "path");
  area.setAttribute("class", "adlx-panel-sparkline-area");
  area.style.setProperty("--spark-color", color);

  const line = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
  line.setAttribute("class", "adlx-panel-sparkline-line");
  line.style.setProperty("--spark-color", color);

  svg.appendChild(area);
  svg.appendChild(line);
  wrap.appendChild(svg);
  return { wrap, svg, area, line };
}

export function renderSparkline(target, values) {
  if (!target) return;
  if (!values.length) {
    target.line.setAttribute("points", "");
    target.area.setAttribute("d", "");
    return;
  }

  const width  = 220;
  const height = 46;
  const min    = Math.min(...values);
  const max    = Math.max(...values);
  const span   = Math.max(max - min, 0.001);
  const points = values.map((value, index) => {
    const x          = values.length === 1 ? width / 2 : (index / (values.length - 1)) * width;
    const normalized = (value - min) / span;
    const y          = height - 4 - (normalized * (height - 12));
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  target.line.setAttribute("points", points.join(" "));
  const areaPath = `M 0 ${height} L ${points.join(" L ")} L ${width} ${height} Z`;
  target.area.setAttribute("d", areaPath);
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

function makePanelTabs(items) {
  const nav = document.createElement("div");
  nav.className = "adlx-panel-tabs";

  const buttons = {};
  for (const item of items) {
    const button = document.createElement("button");
    button.type        = "button";
    button.className   = "adlx-panel-tab";
    button.textContent = item.label;
    button.addEventListener("click", () => setActivePanelTab(item.key));
    nav.appendChild(button);
    buttons[item.key] = button;
  }

  return { nav, buttons };
}

export function setActivePanelTab(key) {
  _activePanelTab = key;
  if (!_panel) return;

  for (const [tabKey, button] of Object.entries(_panel._tabButtons || {})) {
    button.classList.toggle("is-active", tabKey === key);
  }
  for (const [tabKey, view] of Object.entries(_panel._tabViews || {})) {
    view.hidden = tabKey !== key;
  }
}

// ---------------------------------------------------------------------------
// Panel drag + position persistence
// ---------------------------------------------------------------------------

const PANEL_POS_KEY = "ADLX_Mon.PanelPosition";

function clampPanelPosition(left, top, width, height) {
  const maxLeft = Math.max(8, window.innerWidth  - width  - 8);
  const maxTop  = Math.max(8, window.innerHeight - height - 8);
  return {
    left: Math.min(Math.max(8, left), maxLeft),
    top:  Math.min(Math.max(8, top),  maxTop),
  };
}

function savePanelPosition(left, top) {
  try { localStorage.setItem(PANEL_POS_KEY, JSON.stringify({ left, top })); } catch (_) {}
}

function applyPanelPosition(panel, left, top) {
  const width  = panel.offsetWidth  || 360;
  const height = panel.offsetHeight || 240;
  const pos    = clampPanelPosition(left, top, width, height);
  panel.style.left  = `${pos.left}px`;
  panel.style.top   = `${pos.top}px`;
  panel.style.right = "auto";
  savePanelPosition(pos.left, pos.top);
  panel._positionRestored = true;
}

function restorePanelPosition(panel) {
  if (panel.hidden) return false;
  try {
    const raw    = localStorage.getItem(PANEL_POS_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    if (typeof parsed?.left !== "number" || typeof parsed?.top !== "number") return false;
    applyPanelPosition(panel, parsed.left, parsed.top);
    return true;
  } catch (_) {}
  return false;
}

function enablePanelDrag(panel, handle) {
  let dragState = null;

  const onPointerMove = (event) => {
    if (!dragState) return;
    applyPanelPosition(panel, event.clientX - dragState.offsetX, event.clientY - dragState.offsetY);
  };

  const stopDrag = () => {
    if (!dragState) return;
    dragState = null;
    panel.classList.remove("is-dragging");
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup",     stopDrag);
    window.removeEventListener("pointercancel", stopDrag);
  };

  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    if (event.target.closest("button")) return;
    const rect = panel.getBoundingClientRect();
    dragState = { offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top };
    panel.classList.add("is-dragging");
    handle.setPointerCapture?.(event.pointerId);
    window.addEventListener("pointermove",   onPointerMove);
    window.addEventListener("pointerup",     stopDrag);
    window.addEventListener("pointercancel", stopDrag);
    event.preventDefault();
  });

  window.addEventListener("resize", () => {
    if (panel.hidden) return;
    const rect = panel.getBoundingClientRect();
    applyPanelPosition(panel, rect.left, rect.top);
  });
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

export function buildPanel(onClose) {
  const panel = document.createElement("div");
  panel.id        = "adlx-panel";
  panel.className = "adlx-floating-panel";
  panel.hidden    = true;

  // Header
  const header    = document.createElement("div");
  header.className = "adlx-panel-header";

  const titleWrap = document.createElement("div");
  titleWrap.className = "adlx-panel-titlewrap";

  const title = document.createElement("div");
  title.className   = "adlx-panel-title";
  title.textContent = "ADLX Monitor";

  const subtitle = document.createElement("div");
  subtitle.className   = "adlx-panel-subtitle";
  subtitle.textContent = "Waiting for telemetry...";

  titleWrap.appendChild(title);
  titleWrap.appendChild(subtitle);

  const close = document.createElement("button");
  close.type        = "button";
  close.className   = "adlx-panel-close";
  close.textContent = "×";
  close.addEventListener("click", () => onClose());

  header.appendChild(titleWrap);
  header.appendChild(close);

  // Body
  const body = document.createElement("div");
  body.className = "adlx-panel-body";

  const { nav, buttons } = makePanelTabs([
    { key: "gpu",       label: "GPU" },
    { key: "system",    label: "System" },
    { key: "predictor", label: "Predictor" },
  ]);

  const views = document.createElement("div");
  views.className = "adlx-panel-views";

  const gpuView       = document.createElement("div");
  gpuView.className   = "adlx-panel-view";
  const systemView    = document.createElement("div");
  systemView.className = "adlx-panel-view";
  const predictorView = document.createElement("div");
  predictorView.className = "adlx-panel-view";

  const gpuSection = makePanelSection("GPU", [
    { key: "gpuLoad",  label: "LOAD",  initial: "--%" },
    { key: "gpuTemp",  label: "TEMP",  initial: "--C" },
    { key: "gpuVram",  label: "VRAM",  initial: "--/--G" },
    { key: "gpuPower", label: "POWER", initial: "--W" },
  ]);
  const sysSection = makePanelSection("SYSTEM", [
    { key: "cpu",      label: "CPU",      initial: "--%" },
    { key: "ram",      label: "RAM",      initial: "--%" },
    { key: "commit",   label: "COMMIT",   initial: "--/--G" },
    { key: "ramUsage", label: "RAM USED", initial: "--/--G" },
  ]);
  const predictorSection = makePanelSection("PREDICTOR", [
    { key: "predictor", label: "SUCCESS", initial: "--%" },
    { key: "predTotal", label: "MODELS",  initial: "--G" },
    { key: "predPeak",  label: "PEAK",    initial: "--G" },
    { key: "predVRAM",  label: "EFF. VRAM", initial: "--G" },
  ]);

  const errorBox = document.createElement("div");
  errorBox.className = "adlx-panel-error";
  errorBox.hidden    = true;

  const gpuSpark    = makeSparkline("#36cfc9");
  const systemSpark = makeSparkline("#b37feb");

  gpuSection.section.insertBefore(gpuSpark.wrap,    gpuSection.section.lastChild);
  sysSection.section.insertBefore(systemSpark.wrap, sysSection.section.lastChild);

  gpuView.appendChild(gpuSection.section);
  systemView.appendChild(sysSection.section);
  predictorView.appendChild(predictorSection.section);

  views.appendChild(gpuView);
  views.appendChild(systemView);
  views.appendChild(predictorView);

  body.appendChild(nav);
  body.appendChild(errorBox);
  body.appendChild(views);

  panel.appendChild(header);
  panel.appendChild(body);

  // Attach internal refs
  panel._subtitle   = subtitle;
  panel._error      = errorBox;
  panel._sparklines = { gpu: gpuSpark, system: systemSpark };
  panel._values     = { ...gpuSection.valueRefs, ...sysSection.valueRefs, ...predictorSection.valueRefs };
  panel._header     = header;
  panel._tabButtons = buttons;
  panel._tabViews   = { gpu: gpuView, system: systemView, predictor: predictorView };

  _panel = panel;
  return panel;
}

export function mountPanel(panel) {
  document.body.appendChild(panel);
  enablePanelDrag(panel, panel._header);
}

export function togglePanel(force) {
  if (!_panel) return;
  const next = typeof force === "boolean" ? force : _panel.hidden;
  _panel.hidden = !next;

  if (next) {
    requestAnimationFrame(() => {
      if (!_panel || _panel.hidden) return;
      if (restorePanelPosition(_panel)) return;
      if (_panel._positionRestored) return;
      const rect = _panel.getBoundingClientRect();
      applyPanelPosition(_panel, rect.left, rect.top);
    });
  }
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

export function renderPanel(snap) {
  if (!_panel) return;

  if (snap.error) {
    _panel._subtitle.textContent = snap.gpu_vendor
      ? `${String(snap.gpu_vendor).toUpperCase()} Provider Error`
      : "Provider Error";
    _panel._error.hidden    = false;
    _panel._error.textContent = snap.error;
    _panel._values.gpuLoad.textContent  = "ERR";
    _panel._values.gpuTemp.textContent  = "ERR";
    _panel._values.gpuVram.textContent  = "ERR";
    _panel._values.gpuPower.textContent = "ERR";
    _panel._values.cpu.textContent      = "--";
    _panel._values.ram.textContent      = "--";
    _panel._values.commit.textContent   = "--";
    _panel._values.ramUsage.textContent = "--";
    _panel._values.predictor.textContent = "--";
    _panel._values.predTotal.textContent = "--";
    _panel._values.predPeak.textContent  = "--";
    _panel._values.predVRAM.textContent  = "--";
    renderSparkline(_panel._sparklines?.gpu,    history.gpuVramUsedGb);
    renderSparkline(_panel._sparklines?.system, history.ramUsedGb);
    return;
  }

  _panel._error.hidden    = true;
  _panel._error.textContent = "";

  const predModels = getPredModels();
  const predTotal  = predModels.reduce((sum, item) => sum + (item.size || 0), 0);
  const predPeak   = predModels.length > 0 ? Math.max(...predModels.map(item => item.size || 0)) : 0;
  const pred       = calcPrediction(predTotal, predPeak, snap);

  _panel._subtitle.textContent               = snap.device_name || "AMD GPU";
  _panel._values.gpuLoad.textContent         = `${Number(snap.gpu_load_pct ?? 0).toFixed(1)}%`;
  _panel._values.gpuTemp.textContent         = snap.gpu_temp_c >= 0 ? `${Math.round(snap.gpu_temp_c)}C` : "N/A";
  _panel._values.gpuVram.textContent         = `${Number(snap.vram_driver_used_gb ?? 0).toFixed(1)}/${Number(snap.vram_total_gb ?? 0).toFixed(1)}G`;
  _panel._values.gpuPower.textContent        = snap.power_available && snap.power_w >= 0 ? `${Number(snap.power_w).toFixed(0)}W` : "N/A";
  _panel._values.cpu.textContent             = `${Number(snap.cpu_pct ?? 0).toFixed(1)}%`;
  _panel._values.ram.textContent             = `${Number(snap.ram_pct ?? 0).toFixed(1)}%`;
  _panel._values.commit.textContent          = `${Number(snap.commit_used_gb ?? 0).toFixed(1)}/${Number(snap.commit_limit_gb ?? 0).toFixed(1)}G`;
  _panel._values.ramUsage.textContent        = `${Number(snap.ram_used_gb ?? 0).toFixed(1)}/${Number(snap.ram_total_gb ?? 0).toFixed(1)}G`;
  _panel._values.predictor.textContent       = `${pred.rate}%`;
  _panel._values.predTotal.textContent       = `${predTotal.toFixed(2)}G`;
  _panel._values.predPeak.textContent        = `${predPeak.toFixed(2)}G`;
  _panel._values.predVRAM.textContent        = `${pred.vEff.toFixed(1)}G`;
  renderSparkline(_panel._sparklines?.gpu,    history.gpuVramUsedGb);
  renderSparkline(_panel._sparklines?.system, history.ramUsedGb);
}
