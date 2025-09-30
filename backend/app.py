# app.py — FastAPI for AI Scientist Storyteller (Mac backend)
# run: uvicorn app:app --reload --port 8000

import os, tempfile, subprocess, json, sys, pathlib, re
from typing import Optional, List, Dict, Any

from fastapi import FastAPI, UploadFile, File, Form, HTTPException
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
story_ops = None

# ========= FastAPI =========
app = FastAPI(title="AI Scientist Storyteller API", version="0.5.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

# ========= Schemas =========
class StorySectionIn(BaseModel):
    title: str
    narrative: str

class StoryIn(BaseModel):
    persona: str
    sections: List[StorySectionIn]

class ExplainResponse(BaseModel):
    persona: str
    title: Optional[str] = None          # <- aggiungi
    docTitle: Optional[str] = None
    sections: list
    meta: Optional[Dict[str, Any]] = None

class GenerateFromTextRequest(BaseModel):
    text: str
    persona: str
    length: str = "medium"
    words: int = 0
    limit_sections: int = 5
    temp: float = 0.0
    top_p: float = 0.9
    title_style: str = "canonical"
    title_max_words: int = 0
    title: Optional[str] = "Paper"
    length_preset: str = "medium"
    # === NEW: retrieval knobs (opzionali) ===
    retriever: Optional[str] = None
    retriever_model: Optional[str] = None
    k: Optional[int] = None
    max_ctx_chars: Optional[int] = None
    seg_words: Optional[int] = None
    overlap_words: Optional[int] = None

class RegenRequest(BaseModel):
    text: str
    persona: str
    story: StoryIn
    sections: List[str]
    length: str = "long"
    words: int = 0
    alts: int = 1
    temp: float = 0.7
    top_p: float = 0.9

class ParaRequest(BaseModel):
    persona: str
    text: str
    words: int = 150
    alts: int = 1
    temp: float = 0.7
    top_p: float = 0.9

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

def _local_story(req: GenerateFromTextRequest):
    return story_ops.story_full(
        req.text, req.persona,
        title=(req.title or ""),
        preset=req.length,
        words=(req.words or None) if req.words > 0 else None,
        limit_sections=int(req.limit_sections),
        temp_sections=float(req.temp),
        top_p_sections=float(req.top_p),
        title_style=req.title_style,
        title_max_words=int(req.title_max_words),
    )

# ========= Routes =========
@app.get("/health")
def health():
    return {"ok": True}

@app.post("/api/explain", response_model=ExplainResponse)
async def explain_endpoint(
    persona: str = Form(...),
    file: UploadFile = File(...),
    length: str = Form("medium"),
    limit_sections: int = Form(5),
    temp: float = Form(0.0),
    top_p: float = Form(0.9),
    title_style: str = Form("canonical"),
    title_max_words: int = Form(0),
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
            "preset": lp["preset"],
            "temperature": float(temp),
            "top_p": float(top_p),
            "max_new_tokens": lp["max_new_tokens"],
            "min_new_tokens": lp["min_new_tokens"],
            "target_words": lp["target_words"],
            # === NEW: retrieval ===
            "retriever": RETRIEVAL_DEFAULTS["retriever"],
            "retriever_model": RETRIEVAL_DEFAULTS["retriever_model"],
            "k": RETRIEVAL_DEFAULTS["k"],
            "max_ctx_chars": RETRIEVAL_DEFAULTS["max_ctx_chars"],
            "seg_words": RETRIEVAL_DEFAULTS["seg_words"],
            "overlap_words": RETRIEVAL_DEFAULTS["overlap_words"],
        }
    }

    data = _gpu("/api/two_stage_story", payload, timeout=1800)
    sections = data.get("sections", [])
    outline = data.get("outline", [])

    story_title = (
        data.get("title")
        or (sections and isinstance(sections[0], dict) and sections[0].get("title"))
        or data.get("paper_title")
        or file.filename
        or "Story"
    )

    print(story_title)
        
    return {
        "persona": persona,
        "title": story_title,
        "docTitle": data.get("paper_title") or file.filename,
        "sections": sections,
        "meta": {
            "paperText": text,
            "lengthPreset": lp["preset"],
            "creativity": int(float(temp) * 100),
            "outline": outline,
            "storytellerParams": {
                "preset": lp["preset"],
                "temperature": float(temp),
                "top_p": float(top_p),
                "max_new_tokens": lp["max_new_tokens"],
                "min_new_tokens": lp["min_new_tokens"],
                "target_words": lp["target_words"],
                "retriever": RETRIEVAL_DEFAULTS["retriever"],
                "retriever_model": RETRIEVAL_DEFAULTS["retriever_model"],
                "k": RETRIEVAL_DEFAULTS["k"],
                "max_ctx_chars": RETRIEVAL_DEFAULTS["max_ctx_chars"],
                "seg_words": RETRIEVAL_DEFAULTS["seg_words"],
                "overlap_words": RETRIEVAL_DEFAULTS["overlap_words"],
            },
            "splitterParams": {
                "max_new_tokens": 768,
                "temperature": split_temp,
            }
        }

    }

@app.post("/api/generate_from_text")
def generate_from_text(req: GenerateFromTextRequest):
    # Usa lo stesso flusso a 2 stadi, passando il testo come "markdown"
    if not REMOTE_GPU_URL:
        raise HTTPException(503, "GPU remoto non configurato (REMOTE_GPU_URL).")

    lp = resolve_length_params(
        getattr(req, "length_preset", None) or req.length or "medium",
        getattr(req, "words", None),
    )
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
    return {
        "persona": data.get("persona", req.persona),
        "title": data.get("title"),
        "docTitle": data.get("paper_title", req.title or "Paper"),
        "sections": data.get("sections", [])
    }

@app.post("/api/regen")
def regen_sections(req: RegenRequest):
    if story_ops is None:
        raise HTTPException(503, "Inferenza locale disabilitata: usare REMOTE_GPU_URL")
    new_story, _alts = story_ops.regen_sections(
        req.text, req.persona,
        story_json=req.story.model_dump(),
        sections_to_regen=req.sections,
        preset=req.length,
        words=(req.words or None) if req.words > 0 else None,
        alts=max(1, req.alts),
        temperature=float(req.temp),
        top_p=float(req.top_p),
    )
    return {"sections": new_story.get("sections", [])}

@app.post("/api/para")
def paraphrase(req: ParaRequest):
    if story_ops is None:
        raise HTTPException(503, "Inferenza locale disabilitata: usare REMOTE_GPU_URL")
    outs = story_ops.paraphrase(
        paragraph=req.text,
        persona=req.persona,
        target_words=max(50, min(300, int(req.words or 150))),
        alts=max(1, int(req.alts or 1)),
        temperature=float(req.temp or 0.7),
        top_p=float(req.top_p or 0.9),
    )
    return outs

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

@app.post("/api/regen_vm")
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
        "sections": data.get("sections", []),
        "outline": data.get("outline", []),
        "meta": data.get("meta", {}),
    }
