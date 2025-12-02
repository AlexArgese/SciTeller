# backend/app.py — FastAPI for AI Scientist Storyteller (Mac backend)
# run: uvicorn app:app --reload --port 8000

import os, tempfile, subprocess, json, sys, pathlib, re, hashlib
from typing import Optional, List, Dict, Any
import uuid
from fastapi import FastAPI, UploadFile, File, Form, HTTPException, Body
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from dotenv import load_dotenv
import requests
import numpy as np
from sentence_transformers import SentenceTransformer, util
from fastapi.concurrency import run_in_threadpool

# === NEW: progress broker / SSE / misc ===
import asyncio, uuid
from fastapi import Request, Query
from fastapi.responses import StreamingResponse
import logging
logger = logging.getLogger("uvicorn.error")
PUBLIC_BASE_URL = os.environ.get("PUBLIC_BASE_URL", "").rstrip("/")  

load_dotenv()

# ===== Prompt builder (porting) =====
KEEP_TYPES = {"text", "title"}
DROP_TYPES = {"header", "table", "image", "list", "footer"}
TITLE_DROP_PREFIXES = re.compile(r"^\s{0,3}#{1,6}\s*(?:table|figure|fig\.?)\b", re.IGNORECASE)
REFS_HEADING_RE = re.compile(r"^\s{0,3}#{1,6}\s*References\b.*$", re.IGNORECASE | re.MULTILINE)

# ========= Length presets (coerenza globale) =========
LENGTH_PRESETS = {
    "short":  {"words_per_section": 90,  "max_new_tokens": 360,  "min_new_tokens": 120},
    "medium": {"words_per_section": 150, "max_new_tokens": 700,  "min_new_tokens": 360},
    "long":   {"words_per_section": 220, "max_new_tokens": 1100, "min_new_tokens": 650},
}

RETRIEVAL_DEFAULTS = {
    "retriever": "auto",                              # "auto" | "emb" | "tfidf"
    "retriever_model": "sentence-transformers/all-MiniLM-L6-v2",
    "k": 6,
    "max_ctx_chars": 2500,
    "seg_words": 180,
    "overlap_words": 60,
}

_EMBEDDER = None

def get_embedder():
    global _EMBEDDER
    if _EMBEDDER is None:
        # stesso modello usato come retriever di default
        _EMBEDDER = SentenceTransformer("sentence-transformers/all-MiniLM-L6-v2")
    return _EMBEDDER


def resolve_length_params(preset: str | None, words: int | None):
    p = (preset or "medium").lower()
    cfg = LENGTH_PRESETS.get(p, LENGTH_PRESETS["medium"])
    target_words = int(words) if (words and int(words) > 0) else cfg["words_per_section"]
    return {
        "preset": p,
        "target_words": target_words,
        "max_new_tokens": cfg["max_new_tokens"],
        "min_new_tokens": cfg["min_new_tokens"],
    }

def splitter_temp_from_story_temp(t: float) -> float:
    # splitting meno “creativo”
    return max(0.0, min(0.6, float(t) * 0.5))


def _extract_blocks(md_text: str):
    pattern = re.compile(r"<!--\s*(\{.*?\})\s*--\!?>", re.DOTALL)
    matches = list(pattern.finditer(md_text))
    blocks=[]
    for idx, m in enumerate(matches):
        meta_json = m.group(1)
        next_start = matches[idx+1].start() if idx+1 < len(matches) else len(md_text)
        content = md_text[m.end():next_start]
        try:
            meta = json.loads(meta_json); btype = str(meta.get("type","")).lower()
        except Exception:
            btype = "unknown"
        blocks.append({"type": btype, "content": content})
    return blocks

def extract_text_spans_with_layout(md_text: str):
    pattern = re.compile(r"<!--\s*(\{.*?\})\s*--\!?>", re.DOTALL)
    matches = list(pattern.finditer(md_text or ""))
    spans = []

    for idx, m in enumerate(matches):
        meta_json = m.group(1)
        next_start = matches[idx + 1].start() if idx + 1 < len(matches) else len(md_text)
        content = md_text[m.end():next_start]

        try:
            meta = json.loads(meta_json)
        except Exception:
            continue

        btype = str(meta.get("type", "")).lower()
        if btype != "text":
            continue  

        cleaned = _clean_text_paragraph(content)
        if not cleaned:
            continue

        pages = meta.get("pages") or [meta.get("page", 1)]
        bboxes = meta.get("bboxes") or meta.get("bbox_norm") or meta.get("bbox") or None

        if isinstance(bboxes, list) and len(bboxes) and isinstance(bboxes[0], list):
            # più bboxes → più spans, stesso testo
            for p, b in zip(pages, bboxes):
                spans.append({
                    "page": int(p),              # già 1-based
                    "bbox": [float(x) for x in b[:4]],
                    "text": cleaned,
                })
        else:
            # fallback: una sola bbox
            spans.append({
                "page": int(pages[0] or 1),
                "bbox": bboxes if isinstance(bboxes, list) else None,
                "text": cleaned,
            })

    return spans

def _clean_text_paragraph(txt: str) -> str:
    txt = re.sub(r"<!--.*?--\!?>", "", txt, flags=re.DOTALL).strip()
    if not txt: return ""
    txt = txt.replace("\r","")
    txt = re.sub(r"-\s*\n\s*", "", txt)
    txt = re.sub(r"\n{2,}", "<<<PARA>>>", txt)
    txt = re.sub(r"\s*\n\s*", " ", txt)
    txt = re.sub(r"\s{2,}", " ", txt)
    txt = txt.replace("<<<PARA>>>","\n\n")
    txt = re.sub(r"(?<=\w)-\s+(?=\w)", "", txt)
    return txt.strip()

def _clean_title_line(txt: str) -> str:
    txt = re.sub(r"<!--.*?--\!?>", "", txt, flags=re.DOTALL).strip()
    for line in txt.splitlines():
        line = line.strip()
        if line: return line
    return ""

def _filter_blocks(blocks):
    out_lines, first_h1 = [], None
    i=0
    while i < len(blocks):
        b = blocks[i]; btype=b["type"]; content=b["content"]
        if btype in DROP_TYPES or btype=="unknown":
            i+=1; continue
        if btype=="title":
            title_line = _clean_title_line(content)
            if not title_line: i+=1; continue
            if TITLE_DROP_PREFIXES.match(title_line):
                if i+1 < len(blocks) and blocks[i+1]["type"] in {"table","image"}:
                    i+=2; continue
                i+=1; continue
            out_lines.append(title_line)
            if first_h1 is None and re.match(r"^\s{0,3}#\s+\S", title_line):
                first_h1 = re.sub(r"^\s{0,3}#\s+","",title_line).strip()
            i+=1; continue
        if btype=="text":
            cleaned=_clean_text_paragraph(content)
            if cleaned: out_lines.append(cleaned)
            i+=1; continue
        i+=1
    return out_lines, first_h1

