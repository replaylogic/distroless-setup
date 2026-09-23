"""Integration fixture: Flask (WSGI) served by Gunicorn's default sync worker.

This is the WSGI counterpart to the FastAPI/ASGI fixtures: same distroless
runtime, same venv layout, different application protocol.
"""

import os

from flask import Flask, jsonify

app = Flask(__name__)


@app.get("/health")
def health():
    return jsonify(
        status="ok",
        uid=os.getuid(),
        gid=os.getgid(),
        greeting=os.environ.get("GREETING", "default-greeting"),
        server="gunicorn-wsgi",
    )


@app.get("/")
def root():
    return jsonify(app="fixture-flask-gunicorn")
