# app.py — FastAPI for AI Scientist Storyteller (Mac backend)
# run: uvicorn app:app --reload --port 8000

import os, tempfile, subprocess, json, sys, pathlib, re
from typing import Optional, List, Dict, Any

from fastapi import FastAPI, UploadFile, File, Form, HTTPException, Body
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from dotenv import load_dotenv
import requests

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
    section: Optional[VmSection] = None   # ✅ typed section
    ops: RegenParagraphOps


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


# ========= Helpers =========
def _headers():
    h = {"Content-Type": "application/json"}
    if REMOTE_API_KEY:
        h["X-API-Key"] = REMOTE_API_KEY
    return h

def _gpu(url_path: str, payload: dict, timeout: int = 1800):
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

    # 1) Salva PDF temporaneo
    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tmp:
        tmp.write(await file.read())
        pdf_path = tmp.name

    # 2) Docparse → markdown
    out_dir = tempfile.mkdtemp(prefix="docparse_")
    cmd = [DOCPARSE_BIN, "default", "--file-path", pdf_path, "--output-dir", out_dir, "--output-format", "md"]
    try:
        print("[/api/explain] start docparse")
        subprocess.run(cmd, check=True, capture_output=True, text=True)
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
            "target_words": lp["target_words"],
            "retriever": retriever or RETRIEVAL_DEFAULTS["retriever"],
            "retriever_model": retriever_model or RETRIEVAL_DEFAULTS["retriever_model"],
            "k": int(k) if k is not None else RETRIEVAL_DEFAULTS["k"],
            "max_ctx_chars": int(max_ctx_chars) if max_ctx_chars is not None else RETRIEVAL_DEFAULTS["max_ctx_chars"],
            "seg_words": int(seg_words) if seg_words is not None else RETRIEVAL_DEFAULTS["seg_words"],
            "overlap_words": int(overlap_words) if overlap_words is not None else RETRIEVAL_DEFAULTS["overlap_words"],
        }
    }

    data = _gpu("/api/two_stage_story", payload, timeout=1800)
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
            "paperText": text,
            "lengthPreset": st_preset,
            "creativity": int(float(temp) * 100),
            "outline": outline,
            "storytellerParams": {
                "preset": st_preset,
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
            "target_words": lp["target_words"],
            # === NEW: retrieval (req o defaults) ===
            "retriever": req.retriever or RETRIEVAL_DEFAULTS["retriever"],
            "retriever_model": req.retriever_model or RETRIEVAL_DEFAULTS["retriever_model"],
            "k": int(req.k) if req.k is not None else RETRIEVAL_DEFAULTS["k"],
            "max_ctx_chars": int(req.max_ctx_chars) if req.max_ctx_chars is not None else RETRIEVAL_DEFAULTS["max_ctx_chars"],
            "seg_words": int(req.seg_words) if req.seg_words is not None else RETRIEVAL_DEFAULTS["seg_words"],
            "overlap_words": int(req.overlap_words) if req.overlap_words is not None else RETRIEVAL_DEFAULTS["overlap_words"],
        }
    }

    data = _gpu("/api/two_stage_story", payload, timeout=1800)
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
    top_p: float = 1.0
    # retrieval opzionali
    retriever: Optional[str] = None
    retriever_model: Optional[str] = None
    k: Optional[int] = None
    max_ctx_chars: Optional[int] = None
    seg_words: Optional[int] = None
    overlap_words: Optional[int] = None

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
    data = _gpu("/api/two_stage_story_from_outline", payload, timeout=1800)
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
    if not REMOTE_GPU_URL:
        raise HTTPException(503, "GPU remoto non configurato (REMOTE_GPU_URL).")

    persona  = req.persona or "General Public"
    title    = req.title or "Paper"
    text     = req.text or ""
    sections = req.sections or []
    targets  = set(int(i) for i in (req.targets or []) if isinstance(i, int))

    lp = resolve_length_params(req.length_preset or "medium", words=None)

    print(f"[/api/regen_sections_vm] length_preset IN = {req.length_preset!r} → resolved {lp}")

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
        "storyteller": {
            "preset": lp["preset"],
            "temperature": float(req.temp or 0.0),
            "top_p": float(req.top_p or 0.9),
            "max_new_tokens": lp["max_new_tokens"],
            "min_new_tokens": lp["min_new_tokens"],
            "target_words": lp["target_words"],
            **({ "retriever": req.retriever } if req.retriever is not None else {}),
            **({ "retriever_model": req.retriever_model } if req.retriever_model is not None else {}),
            **({ "k": int(req.k) } if req.k is not None else {}),
            **({ "max_ctx_chars": int(req.max_ctx_chars) } if req.max_ctx_chars is not None else {}),
            **({ "seg_words": int(req.seg_words) } if req.seg_words is not None else {}),
            **({ "overlap_words": int(req.overlap_words) } if req.overlap_words is not None else {}),
        },
    }
    data = _gpu("/api/two_stage_story_from_outline", payload, timeout=1800)

    # 3) Normalizza output VM e fai MERGE selettivo
    new_secs = _normalize_sections(data.get("sections", []))

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
        if i in targets and i < len(new_secs):
            gen = new_secs[i]
            merged.append({
                "id": (old.get("id") or f"sec-{i}"),
                "title": gen.get("title") or old.get("title") or f"Section {i+1}",
                "text": gen.get("text") or gen.get("narrative") or "",
                "paragraphs": gen.get("paragraphs") or [],
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
            "persona": persona,
            "temp": float(req.temp or 0.0),
            "top_p": float(req.top_p or 0.9),
            "lengthPreset": lp["preset"],
            "retriever": req.retriever,
            "retriever_model": req.retriever_model,
            "k": req.k,
            "max_ctx_chars": req.max_ctx_chars,
            "seg_words": req.seg_words,
            "overlap_words": req.overlap_words,
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

    payload = {
        "persona": req.persona,
        "paper_title": req.title or "Paper",
        "cleaned_text": req.text,
        "section": {
            "title": sec_title,
            "paragraphs": sec_paragraphs,
        },
        "section_index": int(req.section_index),
        "paragraph_index": int(req.paragraph_index),
        "ops": {
            "paraphrase": bool(req.ops.paraphrase),
            "simplify": bool(req.ops.simplify),
            "length_op": str(req.ops.length_op or "keep"),
        },
        # top-level sampling knobs (as your GPU VM expects them outside ops)
        "temperature": float(req.ops.temperature or 0.3),
        "top_p": float(req.ops.top_p or 0.9),
        "n": max(1, min(3, int(req.ops.n or 1))),
    }

    data = _gpu("/api/regen_paragraph_vm", payload, timeout=1800)

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