def _truncate_at_references(markdown_clean: str) -> str:
    m = REFS_HEADING_RE.search(markdown_clean)
    return markdown_clean[:m.start()].rstrip() if m else markdown_clean

def build_prompt_from_docuparser_md(md_text: str, persona: str, paper_title_hint: str | None) -> str:
    # (rimane qui se vuoi usarlo altrove; non viene usato nel flusso VM a 2 stadi)
    blocks = _extract_blocks(md_text)
    kept_lines, h1_title = _filter_blocks(blocks)
    assembled=[]
    for line in kept_lines:
        is_heading = bool(re.match(r"^\s{0,3}#{1,6}\s+\S", line))
        if is_heading and assembled and not assembled[-1].endswith("\n\n"):
            assembled.append("\n")
        assembled.append(line.strip()); assembled.append("\n\n")
    markdown_clean = "".join(assembled).strip()
    markdown_clean = _truncate_at_references(markdown_clean)

    paper_title = h1_title
    if not paper_title:
        m = re.search(r"^\s{0,3}#{1,6}\s+(.+)$", markdown_clean, flags=re.MULTILINE)
        paper_title = m.group(1).strip() if m else (paper_title_hint or "Paper")

    header = "You are an AI Scientist Storyteller.\n\n"
    persona_line = f"Persona: {persona}\n"
    title_line = f"Paper Title: {paper_title}\n\n"
    task = (
        "Task: Read the paper and (1) split it into logical sections; (2) for each section, write a short narrative tailored to the Persona.\n"
        "Respond only with a JSON object: {\"persona\": \"...\", \"sections\": [{\"title\":\"...\",\"narrative\":\"...\"}, ...]}.\n\n"
        "Rules (must follow):\n"
        "- Use ONLY facts present in the paper text below. Do NOT invent authors, institutions, URLs, numbers, or quotes.\n"
        "- Do NOT write quotations; always paraphrase in your own words.\n"
        "- If a detail is not stated in the paper, omit it (do not guess).\n"
        "- Never output URLs, web domains, social handles or repository names.\n"
        "- Prefer section titles that appear in the paper when present.\n"
        "- Keep each section concise (about 5–8 sentences).\n\n"
    )
    body = "Paper:\n" + markdown_clean.strip() + "\n"
    return header + persona_line + title_line + task + body

# ========= CONFIG =========
DOCPARSE_BIN = os.environ.get("DOCPARSE_BIN",
    "/Users/alex/Desktop/UNI/EURECOM/Internship/dataset/model/old_dataset/Document_Parsing/.venv/bin/docparse")

REMOTE_GPU_URL = os.environ.get("REMOTE_GPU_URL", "").rstrip("/")
if REMOTE_GPU_URL.endswith("/api"):
    REMOTE_GPU_URL = REMOTE_GPU_URL[:-4]
print(f"[CFG] REMOTE_GPU_URL base = {REMOTE_GPU_URL}")
REMOTE_API_KEY = os.environ.get("REMOTE_API_KEY", "")

# Local fallback (CPU) — lasciamo invariati per /api/regen, /api/para
os.environ.setdefault("STORY_MODEL_DIR", "/Users/alex/Desktop/UNI/EURECOM/Internship/webapp/backend/models/mistral7b_joint_merged_fp16")
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")

BASE_DIR = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(BASE_DIR))

# ========= FastAPI =========
TAGS_METADATA = [
    {"name": "Health", "description": "Liveness and readiness of the service."},
    {"name": "Explain", "description": "Upload a PDF → parse it → run 2-stage generation on the GPU VM → story JSON."},
    {"name": "Generate", "description": "Provide text/markdown → run 2-stage generation on the GPU VM → story JSON."},
    {"name": "VM Orchestrator", "description": "Regenerate a story from a precomputed outline on the GPU VM."},
]

app = FastAPI(
    title="AI Scientist Storyteller API",
    version="0.5.0",
    description=(
        "Mac backend orchestrating PDF parsing and story generation on a remote GPU VM.\n\n"
        "### Flow\n"
        "- **/api/explain**: PDF → docparse → markdown → split + story → JSON\n"
        "- **/api/generate_from_text**: text/markdown → split + story → JSON\n"
        "- **/api/regen**: regenerate one or more sections (local inference)\n"
        "- **/api/para**: paraphrase a paragraph (local inference)\n"
        "- **/api/regen_vm**: regenerate from a precomputed outline on the GPU VM\n\n"
        "Use `/docs` (Swagger UI) or `/redoc` for interactive documentation."
    ),
    openapi_tags=TAGS_METADATA,
)

app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

# ========= Progress endpoints =========

@app.post("/api/explain/new_job", tags=["Explain"])
def new_job():
    job_id = str(uuid.uuid4())
    _ensure_queue(job_id)
    return {"jobId": job_id}

@app.get("/api/explain/logs", tags=["Explain"])
async def explain_logs(jobId: str = Query(..., alias="jobId")):
    headers = {
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",   # 👈 DISATTIVA il buffering Nginx
    }
    return StreamingResponse(
        _sse_stream(jobId),
        media_type="text/event-stream",
        headers=headers,
    )


@app.post("/api/explain/progress", tags=["Explain"])
async def vm_progress(
    request: Request,
    jobId: str = Query(..., alias="jobId"),
    key: str | None = Query(None),
    body: dict = Body(...)
):
    # Autorizzazione: header X-API-Key o query ?key=
    api_key_hdr = request.headers.get("X-API-Key")
    if (api_key_hdr or key) != (REMOTE_API_KEY or ""):
        raise HTTPException(403, "forbidden")

    # Rilancia l'evento verso i client SSE
    await _emit_async(jobId, body)
    return {"ok": True}

# ========= Schemas =========
class StorySectionIn(BaseModel):
    title: str
    narrative: str

class StoryIn(BaseModel):
    persona: str
    sections: List[StorySectionIn]

class SectionOut(BaseModel):
    title: Optional[str] = None
    narrative: str
    paragraphs: Optional[List[str]] = None
    text: Optional[str] = None  

class ExplainResponse(BaseModel):
    persona: str
    title: Optional[str] = None
    docTitle: Optional[str] = None
    sections: List[SectionOut]
    meta: Optional[Dict[str, Any]] = None

class ExplainWithOutlineResponse(ExplainResponse):
    outline: Optional[List[Dict[str, Any]]] = None

class GenerateFromTextRequest(BaseModel):
    text: str
    persona: str
    words: int = 0
    limit_sections: int = 5
    temp: float = 0.0
    top_p: float = 0.9
    title: Optional[str] = "Paper"
    length_preset: str = "medium"
    # === NEW: retrieval knobs (opzionali) ===
    retriever: Optional[str] = None
    retriever_model: Optional[str] = None
    k: Optional[int] = None
    max_ctx_chars: Optional[int] = None
    seg_words: Optional[int] = None
    overlap_words: Optional[int] = None

