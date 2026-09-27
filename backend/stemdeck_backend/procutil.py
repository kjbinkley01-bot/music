"""Helpers for worker processes."""

from __future__ import annotations

import multiprocessing as mp
import multiprocessing.connection
import os
import threading


def exit_with_parent() -> None:
    """Make this worker exit as soon as its parent process dies.

    The engine can be terminated abruptly (Electron kills it on quit, a crash, Task Manager),
    which gives it no chance to shut down its workers. Watching the parent's sentinel works on
    Windows and POSIX alike, so no orphaned processes are ever left behind.
    """
    parent = mp.parent_process()
    if parent is None:
        return

    def watch() -> None:
        multiprocessing.connection.wait([parent.sentinel])
        os._exit(0)

    threading.Thread(target=watch, name="parent-watch", daemon=True).start()
