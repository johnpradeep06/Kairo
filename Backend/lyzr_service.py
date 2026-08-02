"""
lyzr_service.py
===============
Lyzr Studio (https://studio.lyzr.ai) integration — an INDEPENDENT second-opinion
verifier for Kairo's Graph RAG answers.

Kairo answers a compliance question from its own knowledge graph. This module
ships that answer, plus the exact graph evidence it was built from, to a Lyzr
Studio agent which independently judges whether every claim is actually
supported by that evidence.

Why this and not "another chatbot tab": the problem statement demands *zero
hallucinations* on compliance lookups, and "hallucination containment rate" is
a scored metric. A second, architecturally separate model that only ever sees
(claim, evidence) — never the source documents — is a real adversarial check,
not a rephrasing of the same model's confidence.

Configuration (all via .env; the feature reports itself as unconfigured and
degrades cleanly rather than erroring when these are absent):
    LYZR_API_KEY   - https://studio.lyzr.ai -> API Keys
    LYZR_AGENT_ID  - the agent to call
    LYZR_USER_ID   - account email registered with Lyzr
"""

import os
import re
import json
import uuid
import logging
from typing import Any, Dict, Optional

import requests
from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel

logger = logging.getLogger(__name__)

LYZR_CHAT_URL = "https://agent-prod.studio.lyzr.ai/v3/inference/chat/"

router = APIRouter(prefix="/lyzr", tags=["Lyzr Studio"])


def _config() -> Dict[str, Optional[str]]:
    """Read config at call time (not import time) so a .env edit + reload applies."""
    return {
        "api_key": os.getenv("LYZR_API_KEY"),
        "agent_id": os.getenv("LYZR_AGENT_ID"),
        "user_id": os.getenv("LYZR_USER_ID"),
    }


VERIFIER_PROMPT = """You are an independent compliance answer auditor.

You did NOT write the answer below and you have NO access to the source \
documents. Judge it ONLY against the KNOWLEDGE GRAPH EVIDENCE provided. Any \
claim in the answer that is not directly supported by that evidence is a \
hallucination, no matter how plausible it sounds.

QUESTION:
{question}

ANSWER UNDER REVIEW:
{answer}

KNOWLEDGE GRAPH EVIDENCE (the only ground truth you may use):
{evidence}

Reply with ONLY raw JSON, no markdown fence and no preamble:
{{
  "verdict": "SUPPORTED" | "PARTIALLY_SUPPORTED" | "UNSUPPORTED",
  "hallucination_risk": <integer 0-100, 0 = fully grounded>,
  "unsupported_claims": ["<exact phrase from the answer that evidence does not support>"],
  "reasoning": "<two sentences max>"
}}"""


class VerifyRequest(BaseModel):
    question: str
    answer: str
    graph_context: str = ""


def _parse_verdict(raw: str) -> Dict[str, Any]:
    """Coerce the agent reply into the verdict schema.

    Agents drift: markdown fences, a preamble sentence, or plain prose. Falling
    back to prose keeps the panel useful instead of erroring on a formatting
    slip, but the fallback is flagged so a soft parse is never mistaken for a
    clean SUPPORTED verdict.
    """
    text = (raw or "").strip()

    candidate = text
    fenced = re.search(r"```(?:json)?\s*(\{[\s\S]*?\})\s*```", text, re.IGNORECASE)
    if fenced:
        candidate = fenced.group(1)
    else:
        outer = re.search(r"(\{[\s\S]*\})", text)
        if outer:
            candidate = outer.group(1)

    data: Optional[Dict[str, Any]] = None
    try:
        data = json.loads(candidate)
    except Exception:
        try:
            from json_repair import repair_json
            data = json.loads(repair_json(candidate))
        except Exception:
            data = None

    if not isinstance(data, dict):
        return {
            "verdict": "UNPARSED",
            "hallucination_risk": None,
            "unsupported_claims": [],
            "reasoning": text[:600] or "Agent returned an empty response.",
            "parsed": False,
        }

    verdict = str(data.get("verdict", "UNPARSED")).upper().replace(" ", "_")
    if verdict not in {"SUPPORTED", "PARTIALLY_SUPPORTED", "UNSUPPORTED"}:
        verdict = "UNPARSED"

    risk = data.get("hallucination_risk")
    try:
        risk = max(0, min(100, int(float(risk))))
    except (TypeError, ValueError):
        risk = None

    claims = data.get("unsupported_claims") or []
    if not isinstance(claims, list):
        claims = [str(claims)]

    return {
        "verdict": verdict,
        "hallucination_risk": risk,
        "unsupported_claims": [str(c) for c in claims][:6],
        "reasoning": str(data.get("reasoning", ""))[:600],
        "parsed": True,
    }


