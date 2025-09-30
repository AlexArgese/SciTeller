# story_ops.py — two-pass (segmenta titoli -> scrive ogni sezione)
# Con slider di creatività: --temp e --top_p
# Con guard-rails: niente References/Keywords/Tables, niente citazioni/URL/DOI

import json, re, math, unicodedata, argparse, os
MODEL = os.environ.get(
    "STORY_MODEL_DIR",
    "/Users/alex/Desktop/UNI/EURECOM/Internship/webapp/backend/models/mistral7b_joint_merged_fp16"
)

# forza completamente offline (evita qualsiasi chiamata a HF Hub)
# Evita MPS/accelerate: tieni tutto su CPU
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
os.environ.setdefault("ACCELERATE_DISABLE_DEVICE_MAP", "1")
os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")         # se PyTorch tenta MPS, fai fallback CPU
os.environ.setdefault("PYTORCH_MPS_HIGH_WATERMARK_RATIO", "0.0")  # non pre-allocare memoria MPS


from transformers import AutoTokenizer, AutoModelForCausalLM, AutoConfig
import torch

# Caricamento OFFLINE dal path locale
tok = AutoTokenizer.from_pretrained(MODEL, use_fast=True, local_files_only=True)
cfg = AutoConfig.from_pretrained(MODEL, local_files_only=True)
# Se i pesi sono fp16, su Mac M1/M2 è spesso meglio float16 e device_map="auto"
model = AutoModelForCausalLM.from_pretrained(
    MODEL,
    config=cfg,
    torch_dtype=torch.float32,   # su CPU è più stabile
    device_map={"": "cpu"},      # forza TUTTO su CPU
    low_cpu_mem_usage=True,
    local_files_only=True,
)
model.to("cpu")

SYSTEM = (
  "You are an expert science storyteller. Keep factual fidelity; avoid hallucinations. "
  "Never invent references, URLs, DOIs, or datasets. If a detail is not in the paper, omit it."
)
STOPWORDS = {"the","a","an","of","for","in","on","to","and","or","with","about","into",
             "this","that","these","those","how","why","what","does","do","is","are",
             "from","across","via","by","using","towards","toward"}
# ============== UTIL =================
BAD_HEAD = re.compile(r"\n#{1,6}\s*(references|bibliography|appendix|acknowledg(e)?ments|keywords)\b", re.IGNORECASE)
BAN_SEC  = {"references","reference","bibliography","appendix","supplementary","acknowledgments","acknowledgements","keywords","table","figure"}
CANON    = ["Introduction","Related Work","Methods","Results","Discussion","Conclusion"]

def is_camel_or_acronym(w: str) -> bool:
    return bool(re.match(r"[A-Z]{2,}(-[A-Z]{2,})?$", w)) or bool(re.match(r"[A-Z][a-z]+(?:[A-Z][a-z]+)+", w))

def compact_title(title: str, max_words: int = 6, force_titlecase: bool = True) -> str:
    # prendi la prima clausola utile
    t = re.split(r"[.:;!?—-]\s*", title.strip(), maxsplit=1)[0]
    # togli leading "What is/How does/Why ..." ecc. (case-insensitive)
    _prefix = re.compile(
        r"(?i)^(what\s+is|how\s+does|how\s+do|how\s+it\s+works|why\s+is|why\s+are|overview\s+of|an\s+overview\s+of)\s+"
    )
    t = _prefix.sub("", t).strip()
    # tokenizza “morbido”
    toks = re.findall(r"[A-Za-z0-9+-]+", t)
    out = []
    for w in toks:
        if len(out) >= max_words: break
        # preserva acronimi/CamelCase, altrimenti filtra stopwords comuni
        if is_camel_or_acronym(w) or w.lower() not in STOPWORDS:
            out.append(w)
    if not out:
        out = toks[:max_words]  # fallback
    t2 = " ".join(out)
    if force_titlecase:
        # mantieni acronimi/CamelCase intatti
        words = t2.split()
        tc = []
        for w in words:
            if is_camel_or_acronym(w) or re.match(r"[A-Z][a-z]+(?:[A-Z][a-z]+)+", w):
                tc.append(w)
            else:
                tc.append(w.capitalize())
        t2 = " ".join(tc)
    return t2

