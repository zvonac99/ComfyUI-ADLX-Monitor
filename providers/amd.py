"""
providers/amd.py — AMD GPU hardware provider.

Windows telemetry : ADLXPybind (ADLX)
Linux telemetry   : rocm_smi
PyTorch stats     : torch.cuda.memory_allocated / memory_reserved

On Windows, ADLX is the preferred telemetry source for AMD GPUs.
On ROCm environments, rocm_smi remains the fallback provider.
"""

import logging
import os
from typing import Any, Optional, Tuple

from .base import BaseGPUProvider, GPUSnapshot
from .system_utils import get_cpu_info, read_cpu_ram_stats

logger = logging.getLogger("ADLXMonitor")


def _is_admin() -> bool:
    try:
        import ctypes
        return bool(ctypes.windll.shell32.IsUserAnAdmin())
    except Exception:
        return False


# ---------------------------------------------------------------------------
# AMDProvider
# ---------------------------------------------------------------------------

class AMDProvider(BaseGPUProvider):
    """
    Hardware provider for AMD GPUs.

    Uses ADLX on Windows and rocm_smi on ROCm environments.
    Falls back to basic torch.cuda stats if no vendor telemetry is available.

    When multiple AMD GPUs are present, the GPU with the largest VRAM is chosen.
    """

    GPU_VENDOR = "amd"

    def __init__(self, interval_ms: int = 1000):
        self._adlx_ok      = False
        self._rocm_ok      = False
        self._torch_ok     = False
        self._psutil_ok    = False
        self._device_index = 0
        self._is_admin     = _is_admin()
        self._cpu_model    = ""
        self._cpu_threads  = 0
        self._adlx         = None
        self._adlx_helper  = None
        self._adlx_system  = None
        self._adlx_perf    = None
        self._adlx_gpu     = None

        self._init_adlx()
        self._init_rocm()
        self._check_torch()
        self._check_psutil()

        # BaseGPUProvider.__init__ starts the polling thread — call last
        super().__init__(interval_ms=interval_ms)

        logger.info(
            f"ADLXMonitor: AMDProvider started "
            f"(adlx={self._adlx_ok}, rocm={self._rocm_ok}, torch={self._torch_ok})"
        )

    # ------------------------------------------------------------------
    # Initialisation
    # ------------------------------------------------------------------

    def _init_adlx(self) -> None:
        """Initialise ADLX on Windows and pick the most capable AMD GPU."""
        if os.name != "nt":
            return

        try:
            import ADLXPybind as ADLX

            helper = ADLX.ADLXHelper()
            result = helper.Initialize()
            if result != ADLX.ADLX_RESULT.ADLX_OK:
                logger.warning(f"ADLXMonitor: ADLX init returned {result}.")
                return

            system = helper.GetSystemServices()
            perf = system.GetPerformanceMonitoringServices() if system is not None else None
            gpus = system.GetGPUs() if system is not None else []

            if not gpus or perf is None:
                logger.warning("ADLXMonitor: ADLX initialized but no AMD GPU metrics are available.")
                return

            gpu = max(gpus, key=lambda item: getattr(item, "TotalVRAM")())

            self._adlx = ADLX
            self._adlx_helper = helper
            self._adlx_system = system
            self._adlx_perf = perf
            self._adlx_gpu = gpu
            self._adlx_ok = True
            logger.info(
                "ADLXMonitor: ADLX OK — selected AMD GPU %r with %.2f GB VRAM.",
                gpu.Name(),
                float(gpu.TotalVRAM()) / 1024.0,
            )
        except ImportError:
            logger.info("ADLXMonitor: ADLXPybind not installed — Windows AMD telemetry disabled.")
        except Exception as exc:
            logger.warning(f"ADLXMonitor: ADLX init error — {exc}")

    def _init_rocm(self) -> None:
        """Initialise ROCm SMI and grab the device handle for GPU 0."""
        if self._adlx_ok:
            return
        try:
            import rocm_smi
            rocm_smi.initializeRsmiTracking(0)
            self._rocm_ok = True
            name = rocm_smi.getCardName(0)
            logger.info(f"ADLXMonitor: rocm_smi OK — device[0] = {name!r}")
        except ImportError:
            logger.warning(
                "ADLXMonitor: rocm_smi not installed — "
                "run `pip install rocm_smi_lib` to enable full AMD support."
            )
        except Exception as exc:
            logger.warning(f"ADLXMonitor: rocm_smi init error — {exc}")

    def _check_torch(self) -> None:
        """Check if torch.cuda is available (AMD PyTorch uses cuda backend)."""
        try:
            import torch
            if torch.cuda.is_available():
                self._torch_ok = True
                logger.info(
                    f"ADLXMonitor: torch.cuda OK (AMD), "
                    f"device count={torch.cuda.device_count()}"
                )
            else:
                logger.warning("ADLXMonitor: torch.cuda not available.")
        except Exception as exc:
            logger.warning(f"ADLXMonitor: torch import error — {exc}")

    def _check_psutil(self) -> None:
        try:
            import psutil
            psutil.cpu_percent(interval=None)
            self._psutil_ok = True
            self._cpu_model, self._cpu_threads = get_cpu_info()
            logger.info(
                f"ADLXMonitor: psutil OK — CPU={self._cpu_model!r}, "
                f"threads={self._cpu_threads}"
            )
        except Exception as exc:
            logger.warning(f"ADLXMonitor: psutil not available — {exc}")

    # ------------------------------------------------------------------
    # Hardware reads
    # ------------------------------------------------------------------

    def _get_adlx_support_and_metrics(self) -> Tuple[Optional[Any], Optional[Any]]:
        if not self._adlx_ok or self._adlx_perf is None or self._adlx_gpu is None:
            return None, None
        try:
            support = self._adlx_perf.GetSupportedGPUMetrics(self._adlx_gpu)
            metrics = self._adlx_perf.GetCurrentGPUMetrics(self._adlx_gpu)
            return support, metrics
        except Exception:
            return None, None

    @staticmethod
    def _read_adlx_metric(support: Optional[Any], metrics: Optional[Any], support_name: str, metric_name: str, default: float) -> float:
        if support is None or metrics is None:
            return default
        try:
            if not getattr(support, support_name)():
                return default
            return float(getattr(metrics, metric_name)())
        except Exception:
            return default

    def _read_device_name(self) -> str:
        if self._adlx_ok and self._adlx_gpu is not None:
            try:
                return self._adlx_gpu.Name()
            except Exception:
                pass
        if self._rocm_ok:
            try:
                import rocm_smi
                return rocm_smi.getCardName(0)
            except Exception:
                pass
        return "AMD GPU"

    def _read_vram(self, support: Optional[Any] = None, metrics: Optional[Any] = None) -> Tuple[float, float, float]:
        """Return (free_gb, total_gb, driver_used_gb)."""
        if self._adlx_ok and self._adlx_gpu is not None:
            try:
                total_mb = float(self._adlx_gpu.TotalVRAM())
                used_mb = self._read_adlx_metric(support, metrics, "IsSupportedGPUVRAM", "GPUVRAM", 0.0)
                total_gb = total_mb / 1024.0
                used_gb = used_mb / 1024.0
                free_gb = max(total_gb - used_gb, 0.0)
                return free_gb, total_gb, used_gb
            except Exception:
                pass
        if self._rocm_ok:
            try:
                import rocm_smi
                # VRAM usage in bytes
                vram_used = rocm_smi.getMemUsedVdev(0)
                vram_free = rocm_smi.getMemFreeVdev(0)
                vram_total = rocm_smi.getMemSizeVdev(0)
                gb = 1024 ** 3
                return (
                    vram_free / gb,
                    vram_total / gb,
                    vram_used / gb,
                )
            except Exception:
                pass
        return 0.0, 0.0, 0.0

    def _read_torch_stats(self) -> Tuple[float, float]:
        """Return (allocated_gb, reserved_gb) from torch.cuda allocator."""
        if not self._torch_ok:
            return 0.0, 0.0
        try:
            import torch
            idx = self._device_index
            gb = 1024 ** 3
            return (
                torch.cuda.memory_allocated(idx) / gb,
                torch.cuda.memory_reserved(idx) / gb,
            )
        except Exception:
            return 0.0, 0.0

    def _read_gpu_load(self, support: Optional[Any] = None, metrics: Optional[Any] = None) -> float:
        """Return GPU utilisation % via rocm_smi."""
        if self._adlx_ok:
            return self._read_adlx_metric(support, metrics, "IsSupportedGPUUsage", "GPUUsage", 0.0)
        if not self._rocm_ok:
            return 0.0
        try:
            import rocm_smi
            # GPU busy percentage
            return float(rocm_smi.getGpuBusyVdev(0))
        except Exception:
            return 0.0

    def _read_gpu_freq_mhz(self, support: Optional[Any] = None, metrics: Optional[Any] = None) -> float:
        """Return current GPU clock in MHz via rocm_smi."""
        if self._adlx_ok:
            return self._read_adlx_metric(support, metrics, "IsSupportedGPUClockSpeed", "GPUClockSpeed", 0.0)
        if not self._rocm_ok:
            return 0.0
        try:
            import rocm_smi
            # SCLK (system clock) in MHz
            sclk = rocm_smi.getSingleClockSpeed(0)
            if isinstance(sclk, str):
                # Some versions return string like "2100 MHz"
                sclk = int(sclk.split()[0])
            return float(sclk)
        except Exception:
            return 0.0

    def _read_gpu_temp_c(self, support: Optional[Any] = None, metrics: Optional[Any] = None) -> float:
        """Return GPU temperature in °C via rocm_smi."""
        if self._adlx_ok:
            return self._read_adlx_metric(support, metrics, "IsSupportedGPUTemperature", "GPUTemperature", -1.0)
        if not self._rocm_ok:
            return -1.0
        try:
            import rocm_smi
            # Temperature in Celsius
            return float(rocm_smi.getTempVdev(0))
        except Exception:
            return -1.0

    def _read_power(self, support: Optional[Any] = None, metrics: Optional[Any] = None) -> Tuple[float, float, bool]:
        """Return (power_w, tgp_w, power_available) via rocm_smi."""
        if self._adlx_ok:
            board_power = self._read_adlx_metric(
                support,
                metrics,
                "IsSupportedGPUTotalBoardPower",
                "GPUTotalBoardPower",
                -1.0,
            )
            chip_power = self._read_adlx_metric(
                support,
                metrics,
                "IsSupportedGPUPower",
                "GPUPower",
                -1.0,
            )
            if board_power >= 0.0:
                return (chip_power if chip_power >= 0.0 else board_power), board_power, True
            if chip_power >= 0.0:
                return chip_power, chip_power, True
            return -1.0, 0.0, False
        if not self._rocm_ok:
            return -1.0, 0.0, False
        try:
            import rocm_smi
            # Power in Watts
            power_w = float(rocm_smi.getPowerVdev(0))
            # TDP (average power) - fallback to current if not available
            try:
                tgp_w = float(rocm_smi.getPowerCapVdev(0))
            except Exception:
                tgp_w = power_w  # Use current as estimate
            return power_w, tgp_w, True
        except Exception:
            return -1.0, 0.0, False

    # ------------------------------------------------------------------
    # Poll — called by BaseGPUProvider._loop() every interval
    # ------------------------------------------------------------------

    def _poll(self) -> None:
        """Collect all hardware metrics and push a fresh GPUSnapshot."""
        snap = GPUSnapshot(gpu_vendor=self.GPU_VENDOR)
        snap.is_admin = self._is_admin

        if not self._adlx_ok and not self._rocm_ok and not self._torch_ok:
            snap.error = "AMD telemetry unavailable"
        else:
            try:
                snap.device_name = self._read_device_name()
                support, metrics = self._get_adlx_support_and_metrics()

                # VRAM
                free_gb, total_gb, driver_used_gb = self._read_vram(support, metrics)
                snap.vram_total_gb       = total_gb
                snap.vram_free_gb        = free_gb
                snap.vram_driver_used_gb = driver_used_gb

                # torch allocator stats
                snap.vram_allocated_gb, snap.vram_reserved_gb = self._read_torch_stats()

                # GPU metrics
                snap.gpu_load_pct = self._read_gpu_load(support, metrics)
                snap.gpu_freq_mhz = self._read_gpu_freq_mhz(support, metrics)
                snap.gpu_temp_c   = self._read_gpu_temp_c(support, metrics)

                # Power
                snap.power_w, snap.tgp_w, snap.power_available = self._read_power(support, metrics)

            except Exception as exc:
                logger.debug(f"ADLXMonitor: AMDProvider poll error — {exc}")
                snap.error = str(exc)

        # CPU / RAM — always collected regardless of GPU state
        sys = read_cpu_ram_stats(self._psutil_ok)
        snap.cpu_pct         = sys.get("cpu_pct",         0.0)
        snap.cpu_freq_ghz    = sys.get("cpu_freq_ghz",    0.0)
        snap.cpu_model       = self._cpu_model
        snap.cpu_threads     = self._cpu_threads
        snap.ram_pct         = sys.get("ram_pct",         0.0)
        snap.ram_total_gb    = sys.get("ram_total_gb",    0.0)
        snap.ram_used_gb     = sys.get("ram_used_gb",      0.0)
        snap.ram_free_gb     = sys.get("ram_free_gb",      0.0)
        snap.commit_used_gb  = sys.get("commit_used_gb",   0.0)
        snap.commit_limit_gb = sys.get("commit_limit_gb",  0.0)

        self._update_snapshot(snap)


__all__ = ["AMDProvider"]