class RegenSectionsVmReq(BaseModel):
    text: str
    persona: str
    title: Optional[str] = "Paper"
    sections: List[Dict[str, Any]]           # sezioni correnti [{id?, title, text?, paragraphs?, description?}, ...]
    targets: List[int]                        # indici da rigenerare (es: [0,2]), oppure passa titles se preferisci
    temp: float = 0.0
    top_p: float = 0.9
    length_preset: Optional[str] = None
    # retrieval opzionali
    retriever: Optional[str] = None
    retriever_model: Optional[str] = None
    k: Optional[int] = None
    max_ctx_chars: Optional[int] = None
    seg_words: Optional[int] = None
    overlap_words: Optional[int] = None

class RegenSectionsVmResp(BaseModel):
    persona: str
    title: Optional[str] = None
    sections: List[Dict[str, Any]]
    meta: Optional[Dict[str, Any]] = None

class VmSection(BaseModel):
    title: str | None = None
    paragraphs: list[str] = []


class RegenParagraphOps(BaseModel):
    paraphrase: bool = True
    simplify: bool = False
    length_op: str = "keep"     # keep | shorten | lengthen
    temperature: float = 0.0
    top_p: float = 0.9
    n: int = 1
    length_preset: str = "medium"

class RegenParagraphVmReq(BaseModel):
    persona: str = "General Public"
    title: Optional[str] = "Paper"
    text: str
    section_index: int
    paragraph_index: int
    paragraph_text: Optional[str] = None
    section: Optional[VmSection] = None
    ops: RegenParagraphOps
    # 👇 opzionali per compatibilità con la route Next
    temp: Optional[float] = None
    top_p: Optional[float] = None
    n: Optional[int] = None
    length_preset: Optional[str] = None



class RegenParagraphVmResp(BaseModel):
    alternatives: List[str] = []   # le proposte della VM (1..3)
    meta: Optional[Dict[str, Any]] = None

GenerateFromTextRequest.__doc__ = """
Generate a multi-section story from already-extracted text/markdown.
"""

generate_from_text_example = {
    "summary": "Clean markdown, 4 sections, low creativity",
    "value": {
        "text": "# Title\\n\\n## Introduction\\nThis paper studies ...",
        "persona": "Journalist",
        "length_preset": "medium",
        "words": 0,
        "limit_sections": 4,
        "temp": 0.2,
        "top_p": 0.9,
        "title": "Paper",
        "retriever": "auto",
        "k": 6
    }
}

# === DB helpers ===
import psycopg2
from contextlib import contextmanager

DATABASE_URL = os.environ.get("DATABASE_URL")  # es: postgres://aisci:***@postgres:5432/aisci_storyteller

@contextmanager
def db_conn():
    if not DATABASE_URL:
        raise RuntimeError("DATABASE_URL non configurato")
    conn = psycopg2.connect(DATABASE_URL)
    conn.autocommit = True
    try:
        yield conn
    finally:
        conn.close()


def _norm_url(u: str) -> str:
    if not u: return u
    u = u.strip()
    if u.endswith("/"): u = u[:-1]
    return u

def _get_or_create_paper_upload(pdf_bytes: bytes, filename: str) -> tuple[str, str | None, bool]:
    """
    Dedup per PDF uploadati, basata su colonna `sha256`.

    Ritorna:
      - paper_id: id del paper
      - file_url: URL del PDF sulla VM (può essere relativo tipo /papers/...)
      - dedup: True se il PDF era già in DB (stesso sha256), False se è nuovo
    """
    digest = hashlib.sha256(pdf_bytes).hexdigest()

    with db_conn() as conn, conn.cursor() as cur:
        # 1) cerco se esiste già un upload con lo stesso hash
        cur.execute("""
            SELECT id, url, file_path
            FROM papers
            WHERE sha256 = %s
              AND source_type = 'upload'
            LIMIT 1
        """, (digest,))
        row = cur.fetchone()

        if row:
            existing_id, existing_url, existing_path = row

            # caso ideale: abbiamo già un URL usabile (es. /papers/xxx.pdf sulla VM)
            if existing_url:
                return existing_id, existing_url, True

            # vecchi record "local-only": riuso l'id ma ricarico il file sulla VM
            paper_id = existing_id
        else:
            # nessun match → nuovo paper_id
            paper_id = str(uuid.uuid4())

        # 2) upload verso la VM con questo paper_id
        file_url = _vm_upload_pdf(paper_id, filename, pdf_bytes)

        # 3) scrivo/aggiorno riga in DB con sha256
        cur.execute("""
            INSERT INTO papers (id, source_type, url, sha256, created_at)
            VALUES (%s, 'upload', %s, %s, now())
            ON CONFLICT (id) DO UPDATE
            SET url = EXCLUDED.url,
                source_type = 'upload',
                sha256 = EXCLUDED.sha256
        """, (paper_id, file_url, digest))

    # se row esisteva → dedup=True, altrimenti False
    return paper_id, file_url, bool(row)

# ========= Helpers =========
def _vm_upload_pdf(paper_id: str, filename: str, pdf_bytes: bytes) -> str | None:
    # Prova prima con /api/papers/upload, poi fallback a /papers/upload
    for path in ("/api/papers/upload", "/papers/upload"):
        try:
            r = requests.post(
                f"{REMOTE_GPU_URL}{path}",
                files={"file": (filename, pdf_bytes, "application/pdf")},
                data={"paper_id": paper_id},
                timeout=60,
            )
            if r.ok:
                resp = r.json() or {}
                file_url = resp.get("file_url")
                print(f"[UPLOAD] OK via {path} → {file_url}")
                return file_url
            else:
                print(f"[UPLOAD] {path} → {r.status_code} {r.text}")
                # se è 404 continuo con il prossimo path
        except Exception as e:
            print(f"[UPLOAD] errore {path}: {e}")
    return None

def _headers():
    h = {"Content-Type": "application/json"}
    if REMOTE_API_KEY:
        h["X-API-Key"] = REMOTE_API_KEY
    return h

def _gpu(url_path: str, payload: dict, timeout: int = 3000):
    if not REMOTE_GPU_URL:
        raise RuntimeError("GPU URL not configured")
    r = requests.post(f"{REMOTE_GPU_URL}{url_path}", json=payload, headers=_headers(), timeout=timeout)
    if not r.ok:
        raise HTTPException(r.status_code, f"GPU service error: {r.text}")
    return r.json()