def strip_refs(text: str) -> str:
    m = BAD_HEAD.search(text)
    return text[:m.start()] if m else text

def norm(s: str) -> str:
    s = unicodedata.normalize("NFKC", s)
    return re.sub(r"\s+"," ", s.lower()).strip()

def estimate_tokens_from_words(words: int) -> int:
    # ratio conservativa per Mistral: ~1.5 token/parola
    return int(words * 1.5)

def count_words(s: str) -> int:
    return len(re.findall(r"\b\w+\b", s))

def sanitize_narrative(text: str) -> str:
    # taglia blocchi finali tipici
    text = re.sub(r"(?is)\b(keywords?|references?|bibliograph(y|ies)|appendix)\b.*$", "", text).strip()
    lines, out = [], []
    for ln in text.splitlines():
        if re.match(r"^\s*\[\d+\]\s", ln): continue          # [12] ...
        if re.search(r"(?i)\bdoi:|https?://|arxiv\.org", ln): continue
        if re.match(r"(?i)^\s*(table|figure)\s+\d+", ln): continue
        if re.match(r"^\s*\|.*\|\s*$", ln): continue         # righe tabella markdown
        out.append(ln)
    text = "\n".join(out).strip()
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text

def build_lengths(preset:str=None, words:int=None):
    if words:
        tgt_words = int(words); sent_lo, sent_hi = 8, 14
    else:
        preset = preset or "medium"
        presets = {"short":(4,6,180),"medium":(6,9,300),"long":(9,13,450)}
        sent_lo, sent_hi, tgt_words = presets[preset]
    # molto più permissivo: non obblighiamo il modello a riempire
    min_nt = int(0.55 * estimate_tokens_from_words(tgt_words))
    max_nt = min(1400, int(1.4 * estimate_tokens_from_words(tgt_words)))
    return sent_lo, sent_hi, tgt_words, min_nt, max_nt

def apply_chat(msgs):
    return tok.apply_chat_template(msgs, tokenize=False, add_generation_prompt=True)

def generate(prompt: str, max_new_tokens: int, min_new_tokens: int = 0,
             do_sample=False, temperature=0.0, top_p=1.0, num_return_sequences=1,
             repetition_penalty: float = 1.05, no_repeat_ngram_size: int = 6):
    inputs = tok([prompt], return_tensors="pt").to(model.device)
    gen_kwargs = dict(
        max_new_tokens=max_new_tokens,
        pad_token_id=tok.eos_token_id,
        num_return_sequences=num_return_sequences,
        do_sample=do_sample,
        repetition_penalty=repetition_penalty,
        no_repeat_ngram_size=no_repeat_ngram_size,
    )
    if min_new_tokens and min_new_tokens < max_new_tokens:
        gen_kwargs["min_new_tokens"] = min_new_tokens
    if do_sample:
        gen_kwargs["temperature"] = float(max(0.0, temperature))
        gen_kwargs["top_p"] = float(top_p)
    with torch.no_grad():
        out = model.generate(**inputs, **gen_kwargs)
    dec = [tok.decode(seq[inputs["input_ids"].shape[1]:], skip_special_tokens=True).strip()
           for seq in out]
    return dec

def try_parse_json(s: str):
    try:
        o = json.loads(s)
        if isinstance(o, dict) and "sections" in o:
            return o
    except Exception:
        pass
    return None

def salvage_curly_json(s: str):
    if "{" not in s: return None
    st = s.find("{"); depth=0
    for i,ch in enumerate(s[st:], start=st):
        if ch=="{": depth+=1
        elif ch=="}":
            depth-=1
            if depth==0:
                frag = s[st:i+1]
                o = try_parse_json(frag)
                if o is not None: return o
    return None

