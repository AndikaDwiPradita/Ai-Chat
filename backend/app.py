import base64
import functools
import json
import os
import re
import sqlite3
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from io import BytesIO
from pathlib import Path

import requests
from flask import (
    Flask,
    Response,
    jsonify,
    request,
    send_from_directory,
    stream_with_context,
)
from pypdf import PdfReader

import storage
from config import (
    DEFAULT_MODEL,
    ORCAROUTER_API_KEY,
    ORCAROUTER_BASE_URL,
    OLLAMA_BASE_URL,
    OLLAMA_ENABLED,
)
import plugins as plugins_mod
import skills as skills_mod
import terminal as terminal_mod
import media_api
from mcp_manager import get_manager as get_mcp_manager

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 27 * 1024 * 1024

API_URL = ORCAROUTER_BASE_URL + "/chat/completions"

# Model kustom Cosmic.
COSMIC_MODEL_ID = "cosmic/cosmic-v0.5-max"
COSMIC_MODEL_NAME = "Cosmic v0.5 Max"
COSMIC_BACKING_MODEL = "orcarouter/free"
COSMIC_SYSTEM_PROMPT = (
    "Kamu adalah Cosmic v0.5 Max, asisten AI dari Cosmic. "
    "Jawablah dengan ramah, ringkas, jelas, dan praktis. "
    "Jangan sebut bahwa kamu adalah DeepSeek atau model AI lain."
)

DOCUMENT_EXTENSIONS = (".pdf", ".txt")
# Ekstensi kode / teks yang bisa dibaca sebagai dokumen teks.
CODE_EXTENSIONS = (
    ".js", ".jsx", ".ts", ".tsx", ".py", ".pyw",
    ".html", ".htm", ".css", ".json", ".xml",
    ".java", ".cpp", ".c", ".h", ".hpp", ".cs",
    ".go", ".rb", ".php", ".sh", ".bash", ".sql",
    ".md", ".markdown", ".yaml", ".yml", ".ini",
    ".cfg", ".toml", ".log", ".rs", ".swift", ".kt",
    ".dart", ".vue", ".svelte", ".pl", ".r", ".m",
    ".dockerfile", ".makefile", ".tf", ".ps1", ".bat",
    ".cmd", ".gradle", ".properties", ".env.example",
)
IMAGE_EXTENSIONS = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
}

MAX_FILES_PER_MESSAGE = 5
MAX_FILE_SIZE = 5 * 1024 * 1024
MAX_DOCUMENT_CHARS = 50_000
MAX_PDF_PAGES = 100

TITLE_SYSTEM_PROMPT = (
    "Kamu adalah asisten yang membuat judul percakapan yang singkat dan jelas. "
    "Tulis HANYA judulnya, maksimal 6 kata, tanpa tanda kutip, "
    "tanpa awalan seperti 'Judul:', dan jangan menambahkan penjelasan."
)


# ==========================================
# RATE LIMITING (in-memory, per IP per endpoint)
# ==========================================

_rate_store = {}
_rate_lock = threading.Lock()
RATE_WINDOW_SECONDS = 60


def _client_ip():
    return request.remote_addr or "unknown"


def _check_rate(key, limit):
    now = time.time()

    with _rate_lock:
        entries = _rate_store.setdefault(key, [])
        entries[:] = [ts for ts in entries if now - ts < RATE_WINDOW_SECONDS]

        if len(entries) >= limit:
            return False

        entries.append(now)
        return True


def rate_limited(limit):
    def decorator(view):
        @functools.wraps(view)
        def wrapper(*args, **kwargs):
            key = f"{request.endpoint}:{_client_ip()}"

            if not _check_rate(key, limit):
                return jsonify({
                    "error": "Terlalu banyak permintaan. Coba lagi dalam satu menit."
                }), 429

            return view(*args, **kwargs)

        return wrapper

    return decorator


# ==========================================
# DATABASE
# ==========================================

storage.init_db()


# ==========================================
# HELPERS
# ==========================================

