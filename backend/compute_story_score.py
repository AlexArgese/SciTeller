# backend/compute_story_score.py
import sys
import json
import re
import unicodedata
from typing import List, Dict, Any

import spacy
import torch
import bert_score  # 👉 usiamo bert_score, NON 'evaluate'

# ------------------------
# SpaCy NER (come prima)
# ------------------------
try:
    NER = spacy.load("en_core_web_sm")
except OSError:
    raise RuntimeError(
        "SpaCy model en_core_web_sm non installato. "
        "Esegui: python -m spacy download en_core_web_sm"
    )

# -------------------------------------------------------------
# UTILS BASE
# -------------------------------------------------------------
def normalize_text(t: str) -> str:
    """Normalizzazione semplice: lowercase + spazi compressi."""
    return re.sub(r"\s+", " ", t.strip().lower())


# -------------------------------------------------------------
# TOKENIZZAZIONE "RICCA" PER RECALL / LOOP / TITOLI (stile ablation)
# -------------------------------------------------------------

STOP = set("""
a an the and or of in to for with by on at from as that this these those it its their our your his her we you i he she they them is are was were be been being have has had do does did can could should would will may might must not no yes into about over under without within across per among between more most less least each other such than up down out if then else when while because during before after above below same different also however therefore
""".split())


def tokenize_simple(text: str) -> List[str]:
    text = unicodedata.normalize("NFKC", text.lower())
    text = re.sub(r"[^a-z0-9\s]", " ", text)
    return [t for t in text.split() if t and t not in STOP]


def jaccard_recall(story_tokens: List[str], ctx_tokens: List[str]) -> float:
    """
    Recall lessicale: |A ∩ B| / |A|
    dove A = token della storia, B = token del paper.
    """
    A = set(story_tokens)
    B = set(ctx_tokens)
    return (len(A & B) / len(A)) if A else 0.0


