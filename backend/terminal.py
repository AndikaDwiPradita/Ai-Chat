"""Terminal command runner for Cosmic AI.

Provides synchronous command execution with streaming output (generator).
"""
import os
import signal
import subprocess
import threading
import time
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent

_running = {}  # pid -> Popen
_lock = threading.Lock()


def _safe_cwd(cwd):
    if not cwd:
        return str(PROJECT_ROOT)
    p = Path(cwd).expanduser().resolve()
    # restrict to project root for safety
    try:
        p.relative_to(PROJECT_ROOT)
    except ValueError:
        p = PROJECT_ROOT
    if not p.is_dir():
        p = PROJECT_ROOT
    return str(p)


def run_command(command, cwd=None, timeout=120):
    """Generator yielding (stream, text) tuples. stream in {stdout, stderr, status}."""
    cwd = _safe_cwd(cwd)
    # Use shell for convenience but pass via list to reduce injection? We'll use shell=True for piping support.
    proc = subprocess.Popen(
        command,
        shell=True,
        cwd=cwd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        stdin=subprocess.DEVNULL,
        text=True,
        bufsize=1,
        preexec_fn=os.setsid if os.name != "nt" else None,
    )
    with _lock:
        _running[proc.pid] = proc

    yield ("status", f"$ {command}\n[cwd: {cwd}]\n")

    # Stream stdout and stderr concurrently
    import queue
    q = queue.Queue()

    def reader(pipe, label):
        try:
            for line in iter(pipe.readline, ""):
                q.put((label, line))
        finally:
            pipe.close()
            q.put((label, None))

    t1 = threading.Thread(target=reader, args=(proc.stdout, "stdout"), daemon=True)
    t2 = threading.Thread(target=reader, args=(proc.stderr, "stderr"), daemon=True)
    t1.start()
    t2.start()

    finished_streams = 0
    deadline = time.time() + timeout
    while finished_streams < 2:
        if time.time() > deadline:
            yield ("stderr", f"\n[timeout {timeout}s - killing]\n")
            kill_process(proc.pid)
            break
        try:
            label, line = q.get(timeout=0.1)
        except Exception:
            if proc.poll() is not None and q.empty():
                # process done, drain
                break
            continue
        if line is None:
            finished_streams += 1
            continue
        yield (label, line)

    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        kill_process(proc.pid)
    rc = proc.returncode
    with _lock:
        _running.pop(proc.pid, None)
    yield ("status", f"\n[exit code: {rc}]\n")


def kill_process(pid):
    with _lock:
        proc = _running.get(pid)
    if proc is None:
        return False
    try:
        if os.name != "nt":
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        else:
            proc.kill()
    except ProcessLookupError:
        pass
    return True


def list_running():
    with _lock:
        return [{"pid": pid} for pid in _running.keys()]
