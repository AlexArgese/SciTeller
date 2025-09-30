# ---- backend/Dockerfile ----
FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HF_HOME=/hf-cache

WORKDIR /app

# Dipendenze di sistema (minime ma necessarie)
# - build-essential -> per compilazioni leggere (alcune wheels)
# - poppler-utils   -> per pdf2image (pdftoppm)
# - libgl1, libglib2.0-0 -> per opencv/cv2
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    poppler-utils \
    libgl1 \
    libglib2.0-0 \
 && rm -rf /var/lib/apt/lists/*

# 1) Reqs del backend (tenere PRIMA del codice per sfruttare la cache)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 2) Vendorizza il pacchetto pure-Python "docparsing"
#    (contenuto in backend/vendor/docparsing)
COPY vendor /opt/vendor
ENV PYTHONPATH=/opt/vendor:${PYTHONPATH}

# 3) Crea lo "shim" del comando 'docparse'
RUN printf '%s\n' '#!/usr/bin/env python3' \
    'from docparsing.jobs.parse import main' \
    'if __name__ == "__main__": main()' \
    > /usr/local/bin/docparse && chmod +x /usr/local/bin/docparse

# 4) Copia il resto del codice dell'app
COPY . .

# Docparse di default è sul PATH
ENV DOCPARSE_BIN=docparse

EXPOSE 8000

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