def _normalize_sections(sections: list[dict]) -> list[dict]:
    out = []
    for i, s in enumerate(sections or []):
        text = s.get("narrative") or s.get("text") or ""
        # split per paragrafi se non esistono già
        paras = s.get("paragraphs")
        if not paras:
            parts = [p.strip() for p in re.split(r"\n{2,}", text) if p.strip()]
            if not parts:  # fallback: split su .?!
                parts = re.split(r'(?<=[.!?])\s+(?=[A-ZÀ-ÖØ-Ý])', text)
            paras = [p.strip() for p in parts if p.strip()]

        out.append({
            **s,
            "id": s.get("id") or f"sec-{i}",
            "title": s.get("title") or f"Section {i+1}",
            "paragraphs": paras,
        })
    return out

# ========= SIMPLE PROGRESS BROKER (in-memory) =========
_jobs_queues: dict[str, asyncio.Queue] = {}

def _ensure_queue(job_id: str) -> asyncio.Queue:
    q = _jobs_queues.get(job_id)
    if q is None:
        q = asyncio.Queue()
        _jobs_queues[job_id] = q
    return q

async def _emit_async(job_id: str, event: dict):
    q = _ensure_queue(job_id)
    await q.put(event)

def _emit(job_id: str, event: dict):
    try:
        q = _ensure_queue(job_id)
        q.put_nowait(event)
    except Exception:
        pass

async def _sse_stream(job_id: str):
    q = _ensure_queue(job_id)
    # invia un saluto per agganciare il client
    yield f"event: hello\ndata: {json.dumps({'jobId': job_id})}\n\n"
    while True:
        event = await q.get()
        try:
            payload = json.dumps(event, ensure_ascii=False)
        except Exception:
            payload = json.dumps({"type": "error", "detail": "bad_event"})
        yield f"event: message\ndata: {payload}\n\n"

# ========= Routes =========
@app.get(
    "/health",
    tags=["Health"],
    summary="Healthcheck",
    description="Returns ok=True if the backend is alive."
)
def health():
    return {"ok": True}

@app.post(
    "/api/explain",
    tags=["Explain"],
    summary="Upload PDF → Story",
    description="Upload a PDF, extract markdown via docparse, then call the GPU VM (2 stages: splitter + storyteller).",
    response_model=ExplainResponse,
)
async def explain_endpoint(
    request: Request,
    jobId: str = Form(None, description="Progress job id (SSE)"),
    persona: str = Form(..., description="Target persona/audience (e.g., Journalist, General Public, Student, Expert)."),
    file: UploadFile = File(..., description="Paper PDF file."),
    length: str = Form("medium", description="Length preset: short | medium | long."),
    limit_sections: int = Form(5, description="Maximum number of sections."),
    temp: float = Form(0.0, description="Creativity (0–1) for the storyteller."),
    top_p: float = Form(0.9, description="Top-p sampling."),
    # --- firma /api/explain: aggiungi opzionali ---
    preset: str = Form("medium"),
    k: int | None = Form(None),
    max_ctx_chars: int | None = Form(None),
    retriever: str | None = Form(None),
    retriever_model: str | None = Form(None),
    seg_words: int | None = Form(None),
    overlap_words: int | None = Form(None),
):
    if not file.filename.lower().endswith(".pdf"):
        raise HTTPException(400, "Please upload a .pdf")
    
    # --- [A] Dedup + upload PDF su VM per la visualizzazione successiva ---
    pdf_bytes = await file.read()
    paper_id, file_url, dedup = _get_or_create_paper_upload(pdf_bytes, file.filename)
    view_url = f"/api/papers/{paper_id}/pdf"
    print(f"[/api/explain] paper_id={paper_id}, dedup={dedup}")

    if not file_url:
        print("[UPLOAD] nessun file_url restituito da _get_or_create_paper_upload")

    
    # progress: job id
    job_id = (jobId or str(uuid.uuid4()))
    try: _emit(job_id, {"type": "parsing_start"})
    except: pass

    # 1) Salva PDF temporaneo
    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tmp:
        tmp.write(pdf_bytes) 
        pdf_path = tmp.name

    # 2) Docparse → markdown (in thread separato, per non bloccare SSE)
    out_dir = tempfile.mkdtemp(prefix="docparse_")
    cmd = [DOCPARSE_BIN, "default", "--file-path", pdf_path, "--output-dir", out_dir, "--output-format", "md"]

    def _run_docparse():
        print("[/api/explain] start docparse")
        return subprocess.run(cmd, check=True, capture_output=True, text=True)

    try:
        await run_in_threadpool(_run_docparse)
    except subprocess.CalledProcessError as e:
        raise HTTPException(500, f"docparse error: {e.stderr or e.stdout or str(e)}")


    md_files = [f for f in os.listdir(out_dir) if f.endswith(".md")]
    if not md_files:
        raise HTTPException(500, "docparse produced no .md")
    md_path = os.path.join(out_dir, md_files[0])
    text = open(md_path, "r", encoding="utf-8").read()
    if not text.strip():
        raise HTTPException(500, "Empty markdown from docparse")
    print(f"[/api/explain] docparse ok, md_len={len(text)} — start two-stage VM")
    # parsing finito → notifica i client SSE
    try:
        _emit(job_id, {"type": "parsing_done"})
    except Exception:
        pass


    # 3) Chiamata VM: orchestratore 2 stadi
    if not REMOTE_GPU_URL:
        raise HTTPException(503, "GPU remoto non configurato (REMOTE_GPU_URL).")


    lp = resolve_length_params(length, words=None)  # in /api/explain non hai words esplicito
    split_temp = splitter_temp_from_story_temp(float(temp))
    st_preset = (preset or lp["preset"])

    payload = {
        "persona": persona,
        "paper_title": file.filename,
        "markdown": text,
        "target_sections": int(limit_sections) if int(limit_sections) > 0 else 5,
        "splitter": {
            "max_new_tokens": 768,
            "temperature": split_temp,
        },
        "storyteller": {
            "preset": st_preset,
            "temperature": float(temp),
            "top_p": float(top_p),
            "max_new_tokens": lp["max_new_tokens"],
            "min_new_tokens": lp["min_new_tokens"],
            "retriever": retriever or RETRIEVAL_DEFAULTS["retriever"],
            "retriever_model": retriever_model or RETRIEVAL_DEFAULTS["retriever_model"],
            "k": int(k) if k is not None else RETRIEVAL_DEFAULTS["k"],
            "max_ctx_chars": int(max_ctx_chars) if max_ctx_chars is not None else RETRIEVAL_DEFAULTS["max_ctx_chars"],
            "seg_words": int(seg_words) if seg_words is not None else RETRIEVAL_DEFAULTS["seg_words"],
            "overlap_words": int(overlap_words) if overlap_words is not None else RETRIEVAL_DEFAULTS["overlap_words"],
        }
    }

    if PUBLIC_BASE_URL:
        cb = f"{PUBLIC_BASE_URL}/api/explain/progress?jobId={job_id}"
        payload["callback_url"] = cb

    # 3) Chiamata VM: orchestratore 2 stadi, con soft-queue su 503 (GPU busy)
    if not REMOTE_GPU_URL:
        raise HTTPException(503, "GPU remoto non configurato (REMOTE_GPU_URL).")

    try:
        _emit(job_id, {"type": "generation_start"})
    except Exception:
        pass

    import time
    MAX_RETRIES = 100
    RETRY_DELAY_S = 5

    last_err = None

    def _gpu_call():
        return _gpu("/api/two_stage_story", payload, timeout=3000)

    for _ in range(MAX_RETRIES):
        try:
            data = await run_in_threadpool(_gpu_call)
            break
        except HTTPException as e:
            # se la VM dice 503 → GPU occupata → notifica coda e ritenta
            if e.status_code == 503:
                last_err = e
                try:
                    _emit(job_id, {
                        "type": "queue",
                        "detail": str(e.detail or "GPU busy"),
                    })
                except Exception:
                    pass
                time.sleep(RETRY_DELAY_S)
                continue
            # altri errori → rilancia
            raise
    else:
        # siamo usciti dal for senza break (troppi retry)
        raise HTTPException(503, f"GPU busy (max retries reached): {last_err}")

    try:
        _emit(job_id, {"type": "all_done"})
    except Exception:
        pass

    for s in data.get("sections", []):
        if "narrative" not in s and "text" in s:
            s["narrative"] = s["text"]
    sections = data.get("sections", [])
    outline = data.get("outline", [])

    story_title = (
        data.get("title")
        or (sections and isinstance(sections[0], dict) and sections[0].get("title"))
        or data.get("paper_title")
        or file.filename
        or "Story"
    )

    eff_retriever       = retriever or RETRIEVAL_DEFAULTS["retriever"]
    eff_retriever_model = retriever_model or RETRIEVAL_DEFAULTS["retriever_model"]
    eff_k               = int(k) if k is not None else RETRIEVAL_DEFAULTS["k"]
    eff_max_ctx_chars   = int(max_ctx_chars) if max_ctx_chars is not None else RETRIEVAL_DEFAULTS["max_ctx_chars"]
    eff_seg_words       = int(seg_words) if seg_words is not None else RETRIEVAL_DEFAULTS["seg_words"]
    eff_overlap_words   = int(overlap_words) if overlap_words is not None else RETRIEVAL_DEFAULTS["overlap_words"]

    return {
        "persona": persona,
        "title": story_title,
        "docTitle": data.get("paper_title") or file.filename,
        "sections": _normalize_sections(sections),
        "meta": {
            "paperId": paper_id,
            "paperUrl": view_url,
            "paperText": text,
            "lengthPreset": st_preset,
            "creativity": int(float(temp) * 100),
            "outline": outline,
            "dedup": bool(dedup),
            "storytellerParams": {
                "temperature": float(temp),
                "top_p": float(top_p),
                "max_new_tokens": lp["max_new_tokens"],
                "min_new_tokens": lp["min_new_tokens"],
                "target_words": lp["target_words"],
                "retriever": eff_retriever,
                "retriever_model": eff_retriever_model,
                "k": eff_k,
                "max_ctx_chars": eff_max_ctx_chars,
                "seg_words": eff_seg_words,
                "overlap_words": eff_overlap_words,
            },
            "splitterParams": {
                "max_new_tokens": 768,
                "temperature": split_temp,
            }
        }

    }