# ============== SEGMENTAZIONE (titoli solo) =================
def guess_subject(text: str) -> str:
    """Prova a ricavare il 'soggetto' (nome del progetto/tema) in modo generico."""
    # 1) prima heading Markdown
    m = re.search(r"^\s*#\s*(.+)$", text, flags=re.MULTILINE)
    if m:
        return m.group(1).strip()
    # 2) prima sequenza Title Case (2-5 parole)
    m = re.search(r'\b(?:[A-Z][a-z]+(?:[-/][A-Z][a-z]+)?\s+){1,4}[A-Z][a-z]+\b', text)
    if m:
        return m.group(0).strip()
    # 3) fallback
    return "this study"

def extract_markdown_headings(text: str, max_k: int = 10):
    """Prende headings (#, ##), ripulisce e filtra quelle vietate."""
    heads = []
    for m in re.finditer(r"^\s*#{1,6}\s+(.+)$", text, flags=re.MULTILINE):
        t = m.group(1).strip()
        t_norm = norm(t)
        if any(b in t_norm for b in BAN_SEC): 
            continue
        heads.append(t)
        if len(heads) >= max_k:
            break
    return heads

def segment_titles(paper_text: str, limit_sections: int = 6,
                   style: str = "canonical", persona: str = None,
                   max_words: int = 0):
    core = strip_refs(paper_text)
    titles = []

    if style == "paper":
        titles = extract_markdown_headings(core, max_k=limit_sections)
        if not titles:
            style = "didactic"

    if style == "didactic":
        subj = guess_subject(core)
        user = (
            "You will propose section titles to explain the Paper in a didactic, student-friendly way.\n"
            "Return ONLY JSON: {\"sections\":[{\"title\":\"...\"}, ...]}\n"
            f"Max {limit_sections} sections. No References/Appendix/Keywords.\n"
            f"Use question-style or benefit-oriented titles when appropriate.\n"
            f"Subject to explain: {subj}\n\n"
            "Examples of tone (not mandatory):\n"
            "- What is X?\n- Why does X matter?\n- How does X work?\n- Evidence / Results\n- Limitations\n- Where next?\n\n"
            "Paper:\n" + core
        )
        msgs = [{"role":"system","content":SYSTEM},{"role":"user","content":user}]
        gen = generate(apply_chat(msgs), max_new_tokens=220, min_new_tokens=80, do_sample=False)[0]
        obj = try_parse_json(gen) or salvage_curly_json(gen)
        if isinstance(obj, dict) and isinstance(obj.get("sections"), list):
            for s in obj["sections"]:
                t = (s.get("title") or "").strip()
                if t and not any(b in norm(t) for b in BAN_SEC):
                    titles.append(t)
        if not titles:
            titles = [
                f"What is {subj}?",
                f"Why is {subj} important?",
                f"How does {subj} work?",
                "Evidence & Results",
                "Limitations",
                "Implications & Next steps",
            ][:limit_sections]

    if style == "canonical":
        titles = CANON[:limit_sections]

    # dedup in ordine
    seen, dedup = set(), []
    for t in titles:
        k = norm(t)
        if k and k not in seen:
            seen.add(k); dedup.append(t)
    titles = dedup[:limit_sections]

    # compattazione comune
    if max_words and max_words > 0:
        titles = [compact_title(t, max_words=max_words) for t in titles]
        seen, dedup = set(), []
        for t in titles:
            k = norm(t)
            if k and k not in seen:
                seen.add(k); dedup.append(t)
        titles = dedup[:limit_sections]

    return titles