def _clamp_temperature(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None

    if not 0 <= value <= 2:
        return None

    return float(value)


def _validate_messages(messages):
    if not isinstance(messages, list) or not messages:
        return "Messages harus berupa list dan tidak boleh kosong."

    for message in messages:
        if not isinstance(message, dict):
            return "Format pesan tidak valid."

        if message.get("role") not in ("system", "user", "assistant"):
            return "Role pesan tidak valid."

        content = message.get("content")

        if isinstance(content, str):
            continue

        # Konten array (teks + gambar) untuk model vision diizinkan.
        if isinstance(content, list) and content:
            valid = all(
                isinstance(part, dict) and part.get("type") in ("text", "image_url")
                for part in content
            )

            if valid:
                continue

        return "Content harus berupa teks."

    return None


def _read_chat_request():
    if request.content_type and request.content_type.startswith("multipart/form-data"):
        try:
            data = json.loads(request.form.get("payload", "{}"))
        except (ValueError, TypeError):
            raise ValueError("Data payload unggahan tidak valid.")

        return data, request.files.getlist("files")

    data = request.get_json(silent=True) or {}
    return data, []


def _build_payload(data, uploaded_files):
    messages = data.get("messages")
    model = data.get("model") or DEFAULT_MODEL
    temperature = _clamp_temperature(data.get("temperature", 0.7))

    if model == COSMIC_MODEL_ID:
        model = COSMIC_BACKING_MODEL

    ollama_model = _is_ollama_model(model)
    if ollama_model:
        model = _ollama_model_name(model)

    if temperature is None:
        raise ValueError("Temperature harus antara 0 dan 2.")

    error = _validate_messages(messages)

    if error:
        raise ValueError(error)

    built_messages = messages

    # Suntikkan identitas Cosmic (hanya untuk model Cosmic) + prompt plugin aktif.
    plugin_prompt = plugins_mod.enabled_prompts()

    has_system = any(
        isinstance(message, dict) and message.get("role") == "system"
        for message in (messages if isinstance(messages, list) else [])
    )

    if not has_system:
        parts = []
        if model == COSMIC_BACKING_MODEL:
            parts.append(COSMIC_SYSTEM_PROMPT)
        if plugin_prompt:
            parts.append(plugin_prompt)
        if parts:
            built_messages = list(messages) if isinstance(messages, list) else list(messages)
            built_messages.insert(0, {"role": "system", "content": "\n\n".join(parts)})

    if uploaded_files:
        apply_uploads_to_last_message(built_messages, uploaded_files)

    return {
        "model": model,
        "messages": built_messages,
        "temperature": temperature,
    }


def _sniff_image_type(raw, extension):
    if extension == ".png" and raw.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"

    if extension in (".jpg", ".jpeg") and raw.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"

    if extension == ".gif" and raw.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"

    if extension == ".webp" and raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
        return "image/webp"

    return None


def process_uploaded_files(uploaded_files):
    """
    Memproses file yang diunggah.

    Mengembalikan tuple (document_text, image_data_urls).
    Melempar ValueError untuk input yang tidak valid.
    """
    if len(uploaded_files) > MAX_FILES_PER_MESSAGE:
        raise ValueError("Maksimal 5 file dalam satu pesan.")

    extracted = []
    images = []
    total_chars = 0

    for uploaded in uploaded_files:
        filename = (uploaded.filename or "").strip()
        extension = Path(filename).suffix.lower()

        is_document = extension in DOCUMENT_EXTENSIONS or extension in CODE_EXTENSIONS
        is_image = extension in IMAGE_EXTENSIONS

        if not filename or not (is_document or is_image):
            raise ValueError(
                "Format file hanya boleh PDF, TXT, kode (mis. JS/PY/HTML/CSS/JSON), "
                "atau gambar (PNG/JPG/WEBP/GIF)."
            )

        raw = uploaded.read(MAX_FILE_SIZE + 1)

        if len(raw) > MAX_FILE_SIZE:
            raise ValueError(f"Ukuran {filename} melebihi batas 5 MB.")

        if not raw:
            raise ValueError(f"File {filename} kosong.")

        if is_image:
            mime = _sniff_image_type(raw, extension)

            if mime is None:
                raise ValueError(f"File {filename} bukan gambar yang valid.")

            encoded = base64.b64encode(raw).decode("ascii")
            images.append("data:" + mime + ";base64," + encoded)
            continue

        if extension == ".txt" or extension in CODE_EXTENSIONS:
            content = raw.decode("utf-8-sig", errors="replace")
        else:
            try:
                reader = PdfReader(BytesIO(raw), strict=False)

                if reader.is_encrypted:
                    raise ValueError(f"PDF {filename} terkunci password.")

                if len(reader.pages) > MAX_PDF_PAGES:
                    raise ValueError(f"PDF {filename} melebihi 100 halaman.")

                parts = [(page.extract_text() or "") for page in reader.pages]
                content = "\n".join(parts)

            except ValueError:
                raise

            except Exception as exc:
                raise ValueError(f"Gagal membaca PDF {filename}: {exc}")

        content = content.strip()

        if not content:
            raise ValueError(
                f"Tidak ditemukan teks pada {filename}. "
                "PDF hasil scan/gambar belum didukung OCR."
            )

        remaining = MAX_DOCUMENT_CHARS - total_chars

        if remaining <= 0:
            raise ValueError("Total teks dokumen melebihi batas 50.000 karakter.")

        content = content[:min(20_000, remaining)]
        total_chars += len(content)

        extracted.append(f"\n\n===== DOKUMEN: {filename} =====\n{content}")

    return "".join(extracted), images


def apply_uploads_to_last_message(messages, uploaded_files):
    document_text, images = process_uploaded_files(uploaded_files)

    if messages[-1].get("role") != "user":
        raise ValueError("Lampiran harus dikirim bersama pesan pengguna.")

    text = messages[-1].get("content")

    if not isinstance(text, str):
        text = ""

    if document_text:
        text += (
            "\n\nBaca dan gunakan isi dokumen berikut untuk menjawab "
            "pesan saya.\n" + document_text
        )

    if images:
        parts = [{"type": "text", "text": text}]

        for url in images:
            parts.append({"type": "image_url", "image_url": {"url": url}})

        messages[-1]["content"] = parts
    else:
        messages[-1]["content"] = text

    return messages


def _auth_headers():
    return {
        "Authorization": f"Bearer {ORCAROUTER_API_KEY}",
        "Content-Type": "application/json",
    }


# ==========================================
# OLLAMA (LOKAL) HELPERS
# ==========================================

def _ollama_available():
    if not OLLAMA_ENABLED:
        return False
    try:
        response = requests.get(f"{OLLAMA_BASE_URL}/api/tags", timeout=3)
        return response.status_code == 200
    except requests.RequestException:
        return False


def _ollama_model_ids():
    if not _ollama_available():
        return []
    try:
        response = requests.get(f"{OLLAMA_BASE_URL}/api/tags", timeout=5)
        response.raise_for_status()
        data = response.json()
        return [m.get("name") for m in data.get("models", []) if m.get("name")]
    except (requests.RequestException, ValueError):
        return []


def _is_ollama_model(model):
    return isinstance(model, str) and model.startswith("ollama/")


def _ollama_chat_url():
    return f"{OLLAMA_BASE_URL}/v1/chat/completions"


def _provider_url(model):
    if _is_ollama_model(model):
        return _ollama_chat_url()
    return API_URL


def _provider_headers(model):
    if _is_ollama_model(model):
        return {"Content-Type": "application/json"}
    return _auth_headers()


def _ollama_model_name(model):
    return model[len("ollama/"):] if _is_ollama_model(model) else model


# ==========================================
# UPSTREAM LIMIT DETECTION
# ==========================================

LIMIT_MESSAGE = (
    "Terimakasih Telah Menggunakan Cosmic Ai, Tetapi Limit Harian Anda "
    "Sedang Habis Silahkan Tunggu Selama {time} Lagi"
)


def _upstream_rate_limit_seconds(response):
    """Kembalikan sisa detik bila respons upstream adalah rate limit, else None."""
    is_limited = response.status_code == 429

    retry_after = None
    header = response.headers.get("Retry-After")
    if header:
        try:
            retry_after = int(float(header))
        except (TypeError, ValueError):
            retry_after = None

    try:
        body = response.json()
    except ValueError:
        body = None

    if isinstance(body, dict):
        error = body.get("error")
        if isinstance(error, dict):
            code = str(error.get("code") or "")
            metadata = error.get("metadata") or {}
            if "rate" in code.lower():
                is_limited = True
            if metadata.get("reason") == "err_free_rate":
                is_limited = True
            seconds = metadata.get("retry_after_seconds")
            if retry_after is None and isinstance(seconds, (int, float)):
                retry_after = int(seconds)
        if str(body.get("type") or "") == "rate_limit_error":
            is_limited = True

    if not is_limited:
        return None

    return max(0, retry_after or 0)


def _format_limit_duration(seconds):
    total = max(0, int(seconds))
    hours = total // 3600
    minutes = (total % 3600) // 60
    secs = total % 60
    return f"{hours:02d} Jam {minutes:02d} Menit {secs:02d} Detik"


def _rate_limit_payload(seconds):
    return {
        "error": LIMIT_MESSAGE.format(time=_format_limit_duration(seconds)),
        "rate_limited": True,
        "retry_after": seconds,
    }


# ==========================================
# MODEL CATALOG CACHE
# ==========================================

_model_cache = {"timestamp": 0.0, "ids": []}
MODEL_CACHE_TTL = 300


def known_model_ids():
    now = time.time()

    if now - _model_cache["timestamp"] < MODEL_CACHE_TTL and _model_cache["ids"]:
        return _model_cache["ids"]

    try:
        response = requests.get(
            ORCAROUTER_BASE_URL + "/models",
            headers={"Authorization": f"Bearer {ORCAROUTER_API_KEY}"},
            timeout=20,
        )

        response.raise_for_status()

        ids = [
            item.get("id")
            for item in response.json().get("data", [])
            if isinstance(item, dict) and isinstance(item.get("id"), str)
        ]

        _model_cache["timestamp"] = now
        _model_cache["ids"] = ids

        return ids

    except requests.exceptions.RequestException:
        return list(_model_cache["ids"])


# ==========================================
# HEALTH
# ==========================================

@app.route("/health", methods=["GET"])
def health():
    return jsonify({
        "status": "online",
        "application": "Multi AI Chatbot"
    })


# ==========================================
# CHAT (NON-STREAMING)
# ==========================================

@app.route("/chat", methods=["POST"])
@rate_limited(60)
def chat():
    data, uploaded_files = _read_chat_request()
    requested_model = data.get("model") or DEFAULT_MODEL

    try:
        payload = _build_payload(data, uploaded_files)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400

    try:
        response = requests.post(
            _provider_url(requested_model),
            headers=_provider_headers(requested_model),
            json=payload,
            timeout=90
        )

        if response.status_code != 200:
            # Rate limit detection hanya relevan untuk OrcaRouter.
            if not _is_ollama_model(requested_model):
                retry_after = _upstream_rate_limit_seconds(response)
                if retry_after is not None:
                    return jsonify(_rate_limit_payload(retry_after)), 429

            return jsonify({
                "error": "API mengalami kesalahan.",
                "status_code": response.status_code,
                "details": response.text[:1000]
            }), 502

        result = response.json()

        answer = result["choices"][0]["message"]["content"]

        reported_model = (
            COSMIC_MODEL_ID if requested_model == COSMIC_MODEL_ID
            else (requested_model if _is_ollama_model(requested_model) else result.get("model"))
        )

        return jsonify({
            "success": True,
            "model": reported_model,
            "message": answer,
            "usage": result.get("usage")
        })

    except requests.exceptions.Timeout:
        return jsonify({"error": "Permintaan AI timeout."}), 504

    except requests.exceptions.RequestException:
        return jsonify({"error": "Gagal menghubungi OrcaRouter."}), 502

    except (KeyError, IndexError, ValueError):
        return jsonify({"error": "Respons API tidak valid."}), 502


# ==========================================
# CHAT (STREAMING)
# ==========================================

@app.route("/chat/stream", methods=["POST"])
@rate_limited(60)
def chat_stream():
    data, uploaded_files = _read_chat_request()
    requested_model = data.get("model") or DEFAULT_MODEL

    try:
        payload = _build_payload(data, uploaded_files)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400

    payload["stream"] = True
    payload["stream_options"] = {"include_usage": True}

    headers = _provider_headers(requested_model)
    headers["Accept"] = "text/event-stream"

    try:
        upstream = requests.post(
            _provider_url(requested_model),
            headers=headers,
            json=payload,
            stream=True,
            timeout=(15, 180)
        )

        # Beberapa gateway menolak stream_options; coba ulang tanpa parameter itu.
        if upstream.status_code != 200 and "stream_options" in payload:
            upstream.close()
            payload.pop("stream_options")

            upstream = requests.post(
                _provider_url(requested_model),
                headers=headers,
                json=payload,
                stream=True,
                timeout=(15, 180)
            )

        if upstream.status_code != 200:
            retry_after = None
            if not _is_ollama_model(requested_model):
                retry_after = _upstream_rate_limit_seconds(upstream)
            details = upstream.text[:1000]
            upstream.close()

            if retry_after is not None:
                return jsonify(_rate_limit_payload(retry_after)), 429

            return jsonify({
                "error": "API mengalami kesalahan.",
                "status_code": upstream.status_code,
                "details": details
            }), 502

        @stream_with_context
        def generate():
            try:
                for line in upstream.iter_lines():
                    if line:
                        yield line + b"\n\n"

            except requests.exceptions.RequestException:
                error_event = (
                    'data: {"error":"Koneksi streaming terputus."}\n\n'
                )
                yield error_event.encode("utf-8")

            finally:
                upstream.close()

        return Response(
            generate(),
            content_type="text/event-stream; charset=utf-8",
            headers={
                "Cache-Control": "no-cache",
                "X-Accel-Buffering": "no"
            }
        )

    except requests.exceptions.Timeout:
        return jsonify({
            "error": "Koneksi ke OrcaRouter timeout."
        }), 504

    except requests.exceptions.RequestException:
        return jsonify({
            "error": "Gagal menghubungi OrcaRouter."
        }), 502


# ==========================================
# MODELS
# ==========================================

@app.route("/models", methods=["GET"])
@rate_limited(30)
def models():
    try:
        response = requests.get(
            ORCAROUTER_BASE_URL + "/models",
            headers={"Authorization": f"Bearer {ORCAROUTER_API_KEY}"},
            timeout=30
        )

        response.raise_for_status()

        raw_models = response.json().get("data", [])

        compatible_models = []

        for model in raw_models:
            model_id = model.get("id", "")
            endpoints = model.get("supported_endpoint_types", [])

            if (
                "free" in model_id.lower()
                and "openai" in endpoints
            ):
                compatible_models.append({
                    "id": model_id,
                    "name": model_id.split("/")[-1],
                    "provider": model.get("owned_by", "Unknown"),
                    "context_length": model.get("context_length"),
                    "endpoint": "openai"
                })

        # Tambahkan model kustom Cosmic.
        if not any(m.get("id") == COSMIC_MODEL_ID for m in compatible_models):
            compatible_models.append({
                "id": COSMIC_MODEL_ID,
                "name": COSMIC_MODEL_NAME,
                "provider": "Cosmic",
                "context_length": 4096,
                "endpoint": "openai",
                "description": "Model AI Cosmic v0.5 Max."
            })

        # Tambahkan model Ollama lokal (jika tersedia).
        for ollama_name in _ollama_model_ids():
            ollama_id = f"ollama/{ollama_name}"
            if not any(m.get("id") == ollama_id for m in compatible_models):
                compatible_models.append({
                    "id": ollama_id,
                    "name": f"{ollama_name} (lokal)",
                    "provider": "Ollama",
                    "context_length": None,
                    "endpoint": "openai",
                    "description": "Model lokal via Ollama."
                })

        return jsonify({
            "success": True,
            "count": len(compatible_models),
            "data": compatible_models
        })

    except requests.exceptions.RequestException:
        return jsonify({
            "success": False,
            "error": "Gagal mengambil daftar model dari OrcaRouter."
        }), 502


# ==========================================
# AUTO TITLE GENERATION
# ==========================================

@app.route("/api/generate-title", methods=["POST"])
@rate_limited(30)
def generate_title():
    data = request.get_json(silent=True) or {}

    messages = data.get("messages")
    model = data.get("model") or DEFAULT_MODEL

    if model == COSMIC_MODEL_ID:
        model = COSMIC_BACKING_MODEL

    ollama_model = _is_ollama_model(model)
    if ollama_model:
        model = _ollama_model_name(model)

    if not isinstance(messages, list):
        return jsonify({"success": False, "error": "Pesan tidak valid."}), 400

    transcript_lines = []

    for message in messages:
        if not isinstance(message, dict):
            continue

        role = message.get("role")
        content = message.get("content")

        if role not in ("user", "assistant") or not isinstance(content, str):
            continue

        content = content.strip()

        if not content:
            continue

        label = "Pengguna" if role == "user" else "AI"
        transcript_lines.append(f"{label}: {content[:600]}")

        if len(transcript_lines) >= 4:
            break

    if not transcript_lines:
        return jsonify({
            "success": False,
            "error": "Belum ada isi percakapan."
        }), 400

    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": TITLE_SYSTEM_PROMPT},
            {
                "role": "user",
                "content": (
                    "Buatkan judul untuk percakapan berikut:\n\n" +
                    "\n".join(transcript_lines)
                )
            },
        ],
        "temperature": 0.3,
        "max_tokens": 40,
    }

    try:
        _title_model = data.get("model") or DEFAULT_MODEL
        response = requests.post(
            _provider_url(_title_model),
            headers=_provider_headers(_title_model),
            json=payload,
            timeout=60
        )

        if response.status_code != 200:
            raise requests.exceptions.HTTPError(f"HTTP {response.status_code}")

        result = response.json()
        title = result["choices"][0]["message"]["content"]

        title = (title or "").strip().strip('"').strip("'").strip()
        title = re.sub(r"^(judul|title)\s*:\s*", "", title, flags=re.IGNORECASE)
        title = title.splitlines()[0].strip() if title else ""
        title = title[:60]

        if not title:
            raise ValueError("Judul kosong")

        return jsonify({"success": True, "title": title})

    except (requests.exceptions.RequestException, KeyError, IndexError, ValueError) as exc:
        message = str(exc).strip() or "Gagal membuat judul otomatis."

        return jsonify({
            "success": False,
            "error": message
        }), 502


