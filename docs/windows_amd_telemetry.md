# Windows AMD Telemetry

This note documents only the Windows AMD telemetry path used by ComfyUI-ADLX-Monitor.

It is intentionally narrower than the full README so the ADLX-based solution can be reviewed, reused, or requested later without depending on the original upstream project context.

---

## Scope

This fork targets AMD telemetry on Windows first.

- ADLX is the primary vendor telemetry backend on Windows.
- ROCm remains a secondary fallback for AMD environments where it is available.
- PyTorch allocator numbers are still read through `torch.cuda.*` APIs, because AMD PyTorch exposes allocator stats there.
- Unsupported environments surface an explicit configuration error instead of silently falling back to Intel or NVIDIA logic.

---

## Runtime Flow

The runtime is split by responsibility:

1. `ADLXPybind` / ADLX provides AMD device-facing telemetry when available.
2. `torch.cuda.memory_allocated()` and `torch.cuda.memory_reserved()` provide allocator usage for model and cache breakdown.
3. `psutil` and Windows memory APIs provide CPU, RAM, and commit statistics.

In practice, that means the plugin merges vendor telemetry and allocator telemetry rather than depending on one source for everything.

---

## What ADLX Supplies

On the Windows AMD path, ADLX is used for the hardware-facing metrics that PyTorch does not expose reliably:

- GPU name
- GPU load
- Core clock
- Temperature
- Driver-level VRAM totals and current usage
- Power telemetry when the installed driver exposes it

When multiple AMD GPUs are present, the provider selects the GPU with the largest VRAM capacity.

---

## What PyTorch Supplies

PyTorch is used only for allocator-state telemetry:

- `memory_allocated()` tracks model and live tensor usage
- `memory_reserved()` tracks the reserved cache pool

Those values feed the VRAM breakdown, reserved buffer reporting, and workflow predictor calculations.

On AMD, these values still come from the `torch.cuda` namespace. That is expected behavior in this fork and not a sign of NVIDIA-specific logic.

---

## Provider Modes

The persisted provider modes are:

- `auto`
- `prefer-amd`
- `force-amd`

Behavior:

- `auto` selects the first AMD telemetry path that can be initialized successfully.
- `prefer-amd` explicitly attempts the AMD provider first, then continues with the same AMD-only detection path.
- `force-amd` does not fall back; if AMD telemetry cannot be initialized, the plugin shows a visible configuration error.

This is deliberate. The fork is meant to fail loudly on unsupported setups instead of pretending another GPU stack is valid.

---

## Failure Model

Typical failure cases on Windows are:

- `ADLXPybind` is not installed in the ComfyUI Python environment
- ADLX loads, but the driver does not expose usable telemetry
- `torch.cuda` is present but ADLX telemetry is unavailable
- power telemetry is unavailable even though other ADLX metrics work

The fork treats those as configuration or driver capability issues first. It does not assume the older Intel-style admin workflow from upstream.

---

## Files To Review

If this Windows AMD telemetry slice needs to be extracted or revisited later, the main implementation points are:

- `providers/amd.py`
- `providers/__init__.py`
- `providers/config_store.py`
- `providers/system_utils.py`
- `adlx_server.py`
- `web/adlx_monitor.js`

---

## Practical Test Notes

For local validation without the original plugin installed:

1. Remove or disable the original upstream plugin so only this fork is loaded.
2. Ensure `ADLXPybind` is installed in the Python environment used by ComfyUI.
3. Start ComfyUI and confirm the ADLX monitor chip appears.
4. Open the panel and verify GPU load, temperature, VRAM, and CPU/RAM metrics update.
5. If power shows as unavailable, treat that as a driver/backend capability gap unless the runtime reports a stronger provider error.

That is enough to validate the Windows AMD telemetry path independently of the older multi-vendor project history.