"""Pure, dependency-free metric functions for the Kairo evaluation harness.

These implement the four judged deliverables:

    1. Retrieval Precision       -> precision_at_k
    2. Entity Extraction F1      -> entity_prf
    3. Hallucination Containment -> containment_rate
    4. Citation Traceability     -> traceability_rate

They take *already-computed* inputs (no pipeline, no network), so they are fast,
deterministic, and unit-testable in isolation. `evaluate.py` calls the live
pipeline to produce those inputs and then feeds them here.
"""

from __future__ import annotations

import re


def _norm(s: str) -> str:
    """Normalize an entity/string for comparison: lowercase, collapse spaces,
    strip surrounding punctuation."""
    s = (s or "").lower().strip()
    s = re.sub(r"[\s_]+", " ", s)
    s = s.strip(" .,:;\"'()[]{}")
    return s


# =========================================================
# 1. RETRIEVAL PRECISION
# =========================================================

def precision_at_k(retrieved: list[dict], relevant_doc_ids: list, relevant_substrings: list[str], k: int | None = None) -> float:
    """Precision@k for one query.

    `retrieved` is a list of citation-like dicts, each with optional 'doc_id'
    and 'snippet'. A retrieved item is relevant if its doc_id is in
    `relevant_doc_ids` OR its snippet contains any of `relevant_substrings`.
    """
    if not retrieved:
        return 0.0
    items = retrieved[:k] if k else retrieved
    rel_ids = {str(x) for x in (relevant_doc_ids or [])}
    subs = [s.lower() for s in (relevant_substrings or []) if s]
    hits = 0
    for it in items:
        doc_id = str(it.get("doc_id")) if it.get("doc_id") is not None else None
        snippet = (it.get("snippet") or "").lower()
        if (doc_id is not None and doc_id in rel_ids) or any(sub in snippet for sub in subs):
            hits += 1
    denom = k if k else len(items)
    return round(hits / denom, 4) if denom else 0.0


def macro_average(values: list[float]) -> float:
    return round(sum(values) / len(values), 4) if values else 0.0


# =========================================================
# 2. ENTITY EXTRACTION F1
# =========================================================

def entity_prf(predicted: list[str], gold: list[str]) -> tuple[int, int, int]:
    """Return (true_positives, num_predicted, num_gold) for one chunk, using
    normalized set matching. Aggregate these across chunks for a micro-F1."""
    pred = {_norm(p) for p in predicted if _norm(p)}
    gold_set = {_norm(g) for g in gold if _norm(g)}
    tp = len(pred & gold_set)
    return tp, len(pred), len(gold_set)


def prf_from_counts(tp: int, n_pred: int, n_gold: int) -> dict:
    precision = tp / n_pred if n_pred else 0.0
    recall = tp / n_gold if n_gold else 0.0
    f1 = (2 * precision * recall / (precision + recall)) if (precision + recall) else 0.0
    return {"precision": round(precision, 4), "recall": round(recall, 4), "f1": round(f1, 4),
            "tp": tp, "predicted": n_pred, "gold": n_gold}


# =========================================================
# 3. HALLUCINATION CONTAINMENT
# =========================================================

def is_refusal(answer: str, fallback_triggers: list[str]) -> bool:
    low = (answer or "").lower()
    return any(t in low for t in fallback_triggers) or "no supporting evidence" in low


def answerable_contained(grounding_score: float, removed_count: int, refused: bool,
                         min_grounding: float = 0.6) -> bool:
    """An answerable question is 'contained' (hallucination-free) if the system
    produced a grounded answer: not a refusal, no stripped fabrications, and a
    grounding score at or above threshold."""
    return (not refused) and removed_count == 0 and grounding_score >= min_grounding


def unanswerable_contained(refused: bool, grounding_score: float, removed_count: int) -> bool:
    """An unanswerable question is 'contained' if the system refused rather than
    fabricating, or if the grounding gate stripped the fabrication down to a
    grounded/empty result."""
    return refused or removed_count > 0


def containment_rate(results: list[bool]) -> float:
    """Fraction of cases in which the system avoided hallucinating."""
    return round(sum(1 for r in results if r) / len(results), 4) if results else 0.0


# =========================================================
# 4. CITATION TRACEABILITY
# =========================================================

def traceability_for_answer(sentence_report: list[dict], valid_citation_indices: set[int]) -> tuple[int, int]:
    """Return (traceable_factual, total_factual) for one answer.

    `sentence_report` is the per-sentence list from assess_grounding(); a
    'factual' sentence is one with status in {supported, partial, unsupported}
    (i.e. not meta/greeting). It is 'traceable' if it carries a citation marker
    [n] whose n resolves to a real returned citation.
    """
    factual = 0
    traceable = 0
    factual_statuses = {"supported", "partial", "unsupported"}
    for s in sentence_report:
        if s.get("status") not in factual_statuses:
            continue
        factual += 1
        markers = {int(n) for n in re.findall(r"\[(\d{1,2})\]", s.get("sentence", ""))}
        if markers and markers & valid_citation_indices:
            traceable += 1
    return traceable, factual


def traceability_rate(pairs: list[tuple[int, int]]) -> float:
    """Micro-average traceability across answers: sum traceable / sum factual."""
    tt = sum(t for t, _ in pairs)
    tf = sum(f for _, f in pairs)
    return round(tt / tf, 4) if tf else 0.0