# ==========================================
# COMPARE MODELS
# ==========================================

@app.route("/api/compare", methods=["POST"])
@rate_limited(20)
def compare_models():
    data = request.get_json(silent=True) or {}

    prompt = data.get("prompt")
    model_ids = data.get("models")
    system_prompt = data.get("systemPrompt") or ""
    temperature = _clamp_temperature(data.get("temperature", 0.7))

    if temperature is None:
        return jsonify({"success": False, "error": "Temperature harus antara 0 dan 2."}), 400

    if not isinstance(prompt, str) or not prompt.strip():
        return jsonify({"success": False, "error": "Prompt tidak boleh kosong."}), 400

    if not isinstance(model_ids, list) or not 1 <= len(model_ids) <= 4:
        return jsonify({
            "success": False,
            "error": "Pilih 1 sampai 4 model untuk dibandingkan."
        }), 400

    allowed = set(known_model_ids())
    allowed.add(COSMIC_MODEL_ID)

    selected = []

    for model_id in model_ids:
        model_id = str(model_id)

        if model_id in allowed and model_id not in selected:
            selected.append(model_id)

    if not selected:
        return jsonify({
            "success": False,
            "error": "Model yang dipilih tidak dikenali."
        }), 400

    messages = []

    if isinstance(system_prompt, str) and system_prompt.strip():
        messages.append({
            "role": "system",
            "content": system_prompt.strip()[:4000]
        })

    messages.append({"role": "user", "content": prompt.strip()[:20000]})

    def call_model(model):
        started = time.time()
        requested_model = model
        backend_model = COSMIC_BACKING_MODEL if model == COSMIC_MODEL_ID else model

        try:
            response = requests.post(
                API_URL,
                headers=_auth_headers(),
                json={
                    "model": backend_model,
                    "messages": messages,
                    "temperature": temperature
                },
                timeout=120
            )

            duration_ms = int((time.time() - started) * 1000)

            if response.status_code != 200:
                return {
                    "model": requested_model,
                    "success": False,
                    "content": "",
                    "usage": None,
                    "durationMs": duration_ms,
                    "error": f"HTTP {response.status_code}: {response.text[:200]}"
                }

            result = response.json()
            content = result["choices"][0]["message"]["content"]

            return {
                "model": requested_model,
                "success": True,
                "content": content or "",
                "usage": result.get("usage"),
                "durationMs": duration_ms,
                "error": None
            }

        except Exception as exc:
            return {
                "model": requested_model,
                "success": False,
                "content": "",
                "usage": None,
                "durationMs": int((time.time() - started) * 1000),
                "error": str(exc) or "Permintaan gagal."
            }

    with ThreadPoolExecutor(max_workers=len(selected)) as executor:
        results = list(executor.map(call_model, selected))

    return jsonify({"success": True, "results": results})