@app.post(
    "/api/generate_from_text",
    tags=["Generate"],
    summary="Text/Markdown → Story",
    description="Provide text/markdown directly; applies split + story on the GPU VM.",
    response_model=ExplainResponse,
)
def generate_from_text(req: GenerateFromTextRequest = Body(..., examples={"default": generate_from_text_example})):
    # Usa lo stesso flusso a 2 stadi, passando il testo come "markdown"
    if not REMOTE_GPU_URL:
        raise HTTPException(503, "GPU remoto non configurato (REMOTE_GPU_URL).")

    lp = resolve_length_params(req.length_preset or "medium", req.words)
    split_temp = splitter_temp_from_story_temp(float(req.temp))

    payload = {
        "persona": req.persona,
        "paper_title": req.title or "Paper",
        "markdown": req.text,
        "target_sections": int(req.limit_sections) if int(req.limit_sections) > 0 else 5,
        "splitter": {
            "max_new_tokens": 768,
            "temperature": split_temp,
        },
        "storyteller": {
            "preset": lp["preset"],
            "temperature": float(req.temp),
            "top_p": float(req.top_p),
            "max_new_tokens": lp["max_new_tokens"],
            "min_new_tokens": lp["min_new_tokens"],
            # === NEW: retrieval (req o defaults) ===
            "retriever": req.retriever or RETRIEVAL_DEFAULTS["retriever"],
            "retriever_model": req.retriever_model or RETRIEVAL_DEFAULTS["retriever_model"],
            "k": int(req.k) if req.k is not None else RETRIEVAL_DEFAULTS["k"],
            "max_ctx_chars": int(req.max_ctx_chars) if req.max_ctx_chars is not None else RETRIEVAL_DEFAULTS["max_ctx_chars"],
            "seg_words": int(req.seg_words) if req.seg_words is not None else RETRIEVAL_DEFAULTS["seg_words"],
            "overlap_words": int(req.overlap_words) if req.overlap_words is not None else RETRIEVAL_DEFAULTS["overlap_words"],
        }
    }

    data = _gpu("/api/two_stage_story", payload, timeout=3000)
    for s in data.get("sections", []):
        if "narrative" not in s and "text" in s:
            s["narrative"] = s["text"]

    sections = data.get("sections", [])
    outline  = data.get("outline", [])

    eff_retriever       = req.retriever or RETRIEVAL_DEFAULTS["retriever"]
    eff_retriever_model = req.retriever_model or RETRIEVAL_DEFAULTS["retriever_model"]
    eff_k               = int(req.k) if req.k is not None else RETRIEVAL_DEFAULTS["k"]
    eff_max_ctx_chars   = int(req.max_ctx_chars) if req.max_ctx_chars is not None else RETRIEVAL_DEFAULTS["max_ctx_chars"]
    eff_seg_words       = int(req.seg_words) if req.seg_words is not None else RETRIEVAL_DEFAULTS["seg_words"]
    eff_overlap_words   = int(req.overlap_words) if req.overlap_words is not None else RETRIEVAL_DEFAULTS["overlap_words"]

    return {
        "persona": data.get("persona", req.persona),
        "title": data.get("title"),
        "docTitle": data.get("paper_title", req.title or "Paper"),
        "sections": _normalize_sections(sections),
        "meta": {
            "paperText": req.text,                 # 👈 serve dopo per regen parziale/nuove chiamate
            "lengthPreset": lp["preset"],
            "creativity": int(float(req.temp or 0.0) * 100),
            "outline": outline,
            "storytellerParams": {
                "preset": lp["preset"],
                "temperature": float(req.temp),
                "top_p": float(req.top_p),
                "max_new_tokens": lp["max_new_tokens"],
                "min_new_tokens": lp["min_new_tokens"],
                "target_words": lp["target_words"],
                "retriever": eff_retriever,
                "retriever_model": eff_retriever_model,
                "k": eff_k,
                "max_ctx_chars": eff_max_ctx_chars,
                "seg_words": eff_seg_words,
                "overlap_words": eff_overlap_words,
            },
        },
    }

