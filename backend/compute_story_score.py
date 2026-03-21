# backend/compute_story_score.py
import sys
import json
import re
import unicodedata
from collections import Counter
from typing import List, Dict, Any

import spacy
import torch
import bert_score


# ------------------------
# SpaCy NER
# ------------------------
try:
    NER = spacy.load("en_core_web_sm")
except OSError:
    raise RuntimeError(
        "SpaCy model en_core_web_sm not installed. "
        "Run: python -m spacy download en_core_web_sm"
    )


# -------------------------------------------------------------
# UTILS BASE
# -------------------------------------------------------------
def normalize_text(t: str) -> str:
    """Simple normalization: lowercase + compressed spaces."""
    return re.sub(r"\s+", " ", str(t or "").strip().lower())


STOP = set("""
a an the and or of in to for with by on at from as that this these those it its their our your his her we you i he she they them is are was were be been being have has had do does did can could should would will may might must not no yes into about over under without within across per among between more most less least each other such than up down out if then else when while because during before after above below same different also however therefore
""".split())


def tokenize_simple(text: str) -> List[str]:
    text = unicodedata.normalize("NFKC", str(text or "").lower())
    text = re.sub(r"[^a-z0-9\s]", " ", text)
    return [t for t in text.split() if t and t not in STOP]


# -------------------------------------------------------------
# CONTEXT RECALL
# -------------------------------------------------------------
def paper_centered_recall(story_tokens: List[str], paper_tokens: List[str]) -> float:
    """
    ContextRecall = |N_story ∩ N_paper| / |N_paper|
    Paper-centered coverage.
    """
    story_set = set(story_tokens)
    paper_set = set(paper_tokens)
    return (len(story_set & paper_set) / len(paper_set)) if paper_set else 0.0


def compute_context_recall(story_text: str, paper_text: str) -> float:
    s_tokens = tokenize_simple(story_text or "")
    p_tokens = tokenize_simple(paper_text or "")
    return paper_centered_recall(s_tokens, p_tokens)


# -------------------------------------------------------------
# NO REDUNDANCY
# -------------------------------------------------------------
def redundancy_rate(text: str, n: int = 3) -> float:
    """
    RedundancyRate = max_g freq(g) / |G_n|
    """
    toks = tokenize_simple(text)
    if len(toks) < n:
        return 0.0

    grams = [tuple(toks[i : i + n]) for i in range(len(toks) - n + 1)]
    if not grams:
        return 0.0

    max_freq = Counter(grams).most_common(1)[0][1]
    return float(max_freq / len(grams))


def compute_noredundancy(story_text: str, n: int = 3) -> float:
    rep = redundancy_rate(story_text or "", n=n)
    return float(max(0.0, min(1.0, 1.0 - rep)))


# -------------------------------------------------------------
# TITLE COVERAGE
# -------------------------------------------------------------
def _extract_title(sec: Any) -> str:
    if isinstance(sec, dict):
        return str(sec.get("title") or "")
    return str(sec or "")


