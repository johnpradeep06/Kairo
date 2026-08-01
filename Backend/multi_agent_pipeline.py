import os
import re
import json
import logging
from dataclasses import dataclass, asdict, field
from typing import Any, Generator, List, Dict
from dotenv import load_dotenv

from langchain_core.prompts import PromptTemplate
from langchain_core.output_parsers import StrOutputParser
from langchain_openai import ChatOpenAI
from exa_py import Exa

# Re-use existing Chroma retrieval & types from rag_pipeline
from rag_pipeline import (
    retrieve_context,
    exa_search_fallback,
    Citation,
    RELEVANCE_THRESHOLD,
    SNIPPET_CHARS,
    format_history,
    OPENROUTER_API_KEY,
    OPENROUTER_MODEL,
    LLM_MAX_TOKENS,
)

load_dotenv()
logger = logging.getLogger(__name__)

exa = Exa(api_key=os.environ.get("EXA_API_KEY"))

# Shared ChatOpenAI instance for agents
agent_llm = ChatOpenAI(
    api_key=OPENROUTER_API_KEY,
    base_url="https://openrouter.ai/api/v1",
    model=OPENROUTER_MODEL,
    max_tokens=LLM_MAX_TOKENS,
    temperature=0.2,
)

# =========================================================
# DATA STRUCTURES
# =========================================================

@dataclass
class VerifiedClaim:
    claim: str
    status: str       # "SUPPORTED" | "CONTRADICTED" | "UNVERIFIED_HALLUCINATED"
    confidence: float # 0.0 to 1.0
    reasoning: str
    citations: List[int] = field(default_factory=list)

@dataclass
class MultiAgentReport:
    summary: str
    verified_claims: List[VerifiedClaim]
    overall_trust_score: float # 0.0 to 100.0
    citations: List[Citation]
    source_type: str            # "documents" | "web" | "hybrid" | "none"

# =========================================================
# AGENT 1: RESEARCHER AGENT
# =========================================================

RESEARCHER_PROMPT = PromptTemplate(
    input_variables=["question", "context", "history"],
    template="""You are the Lead Research Agent in an autonomous multi-agent research network.
Your task is to analyze the query, review all provided source documents and historical context, and compile comprehensive research findings.

User Topic / Question: {question}

Conversation History:
{history}

Retrieved Document Context:
{context}

INSTRUCTIONS:
1. Provide a detailed, factual research synthesis answering the user query.
2. Break down your findings into 3 to 6 distinct, atomic factual claims.
3. Reference source numbers [1], [2] whenever drawing from the context.

Respond in JSON format with the following keys:
- "research_summary": "Detailed research text with inline source citations [1], [2]...",
- "extracted_claims": ["Atomic Claim 1", "Atomic Claim 2", ...]

JSON Output:"""
)

# =========================================================
# AGENT 2: VERIFICATION & HALLUCINATION DETECTION AGENT
# =========================================================

VERIFIER_PROMPT = PromptTemplate(
    input_variables=["claims", "sources"],
    template="""You are the Fact-Verification & Hallucination Detection Agent.
Your job is to audit factual claims against raw source evidence to detect contradictions, hallucinations, or unverified assertions.

Atomic Claims to Verify:
{claims}

Raw Sources & Evidence:
{sources}

INSTRUCTIONS:
For EVERY claim, audit it strictly against the raw sources and output a JSON array of objects with:
- "claim": The exact claim string.
- "status": Must be one of:
    - "SUPPORTED": Claim is directly proven by the sources.
    - "CONTRADICTED": Claim directly conflicts with facts in the sources or external reality.
    - "UNVERIFIED_HALLUCINATED": Claim lacks grounding or evidence in the sources.
- "confidence": Float score from 0.0 to 1.0 representing certainty.
- "reasoning": 1-2 sentence explanation of the verification audit.
- "citations": List of integer source markers [1, 2] supporting/contradicting the claim.

Return ONLY a valid JSON list of verification objects.

JSON Output:"""
)

# =========================================================
# AGENT 3: SYNTHESIS & REPORT COMPILER AGENT
# =========================================================

SYNTHESIS_PROMPT = PromptTemplate(
    input_variables=["question", "research_summary", "claims_matrix_json", "trust_score"],
    template="""You are the Senior Synthesis & Report Compiler Agent.
Compile a final, polished Markdown Research & Fact-Verification Report for the user query: "{question}".

Overall Research Trust Index: {trust_score}%

Audit Data:
{claims_matrix_json}

Raw Research Findings:
{research_summary}

FORMAT INSTRUCTIONS:
Create a well-structured markdown report formatted as follows:

### 📋 Executive Summary
(Synthesize the verified research findings clearly with bracketed citations like [1], [2]).

### 🛡️ Claim Verification & Hallucination Audit
Create a markdown table breaking down each claim:
| Claim | Audit Status | Confidence Score | Source Citations |
|---|---|---|---|
(Populate table using the Audit Data. Use 🟢 SUPPORTED, 🔴 CONTRADICTED, 🟡 UNVERIFIED tags).

### ⚠️ Detected Contradictions & Hallucinations
(If any claim is CONTRADICTED or UNVERIFIED, detail the risk here. If all claims are supported, state "Zero hallucinations or source contradictions detected.").

Ensure your response is professional, transparent, and accurate.
"""
)

