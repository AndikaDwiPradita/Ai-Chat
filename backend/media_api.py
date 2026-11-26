"""Generator gambar & video berbasis API (bukan kode lokal).

Provider gratis yang didukung:
- Gambar: Pollinations (gratis, token opsional) atau Hugging Face (token gratis).
- Video : Hugging Face Inference (token gratis).

Konfigurasi lewat environment / .env:
  IMAGE_API_PROVIDER = pollinations | huggingface   (default: pollinations)
  IMAGE_MODEL        = model gambar (opsional)
  POLLINATIONS_TOKEN = token opsional Pollinations
  HF_TOKEN           = token gratis Hugging Face
  VIDEO_MODEL        = model text-to-video (default: Wan-AI/Wan2.1-T2V-1.3B)
"""
import os
import time
from pathlib import Path
from urllib.parse import quote

import requests

GENERATED_DIR = Path(__file__).resolve().parent / "generated"
GENERATED_DIR.mkdir(exist_ok=True)

POLLINATIONS_BASE = "https://image.pollinations.ai/prompt"
HF_ROUTER = "https://router.huggingface.co/hf-inference/models"


class MediaError(Exception):
    pass


def _hf_token():
    return (
        os.getenv("HF_TOKEN")
        or os.getenv("HUGGINGFACE_API_KEY")
        or os.getenv("IMAGE_GEN_API_KEY")
        or os.getenv("VIDEO_GEN_API_KEY")
    )


def _choose_image_provider():
    explicit = (os.getenv("IMAGE_API_PROVIDER") or "").strip().lower()
    if explicit:
        return explicit
    # Pollinations gratis anonim (1 gambar/45s). HF inference sekarang butuh kredit
    # berbayar, jadi hanya dipakai kalau user eksplisit set IMAGE_API_PROVIDER=huggingface.
    return "pollinations"


def generate_image(prompt, width=1024, height=1024):
    """Mengembalikan (bytes, mime)."""
    provider = _choose_image_provider()

    if provider == "huggingface":
        return _hf_image(prompt, width, height)

    return _pollinations_image(prompt, width, height)


def _pollinations_image(prompt, width, height):
    model = os.getenv("IMAGE_MODEL", "flux").strip() or "flux"
    params = {
        "width": int(width),
        "height": int(height),
        "nologo": "true",
        "model": model,
    }
    token = os.getenv("POLLINATIONS_TOKEN")
    if token:
        params["token"] = token

    url = f"{POLLINATIONS_BASE}/{quote(prompt)}"

    last_error = ""
    for attempt in range(3):
        try:
            resp = requests.get(url, params=params, timeout=120)
        except requests.RequestException as exc:
            last_error = f"Gagal menghubungi Pollinations: {exc}"
            time.sleep(4)
            continue

        if resp.status_code == 200 and resp.content:
            mime = (resp.headers.get("Content-Type") or "image/jpeg").split(";")[0]
            return resp.content, mime

        last_error = f"HTTP {resp.status_code}. {resp.text[:220]}"
        # 429/5xx biasanya rate-limit sementara -> tunggu lalu coba lagi
        if resp.status_code in (429, 500, 502, 503, 504) and attempt < 2:
            time.sleep(6)
            continue
        # 402 = kuota gratis anonim Pollinations habis (1 gambar / 45 detik)
        if resp.status_code == 402:
            break
        break

    if "FREE_LIMIT" in last_error or "402" in last_error:
        raise MediaError(
            "Kuota gratis Pollinations tercapai (anonim: 1 gambar / 45 detik). "
            "Tunggu sebentar lalu coba lagi, atau isi HF_TOKEN / POLLINATIONS_TOKEN "
            "gratis di .env untuk limit lebih tinggi."
        )

    raise MediaError(
        "Pollinations gagal sementara (versi gratis punya batas). "
        "Coba lagi beberapa saat, atau isi POLLINATIONS_TOKEN / HF_TOKEN gratis di .env. "
        f"Detail: {last_error}"
    )


def _hf_image(prompt, width, height):
    token = _hf_token()
    if not token:
        raise MediaError(
            "Provider Hugging Face butuh HF_TOKEN gratis. "
            "Daftar di https://huggingface.co/settings/tokens lalu isi HF_TOKEN di .env."
        )

    model = os.getenv("IMAGE_MODEL", "stabilityai/stable-diffusion-3-medium-diffusers")
    try:
        resp = requests.post(
            f"{HF_ROUTER}/{model}",
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            json={"inputs": prompt, "parameters": {"width": width, "height": height}},
            timeout=180,
        )
    except requests.RequestException as exc:
        raise MediaError(f"Gagal menghubungi Hugging Face: {exc}")

    if resp.status_code != 200 or not resp.content:
        detail = resp.text[:300]
        if resp.status_code == 402:
            raise MediaError(
                "Hugging Face inference sekarang butuh kredit berbayar "
                "(Inference Pro). Pollinations tetap gratis."
            )
        raise MediaError(f"Hugging Face gagal (HTTP {resp.status_code}). {detail}")

    mime = (resp.headers.get("Content-Type") or "image/png").split(";")[0]
    return resp.content, mime


def generate_video(prompt):
    """Mengembalikan (bytes, mime). Butuh HF_TOKEN gratis."""
    token = _hf_token()
    if not token:
        raise MediaError(
            "Generate video butuh API key gratis. Buat token di "
            "https://huggingface.co/settings/tokens lalu isi HF_TOKEN di .env."
        )

    model = os.getenv("VIDEO_MODEL", "Wan-AI/Wan2.1-T2V-1.3B").strip()
    try:
        resp = requests.post(
            f"{HF_ROUTER}/{model}",
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
                "Accept": "video/mp4",
            },
            json={"inputs": prompt},
            timeout=300,
        )
    except requests.RequestException as exc:
        raise MediaError(f"Gagal menghubungi Hugging Face: {exc}")

    if resp.status_code != 200 or not resp.content:
        detail = resp.text[:300]
        if "not supported by provider" in detail or resp.status_code in (400, 404):
            raise MediaError(
                "Tidak ada API text-to-video GRATIS yang tersedia saat ini "
                "(Hugging Face tidak host model T2V di inference gratis). "
                "Video AI nyata butuh API berbayar (Replicate/fal.ai) atau token "
                "Pollinations berbayar. Alternatif gratis tanpa AI: generate lokal "
                "via ffmpeg (sudah terpasang) — beri tahu saya kalau mau diaktifkan."
            )
        raise MediaError(f"Hugging Face gagal (HTTP {resp.status_code}). {detail}")

    mime = (resp.headers.get("Content-Type") or "video/mp4").split(";")[0]
    return resp.content, mime


def save_generated(data, mime):
    """Simpan hasil biner ke folder generated dan kembalikan nama file."""
    ext = ".mp4"
    if "mp4" in mime:
        ext = ".mp4"
    elif "webm" in mime:
        ext = ".webm"
    elif "gif" in mime:
        ext = ".gif"
    filename = f"media_{int(time.time() * 1000)}{ext}"
    (GENERATED_DIR / filename).write_bytes(data)
    return filename
