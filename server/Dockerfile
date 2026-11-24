# Piano Companion recognition server (homr). Works on Hugging Face Spaces (Docker),
# Google Cloud Run, Render, Fly.io or any machine with Docker.
FROM python:3.12-slim

# OpenCV (used by homr) needs these system libraries.
RUN apt-get update \
 && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Download homr's models now, so the first request doesn't wait for them
# and the server never needs to write into its own install directory.
RUN homr --init --gpu no && chmod -R a+rX /usr/local/lib/python3.12/site-packages

COPY app.py .

# Hugging Face Spaces runs containers as user 1000.
RUN useradd -m -u 1000 user
USER user
ENV HOME=/home/user PORT=7860 PYTHONUNBUFFERED=1
EXPOSE 7860
CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port ${PORT} --timeout-keep-alive 75"]
