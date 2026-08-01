"""End-to-end API smoke test for the Valar backend.

Runs against a throwaway SQLite database and stubs the LLM/vector layer, so it
exercises routing, authorization, the citation pipeline, conversation memory,
feedback and the audit log without spending API credits.

Run from the Backend directory:

    ./venv/Scripts/python.exe test_api.py       # Windows
    python test_api.py                          # Linux/macOS

Exits non-zero if any check fails.
"""
import os
import sys
import tempfile

BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))

os.environ["SECRET_KEY"] = "test-secret-key-for-smoke-test"
os.environ["ADMIN_SETUP_TOKEN"] = "bootstrap-me"
tmpdb = os.path.join(tempfile.mkdtemp(), "smoke.db")
os.environ["DATABASE_URL"] = f"sqlite:///{tmpdb}"

sys.path.insert(0, BACKEND_DIR)
os.chdir(BACKEND_DIR)

import rag_pipeline
from rag_pipeline import RagResult, Citation

# --- stub out the model + vector calls -------------------------------------
CALLS = {}

def fake_rag_answer(question, db=None, history=None):
    CALLS["history"] = history
    CALLS["question"] = question
    return RagResult(
        answer="Purge the line before opening [1]. Torque to 40 Nm [2].",
        citations=[
            Citation(index=1, document="SOP-Pump.pdf", page=3, snippet="Purge the line…", score=0.82, doc_id=1),
            Citation(index=2, document="OEM-Manual.pdf", page=11, snippet="Torque spec…", score=0.71, doc_id=2),
        ],
        confidence=0.79,
        source_type="documents",
    )

FOLLOWUP_CALLS = []

def fake_generate_follow_ups(question, answer, citations=None):
    FOLLOWUP_CALLS.append((question, answer, citations))
    return ["What is the vibration limit for P-101A?", "How long must the line be purged?"]

import app as app_module
app_module.rag_answer = fake_rag_answer
app_module.generate_follow_ups = fake_generate_follow_ups

from fastapi.testclient import TestClient
client = TestClient(app_module.app)

failures = []

def check(label, cond, extra=""):
    if cond:
        print(f"  PASS  {label}")
    else:
        print(f"  FAIL  {label} {extra}")
        failures.append(label)

print("\n== auth ==")
r = client.post("/register", json={"username": "tech1", "password": "pw123456"})
check("register technician", r.status_code == 201, r.text)

r = client.post("/register_admin", json={"username": "evil", "password": "pw", "role": "manager"})
check("register_admin rejected without setup token", r.status_code == 403, r.text)

r = client.post("/register_admin", json={"username": "boss", "password": "pw123456", "setup_token": "bootstrap-me"})
check("register_admin accepted with setup token", r.status_code == 201, r.text)

r = client.post("/register_admin", json={"username": "boss2", "password": "pw", "setup_token": "bootstrap-me"})
check("register_admin blocked once a manager exists", r.status_code == 403, r.text)

tech = client.post("/token", data={"username": "tech1", "password": "pw123456"}).json()["access_token"]
boss = client.post("/token", data={"username": "boss", "password": "pw123456"}).json()["access_token"]
TH = {"Authorization": f"Bearer {tech}"}
BH = {"Authorization": f"Bearer {boss}"}
check("technician token issued", bool(tech))
check("manager token issued", bool(boss))

print("\n== authorization ==")
check("technician blocked from /files", client.get("/files", headers=TH).status_code == 403)
check("manager allowed on /files", client.get("/files", headers=BH).status_code == 200)
check("anonymous blocked from /sessions", client.get("/sessions").status_code == 401)

print("\n== path traversal ==")
r = client.delete("/files/..%2F..%2Fapp.py", headers=BH)
check("traversal delete does not touch app.py", os.path.exists("app.py"))
check("traversal delete rejected (404/400)", r.status_code in (400, 404), r.text)

print("\n== chat + citations ==")
sid = client.post("/sessions", headers=TH).json()["id"]
r = client.post(f"/sessions/{sid}/ask", headers=TH, json={"question": "How do I service pump P-101A?"})
body = r.json()
check("ask returns 200", r.status_code == 200, r.text)
check("answer present", bool(body.get("answer")))
check("citations returned", len(body.get("citations", [])) == 2, str(body.get("citations")))
check("citation carries page", body["citations"][0].get("page") == 3)
check("citation carries document name", body["citations"][0].get("document") == "SOP-Pump.pdf")
check("confidence returned", body.get("confidence") == 0.79, str(body.get("confidence")))
check("source_type returned", body.get("source_type") == "documents")
check("message_id returned", isinstance(body.get("message_id"), int))
check("first turn has empty history", CALLS["history"] == [])