class RegenVmRequest(BaseModel):
    persona: str
    text: str                  # markdown pulito
    outline: List[Dict[str, Any]]
    title: Optional[str] = "Paper"
    length: str = "medium"
    temp: float = 0.0
    top_p: float = 0.9
    # retrieval opzionali
    retriever: Optional[str] = None
    retriever_model: Optional[str] = None
    k: Optional[int] = None
    max_ctx_chars: Optional[int] = None
    seg_words: Optional[int] = None
    overlap_words: Optional[int] = None

@app.post("/api/papers/intake", tags=["Explain"])
async def intake_paper(
    file: UploadFile | None = File(None),
    link: str | None = Form(None)
):
    """
    Intake di un paper: salva PDF o registra link remoto.
    Scrive SEMPRE su DB nella tabella 'papers'.
    Ritorna { paper_id, dedup, paper_url }.
    """
    paper_id = str(uuid.uuid4())
    dedup = False
    paper_url = None

    # ====== Caso A: UPLOAD PDF (con dedup su sha256) ======
    if file is not None:
        pdf_bytes = await file.read()
        paper_id, file_url, dedup = _get_or_create_paper_upload(pdf_bytes, file.filename)
        return {"paper_id": paper_id, "dedup": bool(dedup), "paper_url": file_url}


    # ====== Caso B: LINK remoto ======
    if link:
        norm = _norm_url(link)
        paper_url = norm
        with db_conn() as conn, conn.cursor() as cur:
            cur.execute("""
                INSERT INTO papers (id, source_type, url, created_at)
                VALUES (%s, 'link', %s, now())
                ON CONFLICT DO NOTHING
            """, (paper_id, norm))

            cur.execute("SELECT id, source_type FROM papers WHERE lower(url) = lower(%s)", (norm,))
            row = cur.fetchone()
            if row:
                existing_id, st = row
                dedup = (existing_id != paper_id)
                paper_id = existing_id
                if st != 'link':
                    cur.execute("UPDATE papers SET source_type='link' WHERE id=%s", (paper_id,))
            else:
                print("[INTAKE] WARNING: insert link non visibile in SELECT, controlla vincoli")

        print(f"[INTAKE] Link registrato in DB → {norm} (dedup={dedup}, id={paper_id})")
        return {"paper_id": paper_id, "dedup": dedup, "paper_url": paper_url}

    raise HTTPException(400, "Serve un file o un link")

@app.post(
    "/api/regen_vm",
    tags=["VM Orchestrator"],
    summary="Regenerate from outline (GPU VM)",
    description="Regenerate a story given a precomputed outline on the GPU VM.",
    response_model=ExplainWithOutlineResponse,
)
def regen_vm(req: RegenVmRequest):
    if not REMOTE_GPU_URL:
        raise HTTPException(503, "GPU remoto non configurato (REMOTE_GPU_URL).")

    lp = resolve_length_params(req.length, words=None)
    payload = {
        "persona": req.persona,
        "paper_title": req.title or "Paper",
        "cleaned_text": req.text,
        "outline": req.outline,
        "storyteller": {
            "preset": lp["preset"],
            "temperature": float(req.temp),
            "top_p": float(req.top_p),
            "max_new_tokens": lp["max_new_tokens"],
            "min_new_tokens": lp["min_new_tokens"],
            # retrieval (se presenti)
            **({ "retriever": req.retriever } if req.retriever else {}),
            **({ "retriever_model": req.retriever_model } if req.retriever_model else {}),
            **({ "k": int(req.k) } if req.k is not None else {}),
            **({ "max_ctx_chars": int(req.max_ctx_chars) } if req.max_ctx_chars is not None else {}),
            **({ "seg_words": int(req.seg_words) } if req.seg_words is not None else {}),
            **({ "overlap_words": int(req.overlap_words) } if req.overlap_words is not None else {}),
        }
    }
    data = _gpu("/api/two_stage_story_from_outline", payload, timeout=3000)
    return {
        "persona": data.get("persona", req.persona),
        "title": data.get("title") or req.title or "Paper",
        "docTitle": data.get("paper_title") or req.title or "Paper",
        "sections": _normalize_sections(data.get("sections", [])),
        "outline": data.get("outline", []),
        "meta": data.get("meta", {}),
    }

