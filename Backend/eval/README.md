# Kairo Evaluation Harness

Computes the four judged deliverables on **your** corpus and writes a report you
can show judges / users:

| Metric | What it measures |
| --- | --- |
| **Retrieval Precision** (@k) | Share of retrieved chunks that are actually relevant to the query |
| **Entity Extraction F1** | Quality of the extracted entity graph vs. a gold label set |
| **Hallucination Containment Rate** | How reliably the system stays grounded (answerable) and refuses (unanswerable) instead of fabricating |
| **Citation Traceability** | Share of factual sentences that carry a citation resolving to a real source |

## 1. Build the gold set

Edit `gold_dataset.json`. Replace the example items with entries drawn from the
documents you've actually uploaded. `doc_id` values must match `Document.id` in
the database (see the `/files` endpoint or the upload dashboard). 10–30 items per
section is enough for a credible number.

## 2. Run it

From the `Backend/` directory, with the virtualenv active and `.env` configured
(OpenRouter / embeddings / Neo4j as usual):

```bash
python -m eval.evaluate            # uses eval/gold_dataset.json, precision@6
python -m eval.evaluate --k 5      # change the precision@k cutoff
python -m eval.evaluate --dataset path/to/other.json
```

It prints the four scores and writes:

- `eval/last_report.json` — full breakdown (per-query, per-chunk, per-case)
- `eval/last_report.md` — a clean summary table

The harness calls the **live** pipeline (`retrieve_context`,
`extract_from_chunk`, `rag_answer`, `assess_grounding`), so the numbers reflect
the real system. Each item is wrapped so one failure degrades to a 0 rather than
crashing the run.

## 3. Display the metrics in the app

The backend exposes the latest report at `GET /metrics` (auth required):

```json
{ "available": true, "generated_at": "...",
  "summary": { "retrieval_precision": 0.83, "entity_extraction_f1": 0.79,
               "hallucination_containment_rate": 0.97, "citation_traceability": 0.91 } }
```

Fetch this from the frontend and render four metric cards (e.g. on the ops-admin
dashboard). Returns `available: false` until the first run, so the UI can show an
empty state safely.

## 4. Re-index existing documents for semantic chunking

Semantic chunking applies automatically to **new** uploads. Documents indexed
before this change still use the old fixed-size chunks. To re-chunk everything
with the semantic splitter, run once from `Backend/`:

```bash
python -c "from database import SessionLocal; from rag_pipeline import reindex_all_documents; db=SessionLocal(); print(reindex_all_documents(db)); db.close()"
```

This drops and rebuilds the Chroma vectors from the files on disk (the `Document`
rows and source files are the source of truth and are left untouched), so it is
safe to re-run. Do this **before** running the evaluation so retrieval precision
reflects the new chunking.
