"""Entry point Chaquopy untuk standalone Android.

Menjalankan backend Flask (backend/app.py) di thread dengan server lokal
127.0.0.1:PORT, memakai direktori tulis app untuk data SQLite & hasil generate.
Frontend statis dikemas di dalam package Python (frontend/).
"""
import os
from pathlib import Path


def start_server(port, api_key, files_dir):
    port = int(port)

    # API key dari UI Android -> environment sebelum import config.
    os.environ["ORCAROUTER_API_KEY"] = api_key or ""

    # Direktori tulis (app-private) untuk DB & output, bukan package read-only.
    data_root = Path(files_dir) / "aichat"
    data_root.mkdir(parents=True, exist_ok=True)

    import storage  # noqa: E402  (backend/ ada di python.srcDirs)

    storage.DATA_DIR = data_root / "data"
    storage.DB_PATH = storage.DATA_DIR / "nexus.db"
    storage.DATA_DIR.mkdir(parents=True, exist_ok=True)

    import app as flask_app  # noqa: E402  backend/app.py

    pkg_dir = Path(__file__).resolve().parent

    # Frontend statis dikemas di dalam python package.
    flask_app.FRONTEND_DIR = pkg_dir / "frontend"

    # Output media ke direktori tulis.
    try:
        import media_api  # noqa: E402

        media_api.GENERATED_DIR = data_root / "generated"
        media_api.GENERATED_DIR.mkdir(parents=True, exist_ok=True)
    except Exception:
        pass

    # Folder plugin/skill di direktori tulis supaya bisa dibuat.
    try:
        import plugins as plugins_mod  # noqa: E402
        import skills as skills_mod  # noqa: E402

        plugins_mod.PLUGINS_DIR = data_root / "plugins"
        plugins_mod.PLUGINS_DIR.mkdir(parents=True, exist_ok=True)
        skills_mod.SKILLS_DIR = data_root / "skills"
        skills_mod.SKILLS_DIR.mkdir(parents=True, exist_ok=True)
    except Exception:
        pass

    flask_app.app.run(
        host="127.0.0.1",
        port=port,
        debug=False,
        threaded=True,
        use_reloader=False,
    )
