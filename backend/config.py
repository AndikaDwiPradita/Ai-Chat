
import os
from dotenv import load_dotenv

load_dotenv()

ORCAROUTER_API_KEY = os.getenv("ORCAROUTER_API_KEY") or ""

ORCAROUTER_BASE_URL = "https://api.orcarouter.ai/v1"

# Ollama (lokal). Aktifkan dengan set OLLAMA_BASE_URL (default localhost:11434).
OLLAMA_BASE_URL = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434").rstrip("/")
OLLAMA_ENABLED = os.getenv("OLLAMA_ENABLED", "true").lower() in ("1", "true", "yes", "on")

DEFAULT_MODEL = "deepseek/deepseek-v4-flash-free"

if not ORCAROUTER_API_KEY:
    # Tidak langsung raise: aplikasi tetap bisa dijalankan (mis. untuk CI build
    # atau memakai Ollama lokal). Permintaan ke API OrcaRouter akan gagal
    # sampai ORCAROUTER_API_KEY diisi di file .env atau environment.
    print(
        "PERINGATAN: ORCAROUTER_API_KEY belum ditemukan di file .env; "
        "fitur AI berbasis OrcaRouter akan gagal sampai diisi.",
        flush=True,
    )

