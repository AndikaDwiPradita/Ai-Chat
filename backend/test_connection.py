
import os
import requests
from dotenv import load_dotenv

load_dotenv()

API_KEY = os.getenv("ORCAROUTER_API_KEY")
BASE_URL = "https://api.orcarouter.ai/v1/chat/completions"
MODEL = "deepseek/deepseek-v4-flash-free"

if not API_KEY:
    print("ERROR: API Key tidak ditemukan di .env")
    raise SystemExit(1)

print("Menghubungkan ke OrcaRouter...")

headers = {
    "Authorization": f"Bearer {API_KEY}",
    "Content-Type": "application/json"
}

payload = {
    "model": MODEL,
    "messages": [
        {
            "role": "user",
            "content": "Halo! Perkenalkan dirimu secara singkat."
        }
    ]
}

try:
    response = requests.post(
        BASE_URL,
        headers=headers,
        json=payload,
        timeout=60
    )

    if response.status_code != 200:
        print("KONEKSI GAGAL!")
        print("HTTP Status:", response.status_code)
        print("Pesan:", response.text[:1000])
        raise SystemExit(1)

    data = response.json()

    print("\nKONEKSI BERHASIL!")
    print("Model:", data.get("model"))

    answer = data["choices"][0]["message"]["content"]
    print("Jawaban:", answer)

    usage = data.get("usage")
    if usage:
        print("Total token:", usage.get("total_tokens"))

except requests.exceptions.RequestException as error:
    print("\nMASALAH KONEKSI!")
    print(type(error).__name__, error)