# ==========================================
# IMAGE & VIDEO GENERATION
# ==========================================

@app.route("/api/generate-image", methods=["POST"])
@rate_limited(20)
def generate_image():
    data = request.get_json(silent=True) or {}
    prompt = (data.get("prompt") or "").strip()

    if not prompt:
        return jsonify({"success": False, "error": "Prompt tidak boleh kosong."}), 400

    try:
        raw, mime = media_api.generate_image(prompt)
    except Exception as exc:
        return jsonify({"success": False, "error": f"Gagal membuat gambar: {exc}"}), 502

    encoded = base64.b64encode(raw).decode("ascii")
    return jsonify({
        "success": True,
        "type": "image",
        "mime": mime,
        "url": f"data:{mime};base64,{encoded}",
    })


@app.route("/api/generate-video", methods=["POST"])
@rate_limited(20)
def generate_video():
    data = request.get_json(silent=True) or {}
    prompt = (data.get("prompt") or "").strip()

    if not prompt:
        return jsonify({"success": False, "error": "Prompt tidak boleh kosong."}), 400

    try:
        raw, mime = media_api.generate_video(prompt)
        filename = media_api.save_generated(raw, mime)
    except Exception as exc:
        return jsonify({"success": False, "error": f"Gagal membuat video: {exc}"}), 502

    return jsonify({
        "success": True,
        "type": "video",
        "mime": mime,
        "url": f"/generated/{filename}",
    })


