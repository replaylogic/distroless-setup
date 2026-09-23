"""Integration fixture: FastAPI served by Gunicorn with the Uvicorn worker.

/health also reports the worker class actually in use, so the test can prove the
container runs `uvicorn_worker.UvicornWorker` and not the deprecated
`uvicorn.workers.UvicornWorker`.
"""

import os

from fastapi import FastAPI

app = FastAPI()


def _worker_module() -> str:
    """Which Uvicorn worker package Gunicorn actually loaded."""
    import sys

    if any(n == "uvicorn_worker" or n.startswith("uvicorn_worker.") for n in sys.modules):
        return "uvicorn_worker"
    if any(n.startswith("uvicorn.workers") for n in sys.modules):
        return "uvicorn.workers"
    return "unknown"


@app.get("/health")
def health() -> dict:
    return {
        "status": "ok",
        "uid": os.getuid(),
        "gid": os.getgid(),
        "greeting": os.environ.get("GREETING", "default-greeting"),
        "server": "gunicorn",
        "workerModule": _worker_module(),
    }


@app.get("/")
def root() -> dict:
    return {"app": "fixture-fastapi-gunicorn"}
