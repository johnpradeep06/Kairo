"""Kairo evaluation harness — computes the four judged deliverables and writes a
report (JSON + Markdown) you can show to judges / users.

    1. Retrieval Precision       (precision@k over labelled query->source pairs)
    2. Entity Extraction F1      (predicted vs gold entities per chunk, micro-F1)
    3. Hallucination Containment (answerable stay grounded; unanswerable refused)
    4. Citation Traceability     (share of factual sentences with a resolvable citation)

Run from the Backend directory (with the venv active and .env configured):

    python -m eval.evaluate                 # uses eval/gold_dataset.json
    python -m eval.evaluate --dataset path  # custom dataset
    python -m eval.evaluate --k 6           # precision@k cutoff

Outputs: eval/last_report.json and eval/last_report.md

It calls the LIVE pipeline (retrieve_context, extract_from_chunk, rag_answer,
assess_grounding), so the numbers reflect the real system on your corpus.
Every call is wrapped so a single failure degrades that item to a 0 rather than
crashing the whole run.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time

# Allow running both as `python -m eval.evaluate` and `python eval/evaluate.py`.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from eval import metrics as M  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_DATASET = os.path.join(HERE, "gold_dataset.json")


# --------------------------------------------------------------------------
# Live-pipeline adapters (imported lazily so metrics.py stays importable
# without the heavy backend deps, e.g. in CI or unit tests).
# --------------------------------------------------------------------------

def _load_pipeline():
    import rag_pipeline as rp
    from graph_builder import extract_from_chunk
    return rp, extract_from_chunk


def eval_retrieval(dataset, k, rp) -> dict:
    per_query = []
    precisions = []
    for item in dataset.get("retrieval", []):
        try:
            _context, citations, _score = rp.retrieve_context(item["query"])
            retrieved = [
                {"doc_id": c.doc_id, "snippet": c.snippet} for c in citations
            ]
            p = M.precision_at_k(retrieved, item.get("relevant_doc_ids", []),
                                 item.get("relevant_substrings", []), k=k)
        except Exception as e:  # noqa: BLE001
            retrieved, p = [], 0.0
            print(f"[retrieval] '{item['query'][:50]}' failed: {e}")
        precisions.append(p)
        per_query.append({"query": item["query"], "precision_at_k": p,
                          "num_retrieved": len(retrieved)})
    return {"metric": "retrieval_precision", "k": k,
            "score": M.macro_average(precisions), "per_query": per_query}


def eval_entities(dataset, extract_from_chunk) -> dict:
    tp = pred = gold = 0
    per_chunk = []
    for item in dataset.get("entities", []):
        try:
            result = extract_from_chunk(
                chunk_text=item["chunk_text"],
                document_id=item.get("document_id", 0),
                chunk_id=item.get("chunk_id", "eval_chunk"),
            )
            predicted_names = [getattr(e, "canonical_name", str(e)) for e in result.entities]
            c_tp, c_pred, c_gold = M.entity_prf(predicted_names, item.get("gold_entities", []))
        except Exception as e:  # noqa: BLE001
            predicted_names, c_tp, c_pred, c_gold = [], 0, 0, len(item.get("gold_entities", []))
            print(f"[entities] chunk {item.get('chunk_id')} failed: {e}")
        tp += c_tp; pred += c_pred; gold += c_gold
        per_chunk.append({"chunk_id": item.get("chunk_id"),
                          "predicted": predicted_names,
                          "gold": item.get("gold_entities", []),
                          **M.prf_from_counts(c_tp, c_pred, c_gold)})
    summary = M.prf_from_counts(tp, pred, gold)
    return {"metric": "entity_extraction_f1", "score": summary["f1"],
            "micro": summary, "per_chunk": per_chunk}


def eval_hallucination(dataset, rp) -> dict:
    section = dataset.get("hallucination", {})
    outcomes = []
    detail = []
    for item in section.get("answerable", []):
        contained, info = _answerable_case(item, rp)
        outcomes.append(contained)
        detail.append({"type": "answerable", "query": item["query"], "contained": contained, **info})
    for item in section.get("unanswerable", []):
        contained, info = _unanswerable_case(item, rp)
        outcomes.append(contained)
        detail.append({"type": "unanswerable", "query": item["query"], "contained": contained, **info})
    return {"metric": "hallucination_containment_rate",
            "score": M.containment_rate(outcomes), "cases": detail}


def _answerable_case(item, rp):
    try:
        res = rp.rag_answer(item["query"])
        answer = res.answer
        _, report = rp.assess_grounding(answer, _answer_context(res), strip=True)
        refused = M.is_refusal(answer, rp._FALLBACK_TRIGGERS)
        gs = report.get("grounding_score", 1.0)
        removed = len(report.get("removed", []))
        contained = M.answerable_contained(gs, removed, refused)
        return contained, {"grounding_score": gs, "removed": removed, "refused": refused}
    except Exception as e:  # noqa: BLE001
        return False, {"error": str(e)}


def _unanswerable_case(item, rp):
    try:
        res = rp.rag_answer(item["query"])
        answer = res.answer
        _, report = rp.assess_grounding(answer, _answer_context(res), strip=True)
        refused = M.is_refusal(answer, rp._FALLBACK_TRIGGERS)
        removed = len(report.get("removed", []))
        contained = M.unanswerable_contained(refused, report.get("grounding_score", 1.0), removed)
        return contained, {"refused": refused, "removed": removed}
    except Exception as e:  # noqa: BLE001
        return False, {"error": str(e)}


def _answer_context(res) -> str:
    """Rebuild a context string from a RagResult's citations for grounding checks."""
    return "\n".join(f"[{c.index}] {c.snippet}" for c in getattr(res, "citations", []) or [])


