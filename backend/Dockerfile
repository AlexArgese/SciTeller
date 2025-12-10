# ---- backend/Dockerfile ----
FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HF_HOME=/hf-cache

WORKDIR /app

# Dipendenze di sistema
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    poppler-utils \
    libgl1 \
    libglib2.0-0 \
 && rm -rf /var/lib/apt/lists/*

# Install requirements (INCLUDE spaCy + en-core-web-sm)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
RUN python -m spacy download en_core_web_sm
RUN python -m spacy validate

# HuggingFace cache
RUN mkdir -p /hf-cache/hub /hf-cache/transformers
ENV HF_HOME=/hf-cache
ENV HUGGINGFACE_HUB_CACHE=/hf-cache/hub
ENV TRANSFORMERS_CACHE=/hf-cache/transformers

# Vendor package
COPY vendor /opt/vendor
ENV PYTHONPATH=/opt/vendor:${PYTHONPATH}

# Shim docparse
RUN printf '%s\n' '#!/usr/bin/env python3' \
    'from docparsing.jobs.parse import main' \
    'if __name__ == "__main__": main()' \
    > /usr/local/bin/docparse && chmod +x /usr/local/bin/docparse

# App code
COPY . .

ENV DOCPARSE_BIN=docparse

EXPOSE 8000
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]