# Ai-Chat — Flask backend + frontend statis
FROM python:3.12-slim

WORKDIR /app

# Dependensi Python (requirements-optional/MCP bersifat opsional).
COPY requirements.txt requirements-optional.txt ./
RUN pip install --no-cache-dir -r requirements.txt
RUN pip install --no-cache-dir -r requirements-optional.txt || true

COPY backend ./backend
COPY frontend ./frontend

ENV HOST=0.0.0.0 \
    PORT=5000 \
    PYTHONUNBUFFERED=1

EXPOSE 5000

CMD ["python", "backend/app.py"]