def eval_citation(dataset, rp) -> dict:
    pairs = []
    detail = []
    for item in dataset.get("citation", []):
        try:
            res = rp.rag_answer(item["query"])
            context = _answer_context(res)
            _, report = rp.assess_grounding(res.answer, context, strip=False)
            valid_idx = {c.index for c in getattr(res, "citations", []) or []}
            traceable, factual = M.traceability_for_answer(report.get("sentences", []), valid_idx)
        except Exception as e:  # noqa: BLE001
            traceable, factual = 0, 0
            print(f"[citation] '{item['query'][:50]}' failed: {e}")
        pairs.append((traceable, factual))
        detail.append({"query": item["query"], "traceable": traceable, "factual": factual})
    return {"metric": "citation_traceability", "score": M.traceability_rate(pairs),
            "per_query": detail}


def _to_markdown(report: dict) -> str:
    s = report["summary"]
    lines = [
        "# Kairo — Evaluation Report",
        "",
        f"_Generated: {report['generated_at']}_",
        "",
        "## Deliverable metrics",
        "",
        "| Metric | Score |",
        "| --- | --- |",
        f"| Retrieval Precision (@{report['retrieval']['k']}) | **{s['retrieval_precision']:.1%}** |",
        f"| Entity Extraction F1 | **{s['entity_extraction_f1']:.1%}** |",
        f"| Hallucination Containment Rate | **{s['hallucination_containment_rate']:.1%}** |",
        f"| Citation Traceability | **{s['citation_traceability']:.1%}** |",
        "",
        f"Dataset: {report['dataset']}  ·  "
        f"{report['counts']['retrieval']} retrieval / "
        f"{report['counts']['entities']} entity / "
        f"{report['counts']['hallucination']} hallucination / "
        f"{report['counts']['citation']} citation items.",
        "",
    ]
    return "\n".join(lines)


def run(dataset_path: str, k: int) -> dict:
    with open(dataset_path, encoding="utf-8") as f:
        dataset = json.load(f)

    rp, extract_from_chunk = _load_pipeline()

    retrieval = eval_retrieval(dataset, k, rp)
    entities = eval_entities(dataset, extract_from_chunk)
    hallucination = eval_hallucination(dataset, rp)
    citation = eval_citation(dataset, rp)

    report = {
        "generated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "dataset": os.path.basename(dataset_path),
        "counts": {
            "retrieval": len(dataset.get("retrieval", [])),
            "entities": len(dataset.get("entities", [])),
            "hallucination": len(dataset.get("hallucination", {}).get("answerable", []))
            + len(dataset.get("hallucination", {}).get("unanswerable", [])),
            "citation": len(dataset.get("citation", [])),
        },
        "summary": {
            "retrieval_precision": retrieval["score"],
            "entity_extraction_f1": entities["score"],
            "hallucination_containment_rate": hallucination["score"],
            "citation_traceability": citation["score"],
        },
        "retrieval": retrieval,
        "entities": entities,
        "hallucination": hallucination,
        "citation": citation,
    }

    with open(os.path.join(HERE, "last_report.json"), "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)
    with open(os.path.join(HERE, "last_report.md"), "w", encoding="utf-8") as f:
        f.write(_to_markdown(report))
    return report


def main():
    ap = argparse.ArgumentParser(description="Kairo evaluation harness")
    ap.add_argument("--dataset", default=DEFAULT_DATASET)
    ap.add_argument("--k", type=int, default=6, help="precision@k cutoff")
    args = ap.parse_args()

    report = run(args.dataset, args.k)
    s = report["summary"]
    print("\n=== Kairo Evaluation ===")
    print(f"Retrieval Precision (@{args.k}):     {s['retrieval_precision']:.1%}")
    print(f"Entity Extraction F1:            {s['entity_extraction_f1']:.1%}")
    print(f"Hallucination Containment Rate:  {s['hallucination_containment_rate']:.1%}")
    print(f"Citation Traceability:           {s['citation_traceability']:.1%}")
    print(f"\nWrote {os.path.join(HERE, 'last_report.json')} and last_report.md")


if __name__ == "__main__":
    main()
