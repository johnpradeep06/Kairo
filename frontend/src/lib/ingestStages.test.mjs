// Run with: node src/lib/ingestStages.test.mjs   (Node 22+ strips TS types)
// Verifies the ingest stage mapping against the exact status strings
// Backend/app.py writes via update_doc_status().
import assert from "node:assert/strict";
import { getIngestStage, TOTAL_INGEST_STEPS } from "./ingestStages.ts";

// Every non-terminal status the backend writes must produce a visible stage.
for (const status of ["queued", "PARSING", "EXTRACTING", "GRAPH_BUILDING", "INDEXING"]) {
    const stage = getIngestStage(status);
    assert.ok(stage, `${status} must render a progress stage, got null`);
    assert.ok(stage.step >= 1 && stage.step <= TOTAL_INGEST_STEPS, `${status} step out of range`);
    assert.ok(stage.label.length > 0, `${status} needs a label`);
}

// Stages must advance monotonically so the progress bar never goes backwards.
const order = ["queued", "PARSING", "EXTRACTING", "GRAPH_BUILDING", "INDEXING"];
const steps = order.map((s) => getIngestStage(s).step);
assert.deepEqual(steps, [...steps].sort((a, b) => a - b), "stages must not regress");
assert.equal(new Set(steps).size, steps.length, "each stage needs a distinct step");
assert.equal(steps.at(-1), TOTAL_INGEST_STEPS, "last stage should reach 100%");

// Terminal states must stop the spinner and the polling loop.
assert.equal(getIngestStage("indexed"), null);
assert.equal(getIngestStage("error"), null);
assert.equal(getIngestStage(""), null);
assert.equal(getIngestStage(undefined), null);
assert.equal(getIngestStage(null), null);

// An unrecognised in-flight stage must still show a spinner, never a blank row.
const unknown = getIngestStage("SOME_FUTURE_STAGE");
assert.ok(unknown && unknown.label === "Processing", "unknown stage must degrade to a spinner");

console.log("ingestStages: all checks passed");