# ============== NARRATIVA PER UNA SEZIONE =================
def write_section_narrative(paper_text: str, persona: str, section_title: str,
                            preset: str = "medium", words: int = None,
                            do_sample: bool = False, temperature: float = 0.0, top_p: float = 1.0,
                            repetition_penalty: float = 1.05, no_repeat_ngram_size: int = 6,
                            enforce_words: bool = False):
    sent_lo, sent_hi, tgt_words, min_nt, max_nt = build_lengths(preset, words)
    user = (
        f"Persona: {persona}\n"
        f"Section: {section_title}\n\n"
        "Write ONLY the narrative for this section (no JSON, no bullets or tables). "
        f"Length: {sent_lo}–{sent_hi} sentences (~{tgt_words} words). "
        "Be faithful to the paper; adapt tone to the Persona; keep it self-contained. "
        "Do NOT include references, citations, keywords, URLs, DOIs, tables, or figures."
        "\n\nPaper:\n" + strip_refs(paper_text)
    )
    msgs = [{"role":"system","content":SYSTEM},{"role":"user","content":user}]
    txt = generate(
        apply_chat(msgs),
        max_new_tokens=max_nt,
        min_new_tokens=min_nt if enforce_words else int(0.4*min_nt),
        do_sample=do_sample, temperature=temperature, top_p=top_p,
        repetition_penalty=repetition_penalty,
        no_repeat_ngram_size=no_repeat_ngram_size,
        num_return_sequences=1
    )[0]
    return sanitize_narrative(txt)

# ============== STORIA COMPLETA (two-pass) =================
def story_full(paper_text: str, persona: str, title: str = "",
               preset: str = "medium", words: int = None,
               limit_sections: int = 6, temp_sections: float = 0.0, top_p_sections: float = 1.0,
               title_style: str = "canonical", title_max_words: int = 0):
    paper_text = strip_refs(paper_text)
    titles = segment_titles(paper_text, limit_sections=limit_sections, style=title_style, persona=persona, max_words=title_max_words)
    sections = []
    do_sample = temp_sections and temp_sections > 0.0
    for t in titles:
        nv = write_section_narrative(
            paper_text, persona, t, preset=preset, words=words,
            do_sample=do_sample, temperature=float(temp_sections), top_p=float(top_p_sections)
        )
        sections.append({"title": t, "narrative": nv})
    return {"persona": persona, "sections": sections}

# ============== RIGENERA SEZIONI =================
def regen_sections(paper_text: str, persona: str, story_json: dict, sections_to_regen: list,
                   preset: str = "long", words: int = None, alts: int = 1,
                   temperature: float = 0.7, top_p: float = 0.9):
    paper_text = strip_refs(paper_text)
    out_story = json.loads(json.dumps(story_json, ensure_ascii=False))
    sec_map = {norm(s["title"]): i for i,s in enumerate(out_story.get("sections", []))}
    results = {}
    for name in sections_to_regen:
        key = norm(name)
        if key not in sec_map:
            out_story.setdefault("sections", []).append({"title": name, "narrative": ""})
            sec_map[key] = len(out_story["sections"])-1
        # genera n alternative
        gens=[]
        for _ in range(max(1, alts)):
            g = write_section_narrative(
                paper_text, persona, name, preset=preset, words=words,
                do_sample=(temperature>0), temperature=temperature, top_p=top_p
            )
            gens.append(g)
        out_story["sections"][sec_map[key]]["narrative"] = gens[0]
        results[name] = gens
    out_story["persona"] = persona
    return out_story, results

# ============== PARAFRASI =================
def paraphrase(paragraph: str, persona: str, target_words: int = 150,
               alts: int = 3, temperature: float = 0.7, top_p: float = 0.9):
    sent_lo, sent_hi, tgt_words, min_nt, max_nt = build_lengths(None, target_words)
    user = (
        f"Persona: {persona}\n"
        "Paraphrase the paragraph preserving meaning and key facts. "
        f"Target length ~{tgt_words} words ({sent_lo}-{sent_hi} sentences). "
        "Improve clarity and flow. Output ONLY the rewritten paragraph. "
        "Do NOT include references, citations, URLs, DOIs, keywords, tables, or figures.\n\n"
        f"Paragraph:\n{paragraph}"
    )
    msgs = [{"role":"system","content":SYSTEM},{"role":"user","content":user}]
    outs = generate(
        apply_chat(msgs),
        max_new_tokens=max_nt, min_new_tokens=int(0.6*min_nt),
        do_sample=(temperature>0), temperature=temperature, top_p=top_p,
        num_return_sequences=max(1, alts)
    )
    return [sanitize_narrative(t) for t in outs]

