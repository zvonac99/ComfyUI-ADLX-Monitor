import json
import os
from typing import Dict

CONFIG_FILE = os.path.join(os.path.dirname(os.path.dirname(__file__)), "adlxmon_config.json")
VALID_PROVIDER_MODES = {
    "auto",
    "prefer-amd",
    "force-amd",
}
DEFAULT_PROVIDER_MODE = "auto"


def _sanitize_provider_mode(value) -> str:
    mode = str(value or DEFAULT_PROVIDER_MODE).strip().lower()
    if mode not in VALID_PROVIDER_MODES:
        return DEFAULT_PROVIDER_MODE
    return mode


def load_plugin_config() -> Dict[str, str]:
    try:
        with open(CONFIG_FILE, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except Exception:
        data = {}

    return {
        "provider_mode": _sanitize_provider_mode(data.get("provider_mode")),
    }


def save_plugin_config(changes: Dict[str, str]) -> Dict[str, str]:
    config = load_plugin_config()
    if "provider_mode" in changes:
        config["provider_mode"] = _sanitize_provider_mode(changes.get("provider_mode"))

    with open(CONFIG_FILE, "w", encoding="utf-8") as handle:
        json.dump(config, handle, indent=2)

    return config
