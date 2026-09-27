# PyInstaller spec for the StemDeck audio engine. Build with:  pyinstaller stemdeck-engine.spec
# Produces dist/stemdeck-engine/ which electron-builder copies into the installer.
from pathlib import Path

from PyInstaller.utils.hooks import collect_data_files, collect_submodules

datas = []
datas += collect_data_files("demucs")          # model registry yaml files
datas += collect_data_files("librosa")         # lazy-loader stubs and example registry
datas += collect_data_files("imageio_ffmpeg")  # bundled ffmpeg.exe
if Path("bin").exists():                       # optional Rubber Band CLI (+ its DLLs)
    datas += [(str(p), "bin") for p in Path("bin").iterdir() if p.is_file()]

hiddenimports = collect_submodules("demucs") + collect_submodules("stemdeck_backend") + [
    "uvicorn.logging", "uvicorn.loops.auto", "uvicorn.protocols.http.auto", "uvicorn.lifespan.on",
]

a = Analysis(
    ["engine_entry.py"],
    datas=datas,
    hiddenimports=hiddenimports,
    excludes=["tkinter", "matplotlib", "IPython", "pytest"],
)
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name="stemdeck-engine", console=False)
coll = COLLECT(exe, a.binaries, a.datas, name="stemdeck-engine")
