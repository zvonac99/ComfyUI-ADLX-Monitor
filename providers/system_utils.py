"""Shared system-level helpers for CPU and memory telemetry."""

import ctypes
import logging
import os
from typing import Tuple

logger = logging.getLogger("ADLXMonitor")


def get_cpu_info() -> Tuple[str, int]:
    """Return (model_name, logical_thread_count). Called once at startup."""
    model = ""
    try:
        import winreg

        key = winreg.OpenKey(
            winreg.HKEY_LOCAL_MACHINE,
            r"HARDWARE\DESCRIPTION\System\CentralProcessor\0",
        )
        model, _ = winreg.QueryValueEx(key, "ProcessorNameString")
        winreg.CloseKey(key)
        model = " ".join(model.strip().split())
    except Exception:
        try:
            import platform

            model = platform.processor()
        except Exception:
            model = "Unknown CPU"

    threads = 0
    try:
        import psutil

        threads = psutil.cpu_count(logical=True) or 0
    except Exception:
        threads = os.cpu_count() or 0

    return model, threads


def read_commit_charge() -> Tuple[float, float]:
    """Return (commit_used_gb, commit_limit_gb) via GlobalMemoryStatusEx."""
    try:
        class _MEMSTATEX(ctypes.Structure):
            _fields_ = [
                ("dwLength", ctypes.c_ulong),
                ("dwMemoryLoad", ctypes.c_ulong),
                ("ullTotalPhys", ctypes.c_ulonglong),
                ("ullAvailPhys", ctypes.c_ulonglong),
                ("ullTotalPageFile", ctypes.c_ulonglong),
                ("ullAvailPageFile", ctypes.c_ulonglong),
                ("ullTotalVirtual", ctypes.c_ulonglong),
                ("ullAvailVirtual", ctypes.c_ulonglong),
                ("ullAvailExtVirtual", ctypes.c_ulonglong),
            ]

        stat = _MEMSTATEX()
        stat.dwLength = ctypes.sizeof(_MEMSTATEX)
        ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(stat))
        gb = 1024 ** 3
        limit = stat.ullTotalPageFile / gb
        used = (stat.ullTotalPageFile - stat.ullAvailPageFile) / gb
        return round(used, 2), round(limit, 2)
    except Exception:
        return 0.0, 0.0


def read_cpu_ram_stats(psutil_ok: bool) -> dict:
    """Return CPU and RAM metrics via psutil + GlobalMemoryStatusEx."""
    if not psutil_ok:
        return {}

    try:
        import psutil

        cpu_pct = psutil.cpu_percent(interval=None)
        cpu_freq = psutil.cpu_freq()
        ram = psutil.virtual_memory()
        gb = 1024 ** 3
        commit_used, commit_limit = read_commit_charge()
        return {
            "cpu_pct": cpu_pct,
            "cpu_freq_ghz": round(cpu_freq.current / 1000.0, 2) if cpu_freq else 0.0,
            "ram_pct": ram.percent,
            "ram_total_gb": ram.total / gb,
            "ram_used_gb": ram.used / gb,
            "ram_free_gb": ram.available / gb,
            "commit_used_gb": commit_used,
            "commit_limit_gb": commit_limit,
        }
    except Exception as exc:
        logger.error(f"ADLXMonitor: cpu/ram stats error — {exc}")
        return {}


__all__ = ["get_cpu_info", "read_commit_charge", "read_cpu_ram_stats"]