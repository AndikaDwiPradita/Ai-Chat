
import requests
import json
import time

BASE_URL = "http://127.0.0.1:5000"

print("Mengambil daftar model...")

response = requests.get(
    f"{BASE_URL}/models",
    timeout=60
)

response.raise_for_status()
models = response.json()["data"]

print(f"Total model: {len(models)}")

for model in models:
    model_id = model["id"]

    print("\n" + "=" * 45)
    print("Menguji:", model_id)

    try:
        result = requests.post(
            f"{BASE_URL}/chat",
            json={
                "model": model_id,
                "messages": [
                    {
                        "role": "user",
                        "content": "Perkenalkan dirimu secara singkat."
                    }
                ]
            },
            timeout=120
        )

        data = result.json()

        if result.status_code == 200 and data.get("success"):
            print("STATUS: BERHASIL")
            print("Model aktual:", data.get("model"))
            print("Jawaban:", data.get("message"))
        else:
            print("STATUS: GAGAL")
            print("HTTP:", result.status_code)
            print("Error:", json.dumps(data, ensure_ascii=False))

    except requests.exceptions.RequestException as error:
        print("STATUS: ERROR")
        print(error)

    time.sleep(2)

print("\nPengujian semua model selesai.")
