"""Package ComfyUI-ADLX-Monitor from an explicit whitelist."""

import zipfile
import os
import re

# Read the version from pyproject.toml.
def get_version():
    toml_path = os.path.join(os.path.dirname(__file__), "pyproject.toml")
    with open(toml_path, encoding="utf-8") as f:
        for line in f:
            m = re.match(r'\s*version\s*=\s*"(.+?)"', line)
            if m:
                return m.group(1)
    return "unknown"

# Whitelist of files and directories included in the release archive.
WHITELIST = [
    "__init__.py",
    "adlx_server.py",
    "pyproject.toml",
    "requirements.txt",
    "providers",
    "web",
]

def pack():
    src_dir = os.path.dirname(os.path.abspath(__file__))
    version = get_version()
    output = f"F:/ComfyUI-ADLX-Monitor-v{version}.zip"
    prefix = "ComfyUI-ADLX-Monitor"  # Top-level folder name inside the archive.

    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as zf:
        for item in WHITELIST:
            full = os.path.join(src_dir, item)
            if os.path.isfile(full):
                arcname = f"{prefix}/{item}"
                zf.write(full, arcname)
                print(f"  + {arcname}")
            elif os.path.isdir(full):
                for root, dirs, files in os.walk(full):
                    # Exclude __pycache__ directories and compiled files.
                    dirs[:] = [d for d in dirs if d != "__pycache__"]
                    for file in files:
                        if file.endswith(".pyc"):
                            continue
                        file_path = os.path.join(root, file)
                        rel = os.path.relpath(file_path, src_dir)
                        arcname = f"{prefix}/{rel.replace(os.sep, '/')}"
                        zf.write(file_path, arcname)
                        print(f"  + {arcname}")
            else:
                print(f"  ! Missing whitelist entry, skipped: {item}")

    print(f"\nDone: {output}")
    print(f"Included files: {len(zf.namelist())}")

if __name__ == "__main__":
    pack()