@app.route("/generated/<path:filename>", methods=["GET"])
def generated_media_file(filename):
    return send_from_directory(media_api.GENERATED_DIR, filename)


# ==========================================
# PLUGINS
# ==========================================


@app.route("/api/plugins", methods=["GET"])
@rate_limited(60)
def api_plugins_list():
    return jsonify({"success": True, "plugins": plugins_mod.list_plugins()})


@app.route("/api/plugins/install", methods=["POST"])
@rate_limited(20)
def api_plugins_install():
    data = request.get_json(silent=True) or {}
    source = (data.get("source") or "").strip()
    if not source:
        return jsonify({"success": False, "error": "Source tidak boleh kosong."}), 400
    try:
        pid = plugins_mod.install_plugin(source)
    except Exception as exc:
        return jsonify({"success": False, "error": str(exc)}), 400
    return jsonify({"success": True, "id": pid})


@app.route("/api/plugins/<plugin_id>/enable", methods=["POST"])
@rate_limited(60)
def api_plugins_enable(plugin_id):
    ok = plugins_mod.set_enabled(plugin_id, True)
    if not ok:
        return jsonify({"success": False, "error": "Plugin tidak ditemukan."}), 404
    return jsonify({"success": True})


@app.route("/api/plugins/<plugin_id>/disable", methods=["POST"])
@rate_limited(60)
def api_plugins_disable(plugin_id):
    ok = plugins_mod.set_enabled(plugin_id, False)
    if not ok:
        return jsonify({"success": False, "error": "Plugin tidak ditemukan."}), 404
    return jsonify({"success": True})