print("\n== conversation memory ==")
client.post(f"/sessions/{sid}/ask", headers=TH, json={"question": "What about the other one?"})
hist = CALLS["history"]
check("second turn receives prior turns", len(hist) == 2, str(hist))
check("history includes prior user question", hist[0]["role"] == "user" and "P-101A" in hist[0]["content"])
check("history includes prior answer", hist[1]["role"] == "assistant")

print("\n== citation persistence ==")
msgs = client.get(f"/sessions/{sid}/messages", headers=TH).json()
asst = [m for m in msgs if m["role"] == "assistant"]
check("citations survive a reload", len(asst[0]["citations"]) == 2, str(asst[0]))
check("confidence survives a reload", asst[0]["confidence"] == 0.79)

print("\n== follow-ups ==")
mid_first = body["message_id"]
r = client.get(f"/messages/{mid_first}/followups", headers=TH)
check("follow-ups generated", r.status_code == 200 and len(r.json()["follow_ups"]) == 2, r.text)
check("generator saw the originating question",
      FOLLOWUP_CALLS and "P-101A" in FOLLOWUP_CALLS[0][0], str(FOLLOWUP_CALLS[:1]))
check("generator saw the answer's citations",
      FOLLOWUP_CALLS and len(FOLLOWUP_CALLS[0][2]) == 2, str(FOLLOWUP_CALLS[:1]))

calls_before = len(FOLLOWUP_CALLS)
r2 = client.get(f"/messages/{mid_first}/followups", headers=TH)
check("second request served from cache", len(FOLLOWUP_CALLS) == calls_before)
check("cached payload matches", r2.json()["follow_ups"] == r.json()["follow_ups"])

check("follow-ups on a user message return empty",
      client.get("/messages/1/followups", headers=TH).json()["follow_ups"] == [])

print("\n== feedback ==")
mid = body["message_id"]
r = client.post(f"/messages/{mid}/feedback", headers=TH, json={"rating": "helpful"})
check("feedback recorded", r.status_code == 201, r.text)
r = client.post(f"/messages/{mid}/feedback", headers=TH, json={"rating": "not_helpful", "comment": "wrong torque"})
check("feedback updated not duplicated", r.status_code == 201, r.text)
r = client.post(f"/messages/{mid}/feedback", headers=TH, json={"rating": "bogus"})
check("invalid rating rejected", r.status_code == 400)

other = client.post("/register", json={"username": "tech2", "password": "pw123456"})
t2 = client.post("/token", data={"username": "tech2", "password": "pw123456"}).json()["access_token"]
r = client.post(f"/messages/{mid}/feedback", headers={"Authorization": f"Bearer {t2}"}, json={"rating": "helpful"})
check("cannot rate another user's message", r.status_code == 404, r.text)

fb = client.get("/analytics/feedback", headers=BH).json()
check("feedback analytics aggregates", fb["not_helpful"] == 1 and fb["helpful"] == 0, str(fb))
check("avg confidence computed", fb["avg_confidence"] is not None, str(fb))

print("\n== audit log ==")
audit = client.get("/analytics/audit", headers=BH).json()
actions = [a["action"] for a in audit]
check("queries audited", actions.count("query") == 2, str(actions))
check("feedback audited", "feedback" in actions, str(actions))
check("audit records confidence", any(a["confidence"] == 0.79 for a in audit))
check("technician cannot read audit", client.get("/analytics/audit", headers=TH).status_code == 403)

print("\n== upload validation ==")
r = client.post("/upload", headers=BH, files={"file": ("evil.exe", b"MZ", "application/octet-stream")})
check("unsupported extension rejected", r.status_code == 400, r.text)
r = client.post("/upload", headers=BH, files={"file": ("old.doc", b"x", "application/msword")})
check("legacy .doc rejected with guidance", r.status_code == 400 and ".docx" in r.json()["detail"])

print("\n" + "=" * 60)
if failures:
    print(f"{len(failures)} FAILURE(S): {failures}")
    sys.exit(1)
print("ALL SMOKE TESTS PASSED")
