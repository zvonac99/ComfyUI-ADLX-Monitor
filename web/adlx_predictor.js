/**
 * adlx_predictor.js — Workflow VRAM prediction + model-file scanning.
 * Imported by adlx_monitor.js.
 */

import { api } from "../../scripts/api.js";
import { app } from "../../scripts/app.js";

// ---------------------------------------------------------------------------
// Predictor state
// ---------------------------------------------------------------------------

let _predModels = [];   // [{ name: string, size: number }]
let _predTimer  = null; // debounce handle

export function getPredModels() { return _predModels; }

// ---------------------------------------------------------------------------
// Predictor — success-rate estimation with a three-tier memory model.
// ---------------------------------------------------------------------------

const PRED_ALPHA = 0.9;

/**
 * Estimate workflow success probability for the current AMD memory state.
 * @param {number} mTotal  — sum of all active model file sizes in GB
 * @param {number} mPeak   — largest single model file size in GB
 * @param {object|null} snap — latest telemetry snapshot
 */
export function calcPrediction(mTotal, mPeak, snap) {
  const vFree  = snap?.vram_free_gb        ?? 0;
  const vAlloc = snap?.vram_allocated_gb   ?? 0;
  const vRsv   = snap?.vram_reserved_gb    ?? 0;
  const rFree  = snap?.ram_free_gb         ?? 0;
  const cUsed  = snap?.commit_used_gb      ?? 0;
  const cLimit = snap?.commit_limit_gb     ?? 0;

  // Reclaimable VRAM = free VRAM + currently allocated/reserved torch memory.
  const vReclaim = vFree + vAlloc + vRsv;
  const vEff     = Math.max(0.1, vReclaim * PRED_ALPHA);
  const cRam  = rFree;
  const sVirt = Math.max(0, cLimit - cUsed);

  const PLATFORM_GAMMA = { "amd": 1.0 };
  const gpuVendor = snap?.gpu_vendor ?? "amd";
  const gamma = PLATFORM_GAMMA[gpuVendor] ?? 1.0;

  const dPeak = Math.max(0, mPeak - vEff);
  const vEffPlatform = vEff * gamma;
  const pPeak = dPeak === 0 ? 1 : Math.max(0.02, Math.exp(-3 * dPeak / vEffPlatform));

  const dLoad = Math.max(0, mTotal - vEff);
  let pLoad;
  if (dLoad === 0) {
    pLoad = 1;
  } else if (cRam > 0 && dLoad <= cRam) {
    pLoad = 1 - 0.3 * Math.pow(dLoad / cRam, 0.6);
  } else if (sVirt > 0 && dLoad <= cRam + sVirt) {
    pLoad = 0.05 + 0.65 * Math.pow(1 - (dLoad - cRam) / sVirt, 2);
  } else {
    pLoad = Math.max(0, 0.05 - 0.1 * (dLoad - cRam - sVirt));
  }

  const rate = Math.max(0, Math.min(100, Math.round(pPeak * pLoad * 100)));

  let color, label;
  if (rate >= 95) {
    color = "#52c41a"; label = "Smooth";
  } else if (rate >= 80) {
    color = "#afff00"; label = "Safe";
  } else if (rate >= 40) {
    color = "#faad14"; label = "Warning";
  } else {
    color = "#ff4d4f"; label = "Critical";
  }

  return { rate, color, label, dPeak, dLoad, vEff, cRam, sVirt, pPeak, pLoad, gamma, gpuVendor };
}

// ---------------------------------------------------------------------------
// Model widget hooks — keeps predictor in sync with graph changes
// ---------------------------------------------------------------------------

const MODEL_EXTS = [".safetensors", ".ckpt", ".pt", ".pth", ".bin", ".gguf", ".sft", ".pkl"];

export function applyModelHook(node, onUpdate) {
  let hasModel = false;
  node.widgets?.forEach(w => {
    if (w.type !== "combo" || w._adlxPredHooked) return;
    const wn = w.name?.toLowerCase() || "";
    const isModel =
      ["model", "ckpt", "vae", "lora", "control", "clip", "unet"].some(k => wn.includes(k)) ||
      w.options?.values?.some(v => {
        const s = String(v).toLowerCase();
        return MODEL_EXTS.some(ext => s.endsWith(ext));
      });
    if (!isModel) return;
    hasModel = true;
    const origCb = w.callback;
    w.callback = function () {
      const r = origCb ? origCb.apply(this, arguments) : undefined;
      onUpdate();
      return r;
    };
    w._adlxPredHooked = true;
  });

  if (hasModel && !node._adlxNodeHooked) {
    const origRemoved = node.onRemoved;
    node.onRemoved = function () {
      if (origRemoved) origRemoved.apply(this, arguments);
      onUpdate();
    };
    let _mode = node.mode;
    Object.defineProperty(node, "mode", {
      get: function () { return _mode; },
      set: function (v) {
        if (_mode !== v) { _mode = v; onUpdate(); }
      },
      configurable: true,
    });
    node._adlxNodeHooked = true;
  }
}

// ---------------------------------------------------------------------------
// Debounced predictor entry point
// ---------------------------------------------------------------------------

/** Call this to trigger a debounced re-scan + re-render. */
export function schedulePredictor(onFetched) {
  if (_predTimer) clearTimeout(_predTimer);
  _predTimer = setTimeout(() => _doPredictorFetch(onFetched), 150);
}

const ALLOWED_EXTS = [".safetensors", ".gguf", ".ckpt", ".pt", ".pth", ".bin", ".onnx", ".pkl"];

async function _doPredictorFetch(onFetched) {
  const nodes = app.graph?._nodes;
  if (!nodes) return;

  const uniqueModels = new Map();

  nodes.forEach(node => {
    if (node.mode !== 0) return;
    node.widgets?.forEach(w => {
      if (typeof w.value !== "string") return;
      const value = w.value.trim();
      if (!value) return;
      const ext = value.substring(value.lastIndexOf(".")).toLowerCase();
      if (!ALLOWED_EXTS.includes(ext)) return;
      if (!uniqueModels.has(value)) {
        const lastSlash     = value.lastIndexOf("/");
        const lastBackslash = value.lastIndexOf("\\");
        const sepIndex      = Math.max(lastSlash, lastBackslash);
        uniqueModels.set(value, {
          path: value,
          name: sepIndex >= 0 ? value.substring(sepIndex + 1) : value,
        });
      }
    });
  });

  const activeModels = Array.from(uniqueModels.values());

  try {
    const r = await api.fetchApi("/adlxmon/model_sizes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ models: activeModels }),
    });
    if (r.ok) {
      const data = await r.json();
      _predModels = data.models || [];
      onFetched();
    }
  } catch (_) {}
}