@app.route("/api/plugins/<plugin_id>", methods=["DELETE"])
@rate_limited(20)
def api_plugins_delete(plugin_id):
    ok = plugins_mod.delete_plugin(plugin_id)
    if not ok:
        return jsonify({"success": False, "error": "Plugin tidak ditemukan."}), 404
    return jsonify({"success": True})


# ==========================================
# SKILLS
# ==========================================


@app.route("/api/skills", methods=["GET"])
@rate_limited(60)
def api_skills_list():
    return jsonify({"success": True, "skills": skills_mod.list_skills()})


@app.route("/api/skills/<skill_id>", methods=["GET"])
@rate_limited(60)
def api_skills_get(skill_id):
    skill = skills_mod.get_skill(skill_id)
    if not skill:
        return jsonify({"success": False, "error": "Skill tidak ditemukan."}), 404
    return jsonify({"success": True, "skill": skill})


@app.route("/api/skills/install", methods=["POST"])
@rate_limited(20)
def api_skills_install():
    data = request.get_json(silent=True) or {}
    source = (data.get("source") or "").strip()
    if not source:
        return jsonify({"success": False, "error": "Source tidak boleh kosong."}), 400
    try:
        result = skills_mod.install_skill(source, data.get("name"))
    except Exception as exc:
        return jsonify({"success": False, "error": str(exc)}), 400
    return jsonify({"success": True, "installed": result})