def max_ngram_repeat(text: str, n: int = 3) -> float:
    """
    Calcola la ripetizione massima di n-grammi (come in ablation).
    Ritorna un valore in [0,1], dove 1 = n-gram più ripetuto possibile.
    """
    toks = tokenize_simple(text)
    if len(toks) < n:
        return 0.0
    grams = [" ".join(toks[i : i + n]) for i in range(len(toks) - n + 1)]
    if not grams:
        return 0.0
    from collections import Counter

    m = Counter(grams).most_common(1)[0][1]
    return min(1.0, m / max(1, len(grams) // 10))


def _extract_title(sec: Any) -> str:
    """
    Estrae il titolo da una sezione di outline o di storia.
    - Se dict: usa campo 'title'.
    - Altrimenti converte a stringa.
    """
    if isinstance(sec, dict):
        return str(sec.get("title") or "")
    return str(sec or "")


def title_outline_similarity(outline: List[Any], sections: List[Any]) -> float:
    """
    Title match tra outline e sezioni generate, come in ablation:
    sim media Jaccard sulle parole dei titoli (normalizzate).
    """
    sims: List[float] = []
    for in_sec, out_sec in zip(outline, sections):
        t_in = set(tokenize_simple(_extract_title(in_sec)))
        t_out = set(tokenize_simple(_extract_title(out_sec)))
        if not t_in and not t_out:
            sims.append(1.0)
            continue
        if not t_in or not t_out:
            sims.append(0.0)
            continue
        sims.append(len(t_in & t_out) / len(t_in | t_out))
    return sum(sims) / len(sims) if sims else 0.0


# -------------------------------------------------------------
# 3) METRICHE
# -------------------------------------------------------------

# ---------------------
# BERTScore (roberta-large via bert_score)
# ---------------------
def compute_bertscore(story_text: str, paper_text: str) -> float:
    story_text = (story_text or "").strip()
    paper_text = (paper_text or "").strip()
    if not story_text or not paper_text:
        return 0.0

    try:
        P, R, F = bert_score.score(
            [story_text],
            [paper_text],
            model_type="roberta-large",
            lang="en",
            verbose=False,
            device="cuda" if torch.cuda.is_available() else "cpu",
        )
        # F è un tensore di shape [1]
        return float(F[0].item())
    except Exception:
        # fallback neutro in caso di errore
        return 0.0


# ---------------------
# Recall lessicale (Jaccard stile ablation)
# ---------------------
def compute_lexical_recall(story_text: str, paper_text: str) -> float:
    s_tokens = tokenize_simple(story_text or "")
    c_tokens = tokenize_simple(paper_text or "")
    return jaccard_recall(s_tokens, c_tokens)


# ---------------------
# No-loop (no-repetition trigram)
# ---------------------
def compute_noloop(story_text: str) -> float:
    """
    NoRepetition = 1 - max_ngram_repeat(3-grammi)
    """
    rep = max_ngram_repeat(story_text or "", n=3)
    return float(max(0.0, min(1.0, 1.0 - rep)))


# ---------------------
# No-Hallucination (NER PERSON/ORG) - identico a prima
# ---------------------
def compute_nohallucination(sections: List[str], paper: str) -> float:
    """
    Versione originale:
    - Estrae entità PERSON/ORG da storia e paper.
    - Conta quante entità della storia NON compaiono nel paper.
    - NoHall = 1 - (#hallucinated / #story_ents).
    """
    story = "\n".join(sections)
    doc_story = NER(story)
    doc_paper = NER(paper)

    story_ents = set(
        e.text.strip().lower()
        for e in doc_story.ents
        if e.label_ in ("PERSON", "ORG")
    )
    paper_ents = set(
        e.text.strip().lower()
        for e in doc_paper.ents
        if e.label_ in ("PERSON", "ORG")
    )

    if not story_ents:
        return 1.0

    hallucinated = [e for e in story_ents if e not in paper_ents]
    score = 1.0 - (len(hallucinated) / len(story_ents))
    return float(max(0.0, min(1.0, score)))


# -------------------------------------------------------------
# 4) STORYSCORE (nuovi pesi)
# -------------------------------------------------------------
def compute_storyscore(
    bert: float,
    lexrec: float,
    title_match: float,
    noloop: float,
    nohall: float,
) -> float:
    """
    Pesi richiesti:
      0.40 → BERTScore
      0.30 → Recall lessicale
      0.10 → title match
      0.10 → no-repetition
      0.10 → no-hallucination
    """
    return (
        0.40 * bert
        + 0.30 * lexrec
        + 0.10 * title_match
        + 0.10 * noloop
        + 0.10 * nohall
    )


# -------------------------------------------------------------
# 5) MAIN ENTRYPOINT
# -------------------------------------------------------------
def compute_story_score(payload: Dict[str, Any]) -> Dict[str, float]:
    """
    Calcola le metriche e lo StoryScore a partire dal payload
    (outline, sections, persona, paper_title, paper_markdown).
    """
    outline = payload.get("outline") or []
    sections_raw = payload.get("sections") or []
    persona = payload.get("persona", "")
    paper_title = payload.get("paper_title", "")
    paper_md_raw = payload.get("paper_markdown", "") or ""

    # --- testo delle sezioni ---
    sections_text_raw: List[str] = []
    sections_text_norm: List[str] = []

    for s in sections_raw:
        if isinstance(s, dict):
            t = s.get("narrative") or s.get("text") or ""
        else:
            t = str(s or "")
        t_raw = t
        t_norm = normalize_text(t)
        if t_norm.strip():
            sections_text_raw.append(t_raw)
            sections_text_norm.append(t_norm)

    story_text_raw = "\n".join(sections_text_raw)
    paper_text_raw = paper_md_raw
    paper_text_norm = normalize_text(paper_md_raw)

    # --- metriche ---
    bert = compute_bertscore(story_text_raw, paper_text_raw)
    lexrec = compute_lexical_recall(story_text_raw, paper_text_raw)

    # title match tra outline e sezioni (titoli)
    title_match = title_outline_similarity(outline, sections_raw)

    noloop = compute_noloop(story_text_raw)

    # no-hallucination come versione originale (NER PERSON/ORG)
    nohall = compute_nohallucination(sections_text_norm, paper_text_norm)

    # storyscore finale
    storyscore = compute_storyscore(
        bert=bert,
        lexrec=lexrec,
        title_match=title_match,
        noloop=noloop,
        nohall=nohall,
    )

    # Per retrocompatibilità teniamo anche il campo ctx_recall,
    # qui impostato uguale al recall lessicale.
    ctx_recall = lexrec

    return {
        "bertscore": float(bert),
        "lexical_recall": float(lexrec),
        "title_cov": float(title_match),   # stesso nome chiave di prima
        "noloop": float(noloop),
        "ctx_recall": float(ctx_recall),  # per non rompere il frontend
        "nohall": float(nohall),
        "storyscore": float(storyscore),
    }


# -------------------------------------------------------------
# 6) CLI USAGE
# -------------------------------------------------------------
if __name__ == "__main__":
    try:
        raw = sys.stdin.read()
        payload = json.loads(raw)
        out = compute_story_score(payload)
        print(json.dumps(out, indent=2))
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)