@router.get("/status")
def lyzr_status() -> Dict[str, Any]:
    """Report whether the Lyzr verifier is wired up, so the UI can show an
    honest 'not configured' state instead of failing on first click."""
    cfg = _config()
    missing = [k for k, v in cfg.items() if not v]
    return {
        "configured": not missing,
        "missing": missing,
        "agent_id": cfg["agent_id"],
        "provider": "Lyzr Studio",
        "endpoint": LYZR_CHAT_URL,
    }


@router.post("/verify")
def verify_answer(req: VerifyRequest) -> Dict[str, Any]:
    """Have the Lyzr agent independently audit a Kairo answer against graph evidence."""
    cfg = _config()
    missing = [k for k, v in cfg.items() if not v]
    if missing:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"Lyzr verifier not configured. Missing: {', '.join(missing)}",
        )

    evidence = (req.graph_context or "").strip() or "(no graph evidence was retrieved)"
    payload = {
        "user_id": cfg["user_id"],
        "agent_id": cfg["agent_id"],
        "session_id": f"kairo-verify-{uuid.uuid4().hex[:12]}",
        "message": VERIFIER_PROMPT.format(
            question=req.question[:2000],
            answer=req.answer[:4000],
            # Truncated: the graph context can run long and the agent only needs
            # enough evidence to spot an unsupported claim.
            evidence=evidence[:6000],
        ),
    }

    try:
        res = requests.post(
            LYZR_CHAT_URL,
            headers={"x-api-key": cfg["api_key"], "Content-Type": "application/json"},
            json=payload,
            timeout=90,
        )
        res.raise_for_status()
        body = res.json()
    except requests.HTTPError as err:
        detail = err.response.text[:300] if err.response is not None else str(err)
        logger.error("[lyzr] agent call failed: %s", detail)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Lyzr agent returned {err.response.status_code if err.response is not None else '?'}: {detail}",
        )
    except Exception as err:
        logger.error("[lyzr] agent call failed: %s", err)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Could not reach Lyzr agent: {err}",
        )

    raw = body.get("response") if isinstance(body, dict) else None
    if not isinstance(raw, str):
        raw = json.dumps(body)[:1000]

    verdict = _parse_verdict(raw)
    verdict["agent_id"] = cfg["agent_id"]
    verdict["raw"] = raw[:1500]
    return verdict


if __name__ == "__main__":
    # Self-check for the parser — the one piece of real logic here that can
    # silently rot. Runs offline, no API key needed.
    clean = _parse_verdict('{"verdict":"SUPPORTED","hallucination_risk":4,'
                           '"unsupported_claims":[],"reasoning":"All grounded."}')
    assert clean["verdict"] == "SUPPORTED" and clean["hallucination_risk"] == 4
    assert clean["parsed"] is True

    fenced = _parse_verdict('Sure!\n```json\n{"verdict":"unsupported",'
                            '"hallucination_risk":"88","unsupported_claims":"ISO 27001 applies"}\n```')
    assert fenced["verdict"] == "UNSUPPORTED", fenced
    assert fenced["hallucination_risk"] == 88, fenced
    assert fenced["unsupported_claims"] == ["ISO 27001 applies"], fenced

    # Out-of-range risk is clamped, unknown verdict is not silently trusted.
    odd = _parse_verdict('{"verdict":"probably fine","hallucination_risk":420}')
    assert odd["verdict"] == "UNPARSED" and odd["hallucination_risk"] == 100, odd

    prose = _parse_verdict("The answer looks fine to me.")
    assert prose["verdict"] == "UNPARSED" and prose["parsed"] is False, prose

    assert _parse_verdict("")["verdict"] == "UNPARSED"

    print("lyzr_service self-check passed")