@app.route("/api/skills/<skill_id>", methods=["DELETE"])
@rate_limited(20)
def api_skills_delete(skill_id):
    ok = skills_mod.delete_skill(skill_id)
    if not ok:
        return jsonify({"success": False, "error": "Skill tidak ditemukan."}), 404
    return jsonify({"success": True})


# ==========================================
# MCP
# ==========================================


@app.route("/api/mcp/servers", methods=["GET"])
@rate_limited(60)
def api_mcp_list():
    try:
        mgr = get_mcp_manager()
        return jsonify({"success": True, "servers": mgr.list_servers()})
    except Exception as exc:
        return jsonify({"success": False, "error": str(exc)}), 500


@app.route("/api/mcp/servers", methods=["POST"])
@rate_limited(20)
def api_mcp_add():
    data = request.get_json(silent=True) or {}
    sid = (data.get("id") or "").strip()
    if not sid:
        sid = (data.get("name") or "mcp-server").lower().replace(" ", "-")
    config = data.get("config") or {}
    if not isinstance(config, dict):
        return jsonify({"success": False, "error": "Config harus object."}), 400
    # minimal validation
    transport = config.get("transport", "stdio")
    if transport == "stdio" and not config.get("command"):
        return jsonify({"success": False, "error": "command wajib untuk stdio."}), 400
    if transport in ("sse", "http") and not config.get("url"):
        return jsonify({"success": False, "error": "url wajib untuk sse/http."}), 400
    try:
        mgr = get_mcp_manager()
        mgr.add_server(sid, config)
    except Exception as exc:
        return jsonify({"success": False, "error": str(exc)}), 400
    return jsonify({"success": True, "id": sid})


@app.route("/api/mcp/servers/<server_id>", methods=["DELETE"])
@rate_limited(20)
def api_mcp_remove(server_id):
    try:
        mgr = get_mcp_manager()
        mgr.remove_server(server_id)
    except Exception as exc:
        return jsonify({"success": False, "error": str(exc)}), 400
    return jsonify({"success": True})


@app.route("/api/mcp/tools", methods=["GET"])
@rate_limited(60)
def api_mcp_tools():
    server_id = request.args.get("server")
    try:
        mgr = get_mcp_manager()
        return jsonify({"success": True, "tools": mgr.list_tools(server_id)})
    except Exception as exc:
        return jsonify({"success": False, "error": str(exc)}), 500


@app.route("/api/mcp/call", methods=["POST"])
@rate_limited(30)
def api_mcp_call():
    data = request.get_json(silent=True) or {}
    server_id = (data.get("server") or "").strip()
    tool_name = (data.get("tool") or "").strip()
    arguments = data.get("arguments") or {}
    if not server_id or not tool_name:
        return jsonify({"success": False, "error": "server dan tool wajib."}), 400
    try:
        mgr = get_mcp_manager()
        result = mgr.call_tool(server_id, tool_name, arguments)
    except Exception as exc:
        return jsonify({"success": False, "error": str(exc)}), 400
    return jsonify({"success": True, "result": result})


# ==========================================
# TERMINAL
# ==========================================