def _normalize_title_for_match(title: str) -> str:
    """
    Normalize title by removing differences in case, punctuation, and spacing.
    """
    s = unicodedata.normalize("NFKC", str(title or "").lower())
    s = re.sub(r"[^\w\s]", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def compute_title_coverage(outline: List[Any], sections: List[Any]) -> float:
    """
    TitleCoverage = 1 if all normalized generated titles exactly match
    the normalized outline titles, 0 otherwise.
    """
    if not outline and not sections:
        return 1.0

    if len(outline) != len(sections):
        return 0.0

    for in_sec, out_sec in zip(outline, sections):
        t_in = _normalize_title_for_match(_extract_title(in_sec))
        t_out = _normalize_title_for_match(_extract_title(out_sec))
        if t_in != t_out:
            return 0.0

    return 1.0


# -------------------------------------------------------------
# PROMPT CLEANLINESS
# -------------------------------------------------------------
def _split_sentences_light(text: str) -> List[str]:
    parts = re.split(r"(?<=[.!?])\s+|\n+", str(text or ""))
    return [p.strip() for p in parts if p and p.strip()]


def _compute_prompt_contamination_stats(text: str) -> Dict[str, float]:
    """
    Structural contamination detector for PromptCleanliness.

    T = (1.0*Vline + 0.75*Vsent + 1.25*Vjson + 0.75*Vfence + 2.5*Vblock) / |U|
    where U is the number of non-empty lines.
    """
    raw = str(text or "")
    nonempty_lines = [ln.strip() for ln in raw.splitlines() if ln.strip()]
    U = max(1, len(nonempty_lines))

    line_marker_re = re.compile(
        r"(?i)^\s*(?:human|assistant|user|system|rules?|instruction|instructions|task|prompt)\s*:"
    )
    json_line_re = re.compile(r'^\s*(?:\{.*\}|\[.*\])\s*$')
    fence_re = re.compile(r"(?m)^\s*(?:```|~~~)")

    imperative_res = [
        re.compile(
            r"(?i)^(?:please\s+)?(?:do not|don't|never|avoid|must(?:\s+not)?|should(?:\s+not)?|return|output|respond|write|provide|include|use|follow|answer|explain|rewrite|summarize)\b"
        ),
        re.compile(r"(?i)^(?:be sure to|make sure to)\b"),
    ]
    dense_constraint_re = re.compile(r"(?i)\b(?:do not|don't|never|must not|should not|avoid)\b")

    vline = sum(1 for ln in nonempty_lines if line_marker_re.search(ln))
    vjson = sum(1 for ln in nonempty_lines if json_line_re.search(ln))
    vfence = len(fence_re.findall(raw))

    sentences = _split_sentences_light(raw)
    vsent = 0
    for sent in sentences:
        if any(rx.search(sent) for rx in imperative_res):
            vsent += 1

    blocks = [b.strip() for b in re.split(r"\n\s*\n", raw) if b.strip()]
    if not blocks:
        blocks = sentences

    vblock = 0
    for block in blocks:
        if len(dense_constraint_re.findall(block)) >= 3:
            vblock += 1

    T = (
        1.0 * vline
        + 0.75 * vsent
        + 1.25 * vjson
        + 0.75 * vfence
        + 2.5 * vblock
    ) / U

    T = float(max(0.0, min(1.0, T)))

    return {
        "T": T,
        "vline": float(vline),
        "vsent": float(vsent),
        "vjson": float(vjson),
        "vfence": float(vfence),
        "vblock": float(vblock),
        "nonempty_lines": float(U),
    }


def compute_prompt_cleanliness(story_text: str) -> float:
    stats = _compute_prompt_contamination_stats(story_text or "")
    return float(max(0.0, min(1.0, 1.0 - stats["T"])))


# -------------------------------------------------------------
# BERTScore
# -------------------------------------------------------------
def compute_bertscore(story_text: str, paper_text: str) -> float:
    story_text = (story_text or "").strip()
    paper_text = (paper_text or "").strip()

    if not story_text or not paper_text:
        return 0.0

    try:
        _, _, F = bert_score.score(
            [story_text],
            [paper_text],
            model_type="roberta-large",
            lang="en",
            verbose=False,
            device="cuda" if torch.cuda.is_available() else "cpu",
        )
        return float(F[0].item())
    except Exception:
        return 0.0


# -------------------------------------------------------------
# NO HALLUCINATION
# -------------------------------------------------------------
def compute_nohallucination(story_text: str, paper_text: str) -> float:
    """
    Extract PERSON/ORG entities from story and paper.
    NoHall = 1 - (#hallucinated / #story_ents)
    """
    story = str(story_text or "")
    paper = str(paper_text or "")

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
# STORYSCORE
# -------------------------------------------------------------
def compute_storyscore(
    ctx_recall: float,
    bert: float,
    prompt_cleanliness: float,
    title_cov: float,
    nored: float,
    nohall: float,
) -> float:
    """
    StoryScore =
        0.30 * ContextRecall
      + 0.20 * BERTScore
      + 0.20 * PromptCleanliness
      + 0.10 * TitleCoverage
      + 0.10 * NoRedundancy
      + 0.10 * NoHallucination
    """
    return (
        0.30 * ctx_recall
        + 0.20 * bert
        + 0.20 * prompt_cleanliness
        + 0.10 * title_cov
        + 0.10 * nored
        + 0.10 * nohall
    )


# -------------------------------------------------------------
# MAIN ENTRYPOINT
# -------------------------------------------------------------
def compute_story_score(payload: Dict[str, Any]) -> Dict[str, float]:
    """
    Calculate metrics and StoryScore based on the payload:
    {
      "outline": ...,
      "sections": ...,
      "persona": ...,
      "paper_title": ...,
      "paper_markdown": ...
    }
    """
    outline = payload.get("outline") or []
    sections_raw = payload.get("sections") or []
    paper_md_raw = payload.get("paper_markdown", "") or ""

    # --- collect section texts ---
    sections_text_raw: List[str] = []

    for s in sections_raw:
        if isinstance(s, dict):
            t = s.get("narrative") or s.get("text") or ""
        else:
            t = str(s or "")

        if normalize_text(t).strip():
            sections_text_raw.append(str(t))

    story_text_raw = "\n".join(sections_text_raw)
    paper_text_raw = str(paper_md_raw)

    # --- metrics ---
    ctx_recall = compute_context_recall(story_text_raw, paper_text_raw)
    bert = compute_bertscore(story_text_raw, paper_text_raw)

    prompt_stats = _compute_prompt_contamination_stats(story_text_raw)
    prompt_cleanliness = compute_prompt_cleanliness(story_text_raw)

    title_cov = compute_title_coverage(outline, sections_raw)
    nored = compute_noredundancy(story_text_raw, n=3)
    nohall = compute_nohallucination(story_text_raw, paper_text_raw)

    storyscore = compute_storyscore(
        ctx_recall=ctx_recall,
        bert=bert,
        prompt_cleanliness=prompt_cleanliness,
        title_cov=title_cov,
        nored=nored,
        nohall=nohall,
    )

    return {
        "context_recall": float(ctx_recall),
        "ctx_recall": float(ctx_recall),              # backward compatibility
        "lexical_recall": float(ctx_recall),          # backward compatibility

        "bertscore": float(bert),

        "prompt_cleanliness": float(prompt_cleanliness),
        "prompt_contamination": float(prompt_stats["T"]),

        "title_coverage": float(title_cov),
        "title_cov": float(title_cov),                # backward compatibility

        "nored": float(nored),
        "noloop": float(nored),                       # backward compatibility

        "nohall": float(nohall),
        "storyscore": float(storyscore),
    }


# -------------------------------------------------------------
# CLI USAGE
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
