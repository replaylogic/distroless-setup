"""Integration fixture: FastAPI served by uvicorn.

/health reports the uid/gid the process really runs as, so the integration
suite can prove non-root from outside the container.
"""

import os

from fastapi import FastAPI

app = FastAPI()


@app.get("/health")
def health() -> dict:
    return {
        "status": "ok",
        "uid": os.getuid(),
        "gid": os.getgid(),
        "greeting": os.environ.get("GREETING", "default-greeting"),
        "server": "uvicorn",
    }


@app.get("/")
def root() -> dict:
    return {"app": "fixture-fastapi-uvicorn"}
