"""Smoke test: aplikasi bisa di-import dan route dasar berfungsi tanpa secret."""
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1] / "backend"
sys.path.insert(0, str(BACKEND_DIR))

import app as app_module  # noqa: E402


def client():
    app_module.app.config["TESTING"] = True
    return app_module.app.test_client()


def test_health():
    resp = client().get("/health")
    assert resp.status_code == 200
    data = resp.get_json()
    assert data["status"] == "online"


def test_index_served():
    resp = client().get("/")
    assert resp.status_code == 200
    assert b"<html" in resp.data.lower()


def test_frontend_assets():
    c = client()
    assert c.get("/assets/app.js").status_code == 200
    assert c.get("/assets/style.css").status_code == 200
    assert c.get("/manifest.webmanifest").status_code == 200
    assert c.get("/sw.js").status_code == 200
