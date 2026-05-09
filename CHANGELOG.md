# Changelog

### v1.1.0 — 2026-05-09

#### ✨ Fork Release

- **ADLX fork identity**: Renamed the runtime asset/server prefixes from `xpu_*` to `adlx_*` so the fork's file and UI surface match its AMD-first scope.
- **AMD-only provider selection**: Removed Intel/NVIDIA provider modes from the active runtime path and made unsupported environments surface an explicit AMD configuration error.
- **Metadata cleanup**: Updated package metadata and frontend versioning for the first AMD-focused fork release.

#### 🔧 Improvements

- **Frontend naming cleanup**: Migrated active CSS/DOM class prefixes away from the legacy `xpu` / `xpusys` naming in the shipped fork assets.
- **Packaging updates**: Release packaging now includes `adlx_server.py`, `adlx_monitor.js`, and `adlx_monitor.css`.

### v1.0.2 — 2026-04-01

#### ✨ New Features

- **AMD GPU support**: Added `AMDProvider` for AMD GPUs running ROCm PyTorch.
  - Full support for VRAM, GPU load, temperature, power, and clock frequency via `rocm_smi`
  - Graceful fallback to basic `torch.cuda` stats when `rocm_smi_lib` is not installed
  - Optional dependency: `pip install rocm_smi_lib`

#### 🔧 Improvements

- **Provider auto-detection**: Upgraded detection logic to use `torch.version.roc` for reliable AMD vs NVIDIA disambiguation — no longer depends on `pynvml` failure as a side-effect signal
- **Package script**: Switched to whitelist mode (`pack_plugin.py`) — only explicitly listed files/directories are included, preventing dev/test scripts from leaking into releases

#### 🖥️ Platform Support Update

- AMD (ROCm) support status changed from *planned* to **fully supported**

---

### v1.0.1 — 2026-03-28

#### 🔧 Improvements

- **Model detection**: Removed node-type-based inference; now uses path-based lookup across all model directories for better compatibility with custom loaders (GGUF, etc.)
- **Subfolder support**: Models in subdirectories (e.g., `unet/subfolder/model.gguf`) are now correctly detected
- **Performance**: Optimized model lookup with prioritized directory search and fallback recursion

#### 🐛 Bug Fixes

- Fixed model size detection for nodes like `GGUFLoaderKJ` that don't follow standard naming conventions

---

### v1.0.0 — 2026-03-17

First stable release.

#### ✨ Features

- **Seven-capsule status bar** embedded in the ComfyUI top menu bar — PRED, CPU, RAM, GPU, VRAM, RSV, PWR — each expandable via hover
- **PRED — Workflow VRAM Predictor**: scans active model nodes, estimates peak VRAM demand and total load, outputs a composite success rate (hard constraint × soft constraint) before you run
- **GPU Engine** (load %, core clock, temperature)
- **VRAM** with three-layer breakdown: System & Environment / Models & Compute / Reserved Buffer
- **RSV** — PyTorch cache pool (active vs idle split)
- **PWR** — instantaneous power draw via dual-sample energy delta, with TGP load ratio; lock icon + tooltip when admin is not available
- **CPU** (utilization, real-time clock, model name, thread count)
- **RAM** (physical + virtual memory, used / free)
- Settings panel: refresh interval, font size, and per-capsule show/hide toggles
- Version badge and GitHub link in the About section of settings

#### 🖥️ Platform Support

- **Intel Arc (XPU)** — Level Zero Sysman; full support for power, frequency, and temperature (admin required on Windows)
- **NVIDIA (CUDA)** — pynvml; full support without elevated privileges
- **AMD (ROCm)** — added in v1.0.2

#### 🗂️ PCI ID Table (Intel Arc)

Covers all consumer and workstation cards with practical AI inference capability (≥ 8 GB VRAM or Pro series):

| Series | Models |
|--------|--------|
| Battlemage consumer | B770, B580, B580M, B570, B570M |
| Battlemage Pro | Arc Pro B60 (24 GB), Arc Pro B50 (16 GB) |
| Alchemist consumer desktop | A770, A750, A580, A380 |
| Alchemist consumer mobile | A770M, A730M, A570M, A550M, A530M |
| Alchemist Pro | Arc Pro A60, Arc Pro A60M, Arc Pro A40/A50, Arc Pro A30M |

Low-end consumer cards (A310, A370M, A350M) and the embedded E-series are excluded — they have insufficient VRAM for practical AI workloads.
