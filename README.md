# Ai-Chat

Aplikasi web chat AI (multi-model) — Flask backend + frontend statis (PWA).

- **Backend:** `backend/` (Flask, SQLite, SSE streaming, MCP opsional, plugin & skill, media generation)
- **Frontend:** `frontend/` (HTML/CSS/JS statis, tersaji oleh Flask)

![Build](https://github.com/AndikaDwiPradita/Ai-Chat/actions/workflows/build.yml/badge.svg)

## Menjalankan secara lokal

```bash
python3 -m venv venv
source venv/bin/activate          # Windows: venv\Scripts\activate
pip install -r requirements.txt
# Opsional (fitur MCP):
pip install -r requirements-optional.txt

cp .env.example .env              # lalu isi ORCAROUTER_API_KEY di .env

python backend/app.py             # http://127.0.0.1:5000
```

- `HOST` / `PORT` environment variable mengubah alamat & port server (default `127.0.0.1:5000`).
- Frontend di `/`, health check di `/health`, daftar model di `/models`.

## Menjalankan dengan Docker

```bash
docker build -t ai-chat .
docker run -p 5000:5000 -e ORCAROUTER_API_KEY=your-key ai-chat
# http://127.0.0.1:5000
```

## Konfigurasi

Semua konfigurasi lewat `.env` (lihat `.env.example`) atau environment variable:

| Variabel | Wajib | Keterangan |
|---|---|---|
| `ORCAROUTER_API_KEY` | Ya (untuk AI) | API key OrcaRouter. Tanpa ini aplikasi tetap jalan tapi permintaan AI gagal. |
| `OLLAMA_BASE_URL` / `OLLAMA_ENABLED` | Tidak | Model lokal Ollama. |
| `IMAGE_API_PROVIDER`, `IMAGE_MODEL`, `POLLINATIONS_TOKEN`, `HF_TOKEN`, `VIDEO_MODEL`, ... | Tidak | Generator gambar/video. |
| `HOST` / `PORT` | Tidak | Alamat & port server. |

> **Jangan commit `.env`.** File `.env`, `venv/`, `backend/data/`, `backend/generated/`, dan `backup/` diabaikan git.

## Struktur

```
backend/    Flask app (app.py), config, storage SQLite, MCP, plugins, skills, media
frontend/   index.html, app.js, style.css, PWA manifest, service worker
tests/      Smoke test (pytest)
.github/workflows/build.yml   CI: build & test di GitHub Actions
```

## CI (GitHub Actions)

Setiap push ke `main` & setiap PR menjalankan workflow **Build** (`.github/workflows/build.yml`):

1. install dependency,
2. `compileall` (syntax check),
3. `pytest` (smoke test `/health`, `/`, `/assets`, `/manifest.webmanifest`, `/sw.js`),
4. build Docker image.

Rahasia `ORCAROUTER_API_KEY` **tidak diperlukan** untuk build; hanya diperlukan saat menjalankan aplikasi.