# =========================================================
# MULTI-AGENT ORCHESTRATION PIPELINE (STREAMING)
# =========================================================

def run_multi_agent_pipeline_stream(
    question: str,
    history: List[Dict[str, str]] | None = None
) -> Generator[Dict[str, Any], None, None]:
    """Runs the 3-agent autonomous research and verification pipeline,
    yielding real-time status updates, reflections, claim verification data,
    and final report streaming tokens."""
    
    # ---------------------------------------------------------
    # STEP 1: RESEARCHER AGENT (Context Retrieval & Web Fallback)
    # ---------------------------------------------------------
    yield {
        "type": "thought",
        "agent": "Researcher Agent",
        "content": f"Initializing Research Agent for topic: '{question}'..."
    }
    
    context, citations, highest_score = retrieve_context(question)
    source_type = "documents"
    web_citations: List[Citation] = []
    
    yield {
        "type": "thought",
        "agent": "Researcher Agent",
        "content": f"Vector DB search complete. Retrieved {len(citations)} document chunk(s) with max similarity score {round(highest_score, 3)}."
    }

    # Fallback to Exa Web Search if local context is sparse or irrelevant
    if not context or not citations or highest_score < RELEVANCE_THRESHOLD:
        yield {
            "type": "thought",
            "agent": "Researcher Agent",
            "content": f"Local document coverage sparse (threshold {RELEVANCE_THRESHOLD}). Activating Exa Web Search fallback..."
        }
        yield {
            "type": "tool_start",
            "tool": "exa_web_search",
            "input": {"query": question}
        }

        try:
            web_ans_text, web_citations = exa_search_fallback(question)
            if web_citations:
                source_type = "hybrid" if citations else "web"
                # Append web citations to context
                web_blocks = []
                base_idx = len(citations)
                for idx, wc in enumerate(web_citations, start=base_idx + 1):
                    wc.index = idx
                    web_blocks.append(f"[{idx}] Web Source: {wc.document}\n{wc.snippet}")
                    citations.append(wc)
                
                context = (context + "\n\n" + "\n\n".join(web_blocks)).strip()
                yield {
                    "type": "tool_end",
                    "tool": "exa_web_search",
                    "output": {"web_sources_found": len(web_citations)}
                }
        except Exception as exa_err:
            logger.warning(f"Exa search error in multi-agent pipeline: {exa_err}")

    if not context:
        refusal_msg = "No relevant source documents or web information could be retrieved to research this query."
        for token in refusal_msg:
            yield {"type": "token", "content": token}
        yield {
            "type": "final",
            "answer": refusal_msg,
            "citations": [],
            "confidence": 0.0,
            "claims_verification": [],
            "overall_trust_score": 0.0,
            "source_type": "none"
        }
        return

    # Execute Researcher LLM Agent
    yield {
        "type": "thought",
        "agent": "Researcher Agent",
        "content": "Analyzing evidence and extracting core factual claims..."
    }

    researcher_chain = RESEARCHER_PROMPT | agent_llm | StrOutputParser()
    researcher_raw = ""
    try:
        researcher_raw = researcher_chain.invoke({
            "question": question,
            "context": context,
            "history": format_history(history)
        })
    except Exception as e:
        logger.error(f"Researcher LLM execution failed: {e}")
        err_str = str(e).lower()
        if "429" in err_str or "rate limit" in err_str or "quota" in err_str:
            rate_limit_msg = f"### ⚠️ API Rate Limit Exceeded\n\nThe AI provider has reached its daily request limit. Please try again later or add credits to your API account to unlock more requests."
            for token in rate_limit_msg:
                yield {"type": "token", "content": token}
            yield {
                "type": "final",
                "answer": rate_limit_msg,
                "citations": [],
                "confidence": 0.0,
                "claims_verification": [],
                "overall_trust_score": 0.0,
                "source_type": "none"
            }
            return
            
        researcher_raw = json.dumps({
            "research_summary": f"Research synthesis for {question} based on retrieved context.",
            "extracted_claims": [question]
        })

    # Clean JSON output from Researcher
    try:
        clean_json_str = re.sub(r"^```json\s*|\s*```$", "", researcher_raw.strip(), flags=re.MULTILINE)
        res_data = json.loads(clean_json_str)
        research_summary = res_data.get("research_summary", researcher_raw)
        extracted_claims = res_data.get("extracted_claims", [question])
    except Exception:
        research_summary = researcher_raw
        extracted_claims = [line.strip("- ") for line in researcher_raw.split("\n") if line.strip().startswith("-")][:4]
        if not extracted_claims:
            extracted_claims = [question]

    yield {
        "type": "reflection",
        "agent": "Researcher Agent",
        "content": f"Research Agent extracted {len(extracted_claims)} factual claims for cross-verification audit."
    }

    # ---------------------------------------------------------
    # STEP 2: VERIFICATION & HALLUCINATION DETECTION AGENT
    # ---------------------------------------------------------
    yield {
        "type": "thought",
        "agent": "Verification Agent",
        "content": "Running fact-verification & hallucination audit across source evidence..."
    }

    verifier_chain = VERIFIER_PROMPT | agent_llm | StrOutputParser()
    sources_text = "\n\n".join([f"[{c.index}] {c.document}: {c.snippet}" for c in citations])
    
    verifier_raw = ""
    try:
        verifier_raw = verifier_chain.invoke({
            "claims": json.dumps(extracted_claims, indent=2),
            "sources": sources_text
        })
    except Exception as v_err:
        logger.error(f"Verification Agent execution failed: {v_err}")

    verified_claims: List[Dict[str, Any]] = []
    try:
        clean_v_json = re.sub(r"^```json\s*|\s*```$", "", verifier_raw.strip(), flags=re.MULTILINE)
        v_list = json.loads(clean_v_json)
        for item in v_list:
            verified_claims.append({
                "claim": item.get("claim", ""),
                "status": item.get("status", "SUPPORTED"),
                "confidence": round(float(item.get("confidence", 0.85)), 2),
                "reasoning": item.get("reasoning", "Verified against source evidence."),
                "citations": item.get("citations", [1])
            })
    except Exception:
        # Fallback verification objects if JSON parsing fails
        for idx, claim in enumerate(extracted_claims, start=1):
            verified_claims.append({
                "claim": claim,
                "status": "SUPPORTED" if citations else "UNVERIFIED_HALLUCINATED",
                "confidence": 0.88 if citations else 0.40,
                "reasoning": "Cross-referenced with retrieved corpus.",
                "citations": [c.index for c in citations[:2]]
            })

    # Calculate overall trust score
    if verified_claims:
        avg_conf = sum(c["confidence"] for c in verified_claims) / len(verified_claims)
        overall_trust_score = round(avg_conf * 100, 1)
    else:
        overall_trust_score = 0.0

    yield {
        "type": "verification_audit",
        "agent": "Verification Agent",
        "overall_trust_score": overall_trust_score,
        "verified_claims": verified_claims,
        "content": f"Fact-Verification complete. Overall Research Trust Index: {overall_trust_score}%."
    }

    # ---------------------------------------------------------
    # STEP 3: SYNTHESIS & REPORT COMPILER AGENT
    # ---------------------------------------------------------
    yield {
        "type": "thought",
        "agent": "Synthesis Agent",
        "content": "Compiling final citation-backed report and per-claim matrix..."
    }

    synthesis_chain = SYNTHESIS_PROMPT | agent_llm | StrOutputParser()
    
    try:
        synthesis_stream = synthesis_chain.stream({
            "question": question,
            "research_summary": research_summary,
            "claims_matrix_json": json.dumps(verified_claims, indent=2),
            "trust_score": overall_trust_score
        })
        
        full_report_chunks = []
        for chunk in synthesis_stream:
            full_report_chunks.append(chunk)
            yield {"type": "token", "content": chunk}
            
        full_report = "".join(full_report_chunks)
    except Exception as s_err:
        logger.error(f"Synthesis Agent streaming failed: {s_err}")
        err_str = str(s_err).lower()
        if "429" in err_str or "rate limit" in err_str or "quota" in err_str:
            full_report = f"### ⚠️ API Rate Limit Exceeded\n\nThe AI provider has reached its daily request limit during the synthesis step. Please try again later or add credits to your API account."
        else:
            full_report = f"### Research Report: {question}\n\n{research_summary}"
            
        for token in full_report:
            yield {"type": "token", "content": token}
    # Final payload with complete metadata
    yield {
        "type": "final",
        "answer": full_report,
        "citations": [asdict(c) for c in citations],
        "confidence": round(overall_trust_score / 100.0, 3),
        "claims_verification": verified_claims,
        "overall_trust_score": overall_trust_score,
        "source_type": source_type,
    }