@app.post(
    "/api/regen_sections_vm",
    tags=["VM Orchestrator"],
    summary="Rigenera SOLO alcune sezioni (via outline, una sola chiamata VM)",
    response_model=RegenSectionsVmResp,
)
def regen_sections_vm(req: RegenSectionsVmReq):
    logger.info(
        "[/api/regen_sections_vm] CALLED persona=%r title=%r temp=%r length_preset=%r targets=%r",
        req.persona, req.title, req.temp, req.length_preset, req.targets,
    )
    if not REMOTE_GPU_URL:
        raise HTTPException(503, "GPU remoto non configurato (REMOTE_GPU_URL).")

    persona  = req.persona or "General Public"
    title    = req.title or "Paper"
    text     = req.text or ""
    sections = req.sections or []
    targets  = set(int(i) for i in (req.targets or []) if isinstance(i, int))

    lp = resolve_length_params(req.length_preset or "medium", words=None)
    raw_temp = float(req.temp or 0.0)
    if raw_temp > 1.2:
        raw_temp = raw_temp / 100.0

    print(f"[/api/regen_sections_vm] length_preset IN = {req.length_preset!r} → resolved {lp}, temp_in={req.temp}, temp_norm={raw_temp}")

    # 1) Costruisci l'outline completo (title + description)
    def _desc_from(sec: dict) -> str:
        # usa description se c'è, altrimenti la prima frase/testo breve
        if isinstance(sec.get("description"), str) and sec["description"].strip():
            return sec["description"].strip()
        raw = (sec.get("text") or "") if isinstance(sec.get("text"), str) else ""
        if not raw:
            paras = sec.get("paragraphs") or []
            raw = paras[0] if paras else ""
        # piglia le prime ~2 frasi come hint
        parts = re.split(r'(?<=[.!?])\s+(?=[A-ZÀ-ÖØ-Ý])', raw.strip())
        return " ".join(parts[:2]).strip()

    outline = [
        {
            "title": (sec.get("title") or f"Section {i+1}"),
            "description": _desc_from(sec) or "",
        }
        for i, sec in enumerate(sections)
    ]

    # 2) Chiama la VM UNA VOLTA come negli altri endpoint (coerente con /api/explain)
    payload = {
        "persona": persona,
        "paper_title": title,
        "cleaned_text": text,
        "outline": outline,
        "targets": sorted(list(targets)),
        "storyteller": {
            "preset": lp["preset"],
            "temperature": raw_temp, 
            "top_p": float(req.top_p or 0.9),
            "max_new_tokens": lp["max_new_tokens"],
            "min_new_tokens": lp["min_new_tokens"],
            **({ "retriever": req.retriever } if req.retriever is not None else {}),
            **({ "retriever_model": req.retriever_model } if req.retriever_model is not None else {}),
            **({ "k": int(req.k) } if req.k is not None else {}),
            **({ "max_ctx_chars": int(req.max_ctx_chars) } if req.max_ctx_chars is not None else {}),
            **({ "seg_words": int(req.seg_words) } if req.seg_words is not None else {}),
            **({ "overlap_words": int(req.overlap_words) } if req.overlap_words is not None else {}),
        },
    }
    data = _gpu("/api/regen_sections_vm", payload, timeout=3000)

    # 3) Normalizza output VM e fai MERGE selettivo
    sparse = data.get("sections", {}) or {}

    def _norm_keep(sec: dict, i: int) -> dict:
        # normalizza la sezione "kept" per avere sempre paragraphs coerenti
        paras = sec.get("paragraphs") or []
        if not paras and isinstance(sec.get("text"), str):
            parts = [p.strip() for p in re.split(r"\n{2,}", sec["text"]) if p.strip()]
            if not parts:
                parts = re.split(r'(?<=[.!?])\s+(?=[A-ZÀ-ÖØ-Ý])', sec["text"])
            paras = [p.strip() for p in parts if p.strip()]
        return {
            "id": sec.get("id") or f"sec-{i}",
            "title": sec.get("title") or f"Section {i+1}",
            "text": sec.get("text") or "",
            "paragraphs": paras,
            "hasImage": bool(sec.get("hasImage")),
            "visible": sec.get("visible", True),
            "description": sec.get("description") or None,
        }

    merged = []
    for i, old in enumerate(sections):
        if i in targets and str(i) in sparse:
            gen_norm = _normalize_sections([sparse[str(i)]])[0]
            merged.append({
                "id": (old.get("id") or f"sec-{i}"),
                "title": gen_norm.get("title") or old.get("title") or f"Section {i+1}",
                "text": gen_norm.get("text") or gen_norm.get("narrative") or "",
                "paragraphs": gen_norm.get("paragraphs") or [],
                "temp": float(req.temp or 0.0),
                "lengthPreset": lp["preset"],
                "hasImage": bool(old.get("hasImage")),
                "visible": old.get("visible", True),
                "description": old.get("description") or None,
            })
        else:
            merged.append(_norm_keep(old, i))


    # 4) Meta semplice + stats
    def _wc(s): return len(re.findall(r"\b\w+\b", s or ""))
    per_sec = [{"title": s["title"], "words": _wc(s.get("text","")), "paragraphs": len(s.get("paragraphs") or []), "chars": len(s.get("text",""))} for s in merged]
    avg_words = int(round(sum(x["words"] for x in per_sec) / max(1, len(per_sec))))
    avg_paras = float(sum(x["paragraphs"] for x in per_sec)) / max(1, len(per_sec))
    total_words = sum(x["words"] for x in per_sec)

    meta = {
        "upstreamParams": {
            "mode": "regen_partial_vm_outline",
            "targets": sorted(list(targets)),
        },
        "lastPartialRegen": {
        "at": __import__("datetime").datetime.utcnow().isoformat() + "Z",
        "temp": float(req.temp or 0.0),
        "top_p": float(req.top_p or 0.9),
        "lengthPreset": lp["preset"],
        "targets": sorted(list(targets)),
        },
        "stats": {
            "per_section": per_sec,
            "avg_words": avg_words,
            "avg_paragraphs": round(avg_paras, 2),
            "total_words": total_words,
            "sections": len(merged),
        }
    }

    return {"persona": persona, "title": (data.get("title") or title), "sections": merged, "meta": meta}

@app.post("/api/regen_paragraph_vm", tags=["VM Orchestrator"], summary="Rigenera un singolo paragrafo (GPU VM)", response_model=RegenParagraphVmResp)
def regen_paragraph_vm(req: RegenParagraphVmReq):
    if not REMOTE_GPU_URL:
        raise HTTPException(503, "GPU remoto non configurato (REMOTE_GPU_URL).")

    # --- SAFETY: section + paragraphs present?
    sec_title = (req.section.title if req.section and req.section.title else f"Section {req.section_index+1}")
    sec_paragraphs = (req.section.paragraphs if req.section and req.section.paragraphs else [])

    if not sec_paragraphs:
        # The upstream VM needs the actual paragraph list to validate indices
        raise HTTPException(422, "missing section paragraphs")

    if req.paragraph_index < 0 or req.paragraph_index >= len(sec_paragraphs):
        raise HTTPException(422, "invalid paragraph_index for provided section.paragraphs")
    
    # merge knobs (leggi sia top-level che ops.*)
    temp = (req.temp if req.temp is not None else req.ops.temperature) or 0.3
    top_p = (req.top_p if req.top_p is not None else req.ops.top_p) or 0.9
    n = int((req.n if req.n is not None else req.ops.n) or 1)
    n = max(1, min(3, n))

    length_preset = (req.length_preset or req.ops.length_preset or "medium")
    length_op = (req.ops.length_op or "keep")

    payload = {
        "persona": req.persona,
        "paper_title": req.title or "Paper",
        "cleaned_text": req.text,
        "section": {"title": sec_title, "paragraphs": sec_paragraphs},
        "section_index": int(req.section_index),
        "paragraph_index": int(req.paragraph_index),
        "ops": {
            "paraphrase": bool(req.ops.paraphrase),
            "simplify": bool(req.ops.simplify),
            "length_op": str(length_op),
        },
        # sampling knobs (VM si aspetta top-level)
        "temperature": float(temp),
        "top_p": float(top_p),
        "n": n,
        # 👇 fondamentale per la lunghezza
        "length_preset": str(length_preset),
    }

    data = _gpu("/api/regen_paragraph_vm", payload, timeout=3000)

    alts_raw = data.get("alternatives") or []
    alts = []
    for a in alts_raw:
        alts.append(a["text"].strip() if isinstance(a, dict) and "text" in a else (a.strip() if isinstance(a, str) else ""))

    return {
        "alternatives": [x for x in alts if x],
        "meta": data.get("meta") or {
            "upstreamParams": {
                "mode": "regen_paragraph_vm",
                "section_index": req.section_index,
                "paragraph_index": req.paragraph_index,
                "ops": req.ops.model_dump(),
            }
        }
    }