# ============== CLI =================
if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="mode", required=True)

    # story
    sp = sub.add_parser("story")
    sp.add_argument("--paper", required=True)
    sp.add_argument("--persona", required=True)
    sp.add_argument("--title", default="")
    sp.add_argument("--length", choices=["short","medium","long"], default="medium")
    sp.add_argument("--words", type=int, default=0, help="target parole per SEZIONE (override preset)")
    sp.add_argument("--limit_sections", type=int, default=6)
    sp.add_argument("--temp", type=float, default=0.0, help="creatività per le NARRATIVE (0=deterministico)")
    sp.add_argument("--top_p", type=float, default=0.9)
    sp.add_argument("--out", default="")
    sp.add_argument("--rp", type=float, default=1.05)
    sp.add_argument("--no_repeat", type=int, default=6)
    sp.add_argument("--enforce_words", action="store_true")
    sp.add_argument("--title_style", choices=["canonical","didactic","paper"], default="canonical")
    sp.add_argument("--title_max_words", type=int, default=0, help="se >0 accorcia i titoli a N parole (compattazione smart)")


    # regen
    rg = sub.add_parser("regen")
    rg.add_argument("--paper", required=True)
    rg.add_argument("--persona", required=True)
    rg.add_argument("--in_json", required=True)
    rg.add_argument("--sections", required=True, help="sezioni da rigenerare, separate da ';'")
    rg.add_argument("--length", choices=["short","medium","long"], default="long")
    rg.add_argument("--words", type=int, default=0)
    rg.add_argument("--alts", type=int, default=3)
    rg.add_argument("--temp", type=float, default=0.7)
    rg.add_argument("--top_p", type=float, default=0.9)
    rg.add_argument("--out", default="")
    rg.add_argument("--rp", type=float, default=1.05)
    rg.add_argument("--no_repeat", type=int, default=6)
    rg.add_argument("--enforce_words", action="store_true")

    # para
    pp = sub.add_parser("para")
    pp.add_argument("--persona", required=True)
    pp.add_argument("--text", required=True)
    pp.add_argument("--words", type=int, default=150)
    pp.add_argument("--alts", type=int, default=3)
    pp.add_argument("--temp", type=float, default=0.7)
    pp.add_argument("--top_p", type=float, default=0.9)

    args = ap.parse_args()

    if args.mode == "story":
        txt = open(args.paper, "r", encoding="utf-8").read()
        res = story_full(
            txt, args.persona, args.title,
            preset=args.length, words=(args.words or None),
            limit_sections=args.limit_sections,
            temp_sections=args.temp, top_p_sections=args.top_p,
            title_style=args.title_style,
            title_max_words=args.title_max_words
        )
        out = json.dumps(res, ensure_ascii=False, indent=2)
        print(out)
        if args.out:
            open(args.out, "w", encoding="utf-8").write(out+"\n")

    elif args.mode == "regen":
        txt = open(args.paper, "r", encoding="utf-8").read()
        story = json.load(open(args.in_json, "r", encoding="utf-8"))
        sections = [s.strip() for s in args.sections.split(";") if s.strip()]
        new_story, alts = regen_sections(
            txt, args.persona, story, sections_to_regen=sections,
            preset=args.length, words=(args.words or None),
            alts=args.alts, temperature=args.temp, top_p=args.top_p
        )
        out = json.dumps(new_story, ensure_ascii=False, indent=2)
        print(out)
        if args.out:
            open(args.out, "w", encoding="utf-8").write(out+"\n")
        open((args.out or "alts.json").replace(".json","_alts.json"), "w", encoding="utf-8")\
            .write(json.dumps(alts, ensure_ascii=False, indent=2))

    elif args.mode == "para":
        outs = paraphrase(
            args.text, args.persona, target_words=args.words,
            alts=args.alts, temperature=args.temp, top_p=args.top_p
        )
        print("\n\n".join(f"[ALT {i+1}]\n{t}" for i,t in enumerate(outs)))
