"""Entry point: python -m stemdeck_backend --port 47821"""

from __future__ import annotations

import argparse
import logging
import multiprocessing
import os
import sys
import threading


def _watch_stdin() -> None:
    """Exit when the parent (Electron) closes our stdin, so we never outlive the app."""
    try:
        while sys.stdin.read(1024):
            pass
    except Exception:
        pass
    from .jobs import jobs

    jobs.stop()
    os._exit(0)


def main() -> None:
    multiprocessing.freeze_support()
    parser = argparse.ArgumentParser(description="StemDeck audio engine")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=int(os.environ.get("STEMDECK_PORT", 47821)))
    parser.add_argument("--watch-stdin", action="store_true")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    import uvicorn

    from .app import app
    from .soundcloud import soundcloud

    soundcloud.redirect_uri = f"http://127.0.0.1:{args.port}/soundcloud/callback"
    if args.watch_stdin:
        threading.Thread(target=_watch_stdin, daemon=True).start()
    print(f"STEMDECK_READY port={args.port}", flush=True)
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