@app.post("/api/locate_section")
def locate_section(body: dict = Body(...)):
    """
    Trova i blocchi del PDF più simili alla section della story.

    Input (dal frontend):
    {
      "paperId": "...",
      "section_text": "...",
      "section_title": "...",
      "W": 3,         # (per ora ignorato)
      "topk": 8,      # usato solo come limite tecnico, NON come numero di match mostrati
      "paperText": "markdown docparse con meta {type,page,bbox} nei commenti"
    }

    Output:
    {
      "best": { "page": int (0-based), "bbox": [x1,y1,x2,y2], "score": float },
      "alternatives": [ { "page": ..., "bbox": [...], "score": ... }, ... ],
      "meta": { "score": best_score }
    }
    """
    paper_id      = body.get("paperId")
    section_text  = (body.get("section_text")  or "").strip()
    section_title = (body.get("section_title") or "").strip()
    W             = int(body.get("W") or 3)
    topk          = int(body.get("topk") or 8)
    md_text       = (body.get("paperText") or "").strip()

    if not md_text:
        # se manca il testo annotato, fallback stub
        return {
            "best": {"page": 0, "bbox": [0.10, 0.18, 0.90, 0.30], "score": 0.0},
            "alternatives": [],
            "meta": {"score": 0.0, "reason": "missing_paperText"},
        }

    spans = extract_text_spans_with_layout(md_text)
    if not spans:
        return {
            "best": {"page": 0, "bbox": [0.10, 0.18, 0.90, 0.30], "score": 0.0},
            "alternatives": [],
            "meta": {"score": 0.0, "reason": "no_text_spans"},
        }

    # 👇 nuovo check: se tutte le pagine sono 0 e tutte le bbox sono None → layout mancante
    all_pages = {s.get("page", 0) for s in spans}
    all_bbox_none = all(s.get("bbox") is None for s in spans)

    if all_pages == {0} and all_bbox_none:
        return {
            "best": {"page": 0, "bbox": [0.10, 0.18, 0.90, 0.30], "score": 0.0},
            "alternatives": [],
            "meta": {
                "score": 0.0,
                "n_spans": len(spans),
                "reason": "no_layout_info_in_meta"
            },
        }


    # testo query: titolo + testo se entrambi presenti
    query_text = (section_title + "\n\n" + section_text).strip() or section_text or section_title
    if not query_text:
        return {
            "best": {"page": spans[0]["page"], "bbox": spans[0]["bbox"], "score": 0.0},
            "alternatives": [],
            "meta": {"score": 0.0, "reason": "empty_section_text"},
        }

    model = get_embedder()
    # embed normalizzati (cosine = dot product)
    q_emb = model.encode(query_text, convert_to_tensor=True, normalize_embeddings=True)
    docs_emb = model.encode([s["text"] for s in spans], convert_to_tensor=True, normalize_embeddings=True)

    # cosine similarity
    scores = util.cos_sim(q_emb, docs_emb)[0].cpu().numpy()  # shape: (n_spans,)
    scores = scores.astype(float)

    # ordina per score decrescente
    order = np.argsort(-scores)
    # limita a topk candidati per ragioni di efficienza
    if topk > 0 and topk < len(order):
        order = order[:topk]

    # se i punteggi sono tutti molto bassi → fallback
    best_idx = int(order[0])
    best_score = float(scores[best_idx])
    print("[DEBUG locate] span[best_idx] meta:", spans[best_idx])


    base_floor = 0.70
    rel_margin = 0.15
    threshold = max(base_floor, best_score - rel_margin)

    # prendi tutti i candidati sopra soglia (ordinati)
    good_indices = [int(i) for i in order if scores[int(i)] >= threshold]

    # fallback: se proprio nessuno supera la soglia, prendi solo il best
    if not good_indices:
        good_indices = [best_idx]


    def _mk_entry(idx: int) -> dict:
        span = spans[idx]
        bbox = span.get("bbox") or [0.10, 0.18, 0.90, 0.30]

        # docparse usa pagine 0-based → qui le convertiamo a 1-based per il client
        page0 = int(span.get("page", 0) or 0)
        page1 = page0 + 1

        return {
            "page": page1,   # 👈 ora l’API è 1-based
            "bbox": [float(b) for b in bbox[:4]],
            "score": float(scores[idx]),
        }


    best_entry = _mk_entry(good_indices[0])
    alt_entries = [_mk_entry(i) for i in good_indices[1:]]

    return {
        "best": best_entry,
        "alternatives": alt_entries,
        "meta": {"score": best_entry["score"], "n_spans": len(spans), "threshold": threshold},
    }


import requests
from fastapi.responses import StreamingResponse

@app.get("/api/papers/{paper_id}/pdf")
def get_paper_pdf(paper_id: str):
    with db_conn() as conn, conn.cursor() as cur:
        cur.execute("SELECT url FROM papers WHERE id=%s", (paper_id,))
        row = cur.fetchone()
    if not row or not row[0]:
        raise HTTPException(404, "PDF URL not found for this paper")

    file_url = row[0]
    # Se relativo, costruisci URL interno verso la VM (usabile dal backend)
    if file_url.startswith("/"):
        file_url = f"{REMOTE_GPU_URL.rstrip('/')}{file_url}"

    try:
        r = requests.get(file_url, stream=True, timeout=60)
        if not r.ok:
            raise HTTPException(r.status_code, f"Upstream PDF fetch failed: {r.text[:200]}")
        return StreamingResponse(r.iter_content(chunk_size=65536),
                                 media_type="application/pdf",
                                 headers={"Content-Disposition": f'inline; filename="{paper_id}.pdf"'})
    except requests.RequestException as e:
        raise HTTPException(502, f"Upstream error: {e}")
    

from fastapi.responses import StreamingResponse

@app.get("/api/pdf-proxy")
def pdf_proxy(url: str):
    """
    Proxy per PDF esterni: evita problemi CORS lato browser.
    Uso: /svc/api/pdf-proxy?url=...
    """
    if not url:
        raise HTTPException(400, "url query param is required")

    try:
        r = requests.get(url, stream=True, timeout=60)
    except requests.RequestException as e:
        raise HTTPException(502, f"Upstream fetch failed: {e}")

    if not r.ok:
        raise HTTPException(r.status_code, f"Upstream returned {r.status_code}")

    return StreamingResponse(
        r.iter_content(chunk_size=65536),
        media_type="application/pdf",
        headers={
            "Content-Disposition": 'inline; filename="proxied.pdf"',
        },
    )
