# Changelog

### v1.1.0 — 2026-05-09

#### ✨ Fork Release

- **ADLX fork identity**: Renamed the runtime asset/server prefixes from `xpu_*` to `adlx_*` so the fork's file and UI surface match its AMD-first scope.
- **AMD-only provider selection**: Removed Intel/NVIDIA provider modes from the active runtime path and made unsupported environments surface an explicit AMD configuration error.
- **Metadata cleanup**: Updated package metadata and frontend versioning for the first AMD-focused fork release.

#### ✨ New Features

- **Floating Overlay mode**: Added a new `UI Mode` setting (`Top Bar (new menu)` / `Floating Overlay`). In overlay mode the chip detaches from the top bar and becomes a draggable pill that floats over the canvas — works with both old and new ComfyUI menu systems. Position is persisted in `localStorage` and restored on reload.
- **Anchor-aware panel positioning**: When the panel is opened from the floating chip, it automatically appears above or below the chip depending on its position on screen.

#### 🔧 Improvements

- **Frontend naming cleanup**: Migrated active CSS/DOM class prefixes away from the legacy `xpu` / `xpusys` naming in the shipped fork assets.
- **Packaging updates**: Release packaging now includes `adlx_server.py`, `adlx_monitor.js`, and `adlx_monitor.css`.

#### 🐛 Bug Fixes

- **Overlay chip position persistence**: Fixed a bug where the chip position was always saved as `{left: 8, top: 8}` on every reload. Position is now saved only after a real drag interaction, never during initial layout.
