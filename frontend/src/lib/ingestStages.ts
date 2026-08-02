/**
 * Ingestion stage labels for the document upload pipeline.
 *
 * The backend walks a document through:
 *   queued -> PARSING -> EXTRACTING -> GRAPH_BUILDING -> INDEXING -> indexed
 * (or -> error). Entity extraction is LLM-bound and can run for minutes, so
 * the UI must show which stage is running — otherwise a working upload is
 * indistinguishable from a hung page.
 *
 * This lives outside the page component so it can be unit-tested; the status
 * vocabulary here has to stay in sync with `update_doc_status` in Backend/app.py.
 */

export const INGEST_STAGES: Record<string, { label: string; step: number }> = {
    queued: { label: "Queued for processing", step: 1 },
    parsing: { label: "Parsing document", step: 2 },
    extracting: { label: "Generating embeddings", step: 3 },
    graph_building: { label: "Building knowledge graph", step: 4 },
    indexing: { label: "Finalizing index", step: 5 },
    processing: { label: "Processing", step: 2 },
};

export const TOTAL_INGEST_STEPS = 5;

/**
 * Returns stage info while a document is still being ingested, or null once it
 * has reached a terminal state (`indexed` / `error`).
 *
 * Unknown non-terminal statuses fall back to a generic "Processing" stage
 * rather than returning null — a new backend stage should degrade to a spinner,
 * never to a silently blank row (which is the bug this replaced).
 */
export function getIngestStage(
    status: string | undefined | null,
): { label: string; step: number } | null {
    const key = String(status ?? "").trim().toLowerCase();
    if (!key || key === "indexed" || key === "error") return null;
    return INGEST_STAGES[key] ?? { label: "Processing", step: 2 };
}
