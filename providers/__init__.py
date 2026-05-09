"""
providers/__init__.py — AMD-first provider registry for the fork.

This fork intentionally narrows runtime support to AMD telemetry paths:

1. torch.cuda.is_available() + torch.version.roc → AMDProvider (ROCm)
2. ADLX available on Windows                     → AMDProvider (ADLX)

If neither AMD path is available, the fork surfaces a clear error instead of
falling back to Intel or NVIDIA providers.
"""

import logging
import os
from .base import BaseGPUProvider, ErrorGPUProvider, GPUSnapshot
from .config_store import DEFAULT_PROVIDER_MODE, load_plugin_config

logger = logging.getLogger("ADLXMonitor")


def _get_provider_mode() -> str:
    return load_plugin_config().get("provider_mode", DEFAULT_PROVIDER_MODE)


def _build_provider(provider_name: str, interval_ms: int) -> BaseGPUProvider:
    if provider_name == "amd":
        from .amd import AMDProvider
        return AMDProvider(interval_ms=interval_ms)
    raise ValueError(f"Unsupported provider name: {provider_name}")


def _provider_ready(provider_name: str, provider: BaseGPUProvider) -> bool:
    if provider_name == "amd":
        return bool(getattr(provider, "_adlx_ok", False) or getattr(provider, "_rocm_ok", False))
    return False


def _provider_failure_reason(provider_name: str, provider: BaseGPUProvider) -> str:
    if provider_name == "amd":
        adlx_ok = bool(getattr(provider, "_adlx_ok", False))
        rocm_ok = bool(getattr(provider, "_rocm_ok", False))
        torch_ok = bool(getattr(provider, "_torch_ok", False))
        if os.name == "nt" and not adlx_ok:
            if not _can_try_amd_adlx():
                return "ADLXPybind is not installed or cannot be imported on Windows."
            if torch_ok:
                return "torch.cuda is available, but ADLX could not expose AMD telemetry."
            return "ADLX is present, but no AMD GPU telemetry could be initialized."
        if not rocm_ok and not torch_ok:
            return "Neither ROCm SMI nor torch.cuda is available for AMD."
        if not rocm_ok:
            return "torch.cuda is available, but ROCm SMI telemetry is unavailable."
        return "AMD provider did not expose usable telemetry."

    return "Requested provider could not be initialized."


def _try_provider(provider_name: str, interval_ms: int) -> tuple[BaseGPUProvider | None, str | None]:
    try:
        provider = _build_provider(provider_name, interval_ms)
        if _provider_ready(provider_name, provider):
            return provider, None
        reason = _provider_failure_reason(provider_name, provider)
        provider.stop()
        return None, reason
    except Exception as exc:
        logger.warning(f"ADLXMonitor: {provider_name} provider init failed — {exc}")
        return None, str(exc)


def _make_forced_provider_error(provider_name: str, reason: str | None, interval_ms: int) -> BaseGPUProvider:
    reason_text = reason or "No detailed diagnostic reason was captured."
    message = (
        f"Forced provider '{provider_name}' is unavailable. "
        f"Reason: {reason_text} "
        "Change Provider Mode or fix the driver/runtime."
    )
    return ErrorGPUProvider(message, gpu_vendor=provider_name, interval_ms=interval_ms)


def auto_detect_provider(interval_ms: int = 1000) -> BaseGPUProvider:
    """
    Detect AMD telemetry support and return the AMD provider.

    This fork no longer falls back to Intel or NVIDIA providers.
    """

    provider_mode = _get_provider_mode()

    if provider_mode.startswith("force-"):
        forced_name = provider_mode.split("-", 1)[1]
        provider, reason = _try_provider(forced_name, interval_ms)
        if provider is not None:
            logger.info(f"ADLXMonitor: forced provider mode selected {forced_name!r}.")
            return provider
        logger.error(
            f"ADLXMonitor: forced provider {forced_name!r} unavailable — {reason or 'unknown reason'}."
        )
        return _make_forced_provider_error(forced_name, reason, interval_ms)

    if provider_mode.startswith("prefer-"):
        preferred_name = provider_mode.split("-", 1)[1]
        provider, reason = _try_provider(preferred_name, interval_ms)
        if provider is not None:
            logger.info(f"ADLXMonitor: preferred provider mode selected {preferred_name!r}.")
            return provider
        logger.info(
            f"ADLXMonitor: preferred provider {preferred_name!r} unavailable — {reason or 'unknown reason'}; continuing with auto detection."
        )

    # --- Primary: follow torch (mirrors ComfyUI model_management.py) ---
    if _detect_amd_torch_rocm():
        logger.info("ADLXMonitor: torch.cuda + ROCm — using AMDProvider.")
        from .amd import AMDProvider
        return AMDProvider(interval_ms=interval_ms)

    # Prefer ADLX on Windows before relying on ROCm-style torch detection.
    # Some AMD-on-Windows stacks expose a CUDA-like torch surface even though
    # the desired telemetry path in this fork is ADLX, not generic torch stats.
    if _can_try_amd_adlx():
        from .amd import AMDProvider

        try:
            provider = AMDProvider(interval_ms=interval_ms)
            if getattr(provider, "_adlx_ok", False) or getattr(provider, "_rocm_ok", False):
                logger.info("ADLXMonitor: AMD telemetry available — using AMDProvider.")
                return provider

            provider.stop()
            logger.info("ADLXMonitor: ADLX package found but AMD telemetry is unavailable.")
        except Exception as exc:
            logger.warning(f"ADLXMonitor: AMDProvider init failed during detection — {exc}")

    logger.error(
        "ADLXMonitor: no supported AMD telemetry path detected — exposing configuration error."
    )
    return ErrorGPUProvider(
        "No supported AMD telemetry path was detected. Install ADLXPybind on Windows or use an AMD ROCm environment.",
        gpu_vendor="amd",
        interval_ms=interval_ms,
    )


# ---------------------------------------------------------------------------
# Primary detectors — AMD torch-based checks
# ---------------------------------------------------------------------------

def _detect_amd_torch_rocm() -> bool:
    """Return True if torch.cuda is available and backed by ROCm."""
    try:
        import torch
        return torch.cuda.is_available() and torch.version.roc is not None
    except Exception:
        return False


def _can_try_amd_adlx() -> bool:
    """Return True if Windows AMD ADLX support is installed and worth trying."""
    if os.name != "nt":
        return False

    try:
        import ADLXPybind  # noqa: F401
        return True
    except Exception:
        return False


__all__ = [
    "BaseGPUProvider",
    "ErrorGPUProvider",
    "GPUSnapshot",
    "auto_detect_provider",
]