@app.route("/api/terminal/exec", methods=["POST"])
@rate_limited(20)
def api_terminal_exec():
    data = request.get_json(silent=True) or {}
    command = (data.get("command") or "").strip()
    if not command:
        return jsonify({"success": False, "error": "Command tidak boleh kosong."}), 400
    cwd = data.get("cwd")
    timeout = data.get("timeout", 120)
    try:
        timeout = int(timeout)
    except (TypeError, ValueError):
        timeout = 120
    timeout = max(5, min(timeout, 300))

    def generate():
        try:
            for stream, text in terminal_mod.run_command(command, cwd=cwd, timeout=timeout):
                event = json.dumps({"stream": stream, "text": text})
                yield f"data: {event}\n\n"
        except Exception as exc:
            yield f"data: {json.dumps({'stream': 'stderr', 'text': str(exc)})}\n\n"
        yield "data: [DONE]\n\n"

    return Response(
        stream_with_context(generate()),
        content_type="text/event-stream; charset=utf-8",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.route("/api/terminal/kill", methods=["POST"])
@rate_limited(20)
def api_terminal_kill():
    data = request.get_json(silent=True) or {}
    pid = data.get("pid")
    if pid is None:
        return jsonify({"success": False, "error": "pid wajib."}), 400
    try:
        ok = terminal_mod.kill_process(int(pid))
    except (TypeError, ValueError):
        return jsonify({"success": False, "error": "pid tidak valid."}), 400
    return jsonify({"success": ok})


@app.route("/api/terminal/running", methods=["GET"])
@rate_limited(60)
def api_terminal_running():
    return jsonify({"success": True, "processes": terminal_mod.list_running()})


# ==========================================
# SYNC (SERVER-SIDE STORAGE)
# ==========================================

@app.route("/api/sync", methods=["GET"])
@rate_limited(120)
def get_sync_state():
    return jsonify({
        "success": True,
        "conversations": storage.get_chats_with_messages(),
        "folders": storage.get_folders(),
    })


@app.route("/api/sync", methods=["PUT"])
@rate_limited(120)
def put_sync_state():
    data = request.get_json(silent=True) or {}

    conversations = data.get("conversations")
    folders = data.get("folders")

    if not isinstance(conversations, list) or len(conversations) > 500:
        return jsonify({
            "success": False,
            "error": "Data percakapan tidak valid."
        }), 400

    if not isinstance(folders, list) or len(folders) > 100:
        return jsonify({
            "success": False,
            "error": "Data folder tidak valid."
        }), 400

    for chat in conversations:
        if not isinstance(chat, dict):
            return jsonify({
                "success": False,
                "error": "Struktur percakapan tidak valid."
            }), 400

        messages = chat.get("messages", [])

        if not isinstance(messages, list) or len(messages) > 2000:
            return jsonify({
                "success": False,
                "error": "Jumlah pesan melebihi batas."
            }), 400

        for message in messages:
            if not isinstance(message, dict):
                return jsonify({
                    "success": False,
                    "error": "Struktur pesan tidak valid."
                }), 400

            if message.get("role") not in ("user", "assistant", "system"):
                return jsonify({
                    "success": False,
                    "error": "Role pesan tidak valid."
                }), 400

            content = message.get("content")

            if not isinstance(content, str) or len(content) > 400_000:
                return jsonify({
                    "success": False,
                    "error": "Panjang pesan melebihi batas."
                }), 400

    try:
        storage.sync_state(conversations, folders)

    except sqlite3.Error:
        return jsonify({
            "success": False,
            "error": "Gagal menyimpan data di server."
        }), 500

    return jsonify({"success": True})


# ==========================================
# ERROR HANDLERS
# ==========================================

@app.errorhandler(413)
def request_too_large(error):
    return jsonify({
        "error": "Ukuran total unggahan terlalu besar. Maksimal sekitar 25 MB."
    }), 413


# ==========================================
# FRONTEND (STATIC)
# ==========================================

FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"


@app.route("/")
def frontend():
    return send_from_directory(str(FRONTEND_DIR), "index.html")


@app.route("/assets/<path:filename>")
def frontend_assets(filename):
    return send_from_directory(str(FRONTEND_DIR), filename)


@app.route("/manifest.webmanifest")
def web_manifest():
    response = send_from_directory(str(FRONTEND_DIR), "manifest.webmanifest")
    response.headers["Content-Type"] = "application/manifest+json"
    response.headers["Cache-Control"] = "no-cache"

    return response


@app.route("/sw.js")
def service_worker():
    response = send_from_directory(str(FRONTEND_DIR), "sw.js")
    response.headers["Content-Type"] = "text/javascript; charset=utf-8"
    response.headers["Cache-Control"] = "no-cache"

    return response


if __name__ == "__main__":
    app.run(
        host=os.getenv("HOST", "127.0.0.1"),
        port=int(os.getenv("PORT", "5000")),
        debug=False,
        threaded=True
    )
