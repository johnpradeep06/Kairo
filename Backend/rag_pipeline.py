import os
import re
import json
import requests
from dataclasses import dataclass, field, asdict
from typing import Any, List
from dotenv import load_dotenv
from exa_py import Exa
from sqlalchemy.orm import Session
from database import FAQRule, FailedRetrieval

from langchain_core.prompts import PromptTemplate
from langchain_text_splitters import RecursiveCharacterTextSplitter
from langchain_community.document_loaders import PyPDFLoader, TextLoader
from langchain_community.vectorstores import Chroma
from langchain_core.output_parsers import StrOutputParser
from langchain_openai import ChatOpenAI, OpenAIEmbeddings
from langchain_core.embeddings import Embeddings

class JinaEmbeddings(Embeddings):
    def __init__(self, api_key: str):
        self.api_key = api_key

    def embed_documents(self, texts: List[str]) -> List[List[float]]:
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json"
        }
        payload = {
            "model": "jina-embeddings-v5-text-small",
            "task": "retrieval.passage",
            "normalized": True,
            "input": texts
        }
        response = requests.post("https://api.jina.ai/v1/embeddings", headers=headers, json=payload)
        response.raise_for_status()
        return [item["embedding"] for item in response.json()["data"]]

    def embed_query(self, text: str) -> List[float]:
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json"
        }
        payload = {
            "model": "jina-embeddings-v5-text-small",
            "task": "retrieval.query",
            "normalized": True,
            "input": [text]
        }
        response = requests.post("https://api.jina.ai/v1/embeddings", headers=headers, json=payload)
        response.raise_for_status()
        return response.json()["data"][0]["embedding"]

# =========================================================
# LOAD ENV
# =========================================================

load_dotenv()
exa = Exa(api_key=os.environ.get("EXA_API_KEY"))

# =========================================================
# LANGSMITH CONFIG
# =========================================================

os.environ["LANGCHAIN_TRACING_V2"] = "true"
os.environ["LANGCHAIN_ENDPOINT"] = "https://api.smith.langchain.com"

# =========================================================
# CONFIG
# =========================================================

RETRIEVAL_K = 6
MAX_HISTORY_TURNS = 6          # how many prior messages feed the rewriter
SNIPPET_CHARS = 320            # citation preview length

# Relevance cutoff is NOT portable across embedding models — each produces its
# own score distribution, so a value tuned for one silently stops filtering
# under another. Defaults below are set per provider further down, once the
# provider is known. Override with RELEVANCE_THRESHOLD in .env.
_RELEVANCE_THRESHOLD_BY_PROVIDER = {
    # Measured against the indexed corpus (7 on-topic vs 6 off-topic queries):
    # on-topic top scores 0.655-0.769, off-topic 0.366-0.395. 0.50 sits in the
    # 0.26-wide gap with margin on both sides.
    "gemini": 0.50,
    "jina":0.30,
    "openrouter": 0.15,
    "openai": 0.15,
}

OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY")
CHROMA_PERSIST_DIR = os.getenv("CHROMA_DB_PATH", "./chroma_db")

if not OPENROUTER_API_KEY:
    print("[warning] OPENROUTER_API_KEY not found in environment variables")

# =========================================================
# RESULT TYPES
# =========================================================

@dataclass
class Citation:
    """A single retrieved chunk, carried all the way to the UI."""
    index: int                      # 1-based marker shown in the answer
    document: str                   # display filename or web page title
    page: int | None = None         # PDF page (0-based from PyPDFLoader)
    snippet: str = ""
    score: float = 0.0              # relevance score for this chunk
    doc_id: int | None = None       # Document.id when known
    url: str | None = None          # set for web-fallback citations


@dataclass
class RagResult:
    answer: str
    citations: list[Citation] = field(default_factory=list)
    confidence: float = 0.0
    source_type: str = "none"       # documents|web|faq|none
    retrieval_failed: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "answer": self.answer,
            "citations": [asdict(c) for c in self.citations],
            "confidence": round(self.confidence, 3),
            "source_type": self.source_type,
        }


# =========================================================
# INDEXING & STORAGE
# =========================================================

# Embedding provider selection.
#
# IMPORTANT: these providers emit different vector dimensionalities.
# Changing provider requires wiping the Chroma collection and re-ingesting
# every document — see reindex_all_documents() in this module.
EMBEDDING_PROVIDER = "openrouter:text-embedding-3-small"
embedding_func = OpenAIEmbeddings(
    openai_api_key=OPENROUTER_API_KEY,
    openai_api_base="https://openrouter.ai/api/v1",
    model="text-embedding-3-small"
)

_provider_family = EMBEDDING_PROVIDER.split(":", 1)[0]
_env_threshold = os.getenv("RELEVANCE_THRESHOLD")
RELEVANCE_THRESHOLD = (
    float(_env_threshold)
    if _env_threshold
    else _RELEVANCE_THRESHOLD_BY_PROVIDER.get(_provider_family, 0.15)
)

print(f"[embeddings] provider: {EMBEDDING_PROVIDER} | relevance threshold: {RELEVANCE_THRESHOLD}")

# NOTE: The database must be rebuilt because embedding dimensions/provider changed.
# If a persistence directory already exists (e.g. chroma_db), it must be manually rebuilt.
vectorstore = Chroma(
    persist_directory=CHROMA_PERSIST_DIR,
    embedding_function=embedding_func
)

text_splitter = RecursiveCharacterTextSplitter(
    chunk_size=1000,
    chunk_overlap=200,
)


def ingest_document(file_path: str, doc_id: int | None = None) -> int:
    """Load a file, split it, and add it to the vectorstore.

    Each chunk carries `doc_id` and `filename` metadata so answers can cite the
    originating document and so deletion can target a document precisely.

    Returns the number of chunks indexed.
    """
    from settings_manager import load_settings
    settings = load_settings()
    local_text_splitter = RecursiveCharacterTextSplitter(
        chunk_size=settings.get("chunk_size", 1000),
        chunk_overlap=settings.get("chunk_overlap", 200),
    )

    ext = os.path.splitext(file_path)[1].lower()

    if ext == ".pdf":
        loader = PyPDFLoader(file_path)
    elif ext == ".txt":
        loader = TextLoader(file_path, encoding="utf-8")
    elif ext == ".docx":
        from langchain_community.document_loaders import Docx2txtLoader
        loader = Docx2txtLoader(file_path)
    else:
        raise ValueError(f"Unsupported file type: {ext}")

    docs = loader.load()
    splits = text_splitter.split_documents(docs)

    filename = os.path.basename(file_path)
    for i, chunk in enumerate(splits):
        chunk.metadata["filename"] = filename
        chunk.metadata["chunk_index"] = i
        if doc_id is not None:
            chunk.metadata["doc_id"] = doc_id

    if splits:
        vectorstore.add_documents(documents=splits)

    return len(splits)


def delete_document_chunks(file_path: str, doc_id: int | None = None) -> int:
    """Remove every chunk belonging to a document. Matches on doc_id when
    available and falls back to the legacy `source` path filter."""
    ids: list[str] = []

    if doc_id is not None:
        ids = vectorstore.get(where={"doc_id": doc_id}).get("ids", [])

    if not ids:
        ids = vectorstore.get(where={"source": file_path}).get("ids", [])

    if ids:
        vectorstore.delete(ids=ids)

    return len(ids)


def reindex_all_documents(db: Session) -> dict[str, Any]:
    """Drop every vector and re-embed all indexed documents from disk.

    Required after changing EMBEDDING_PROVIDER: vectors from two different
    models are not comparable, and a dimensionality change makes Chroma reject
    writes outright ("Embedding dimension X does not match collection
    dimensionality Y").

    Only touches the vector store — the Document rows and the files on disk are
    the source of truth and are left alone, so this is re-runnable.
    """
    global vectorstore
    from database import Document

    # Recreate the collection rather than deleting ids: Chroma pins
    # dimensionality at collection level, so a dimension change needs the old
    # collection gone entirely.
    try:
        vectorstore.delete_collection()
    except Exception as e:
        print(f"[reindex] could not drop collection (continuing): {e}")

    vectorstore = Chroma(
        persist_directory=CHROMA_PERSIST_DIR,
        embedding_function=embedding_func,
    )

    results: dict[str, Any] = {"provider": EMBEDDING_PROVIDER, "documents": [], "total_chunks": 0}

    for doc in db.query(Document).all():
        if not os.path.exists(doc.stored_path):
            doc.status = "error"
            doc.error_detail = "Source file missing from disk; re-upload required."
            results["documents"].append({"filename": doc.filename, "status": "missing"})
            continue
        try:
            count = ingest_document(doc.stored_path, doc_id=doc.id)
            doc.chunk_count = count
            doc.status = "indexed"
            doc.error_detail = None
            results["documents"].append({"filename": doc.filename, "chunks": count})
            results["total_chunks"] += count
        except Exception as e:
            doc.status = "error"
            doc.error_detail = str(e)[:1000]
            results["documents"].append({"filename": doc.filename, "status": "error", "detail": str(e)[:200]})

    db.commit()
    return results


# =========================================================
# RETRIEVAL
# =========================================================

def retrieve_context(question: str) -> tuple[str, list[Citation], float]:
    """Retrieve relevant chunks, preserving the metadata needed for citations.

    Returns (context_block, citations, highest_score). The context block is
    numbered so the model can reference sources as [1], [2], ...
    """
    results = vectorstore.similarity_search_with_relevance_scores(question, k=RETRIEVAL_K)

    highest_score = results[0][1] if results else 0.0

    relevant = [(doc, score) for doc, score in results if score >= RELEVANCE_THRESHOLD]
    if not relevant:
        return "", [], highest_score

    citations: list[Citation] = []
    blocks: list[str] = []

    for i, (doc, score) in enumerate(relevant, start=1):
        meta = doc.metadata or {}
        name = meta.get("filename") or os.path.basename(str(meta.get("source", "Unknown document")))
        page = meta.get("page")
        snippet = " ".join(doc.page_content.split())[:SNIPPET_CHARS]

        citations.append(Citation(
            index=i,
            document=name,
            page=int(page) if isinstance(page, (int, float)) else None,
            snippet=snippet,
            score=round(float(score), 3),
            doc_id=meta.get("doc_id"),
        ))

        header = f"[{i}] {name}"
        if page is not None:
            header += f" (page {int(page) + 1})"
        blocks.append(f"{header}\n{doc.page_content}")

    return "\n\n".join(blocks), citations, highest_score


def _confidence_from(highest_score: float, citations: list[Citation]) -> float:
    """Blend best-match strength with corroboration across chunks.

    A single weak hit should not read as confident, and several agreeing chunks
    should read as more confident than one.
    """
    if not citations:
        return 0.0
    top = max(0.0, min(1.0, highest_score))
    corroboration = min(len(citations), 3) / 3.0
    return round(0.75 * top + 0.25 * top * corroboration, 3)


# =========================================================
# PROMPTS
# =========================================================

prompt = PromptTemplate(
    input_variables=["context", "question", "history"],
    template="""
You are Kairo, a knowledgeable, concise, and professional Enterprise Compliance Copilot.

You can:
- Answer support, service procedure, troubleshooting, maintenance and company policy questions.
- Guide technicians and engineers using official documentation, manuals, resolution guides and FAQ material.

Rules:
1. If the question is a greeting, or about your identity, capabilities, or what you can help with,
   answer directly in a friendly manner without using the context.
2. If the question is a natural follow-up to something already established earlier in this
   conversation — including a prior FAQ answer, a prior document-grounded answer, or anything
   else already stated below in "Conversation so far" — answer using that established
   information. Do not refuse just because the Context block is empty or unrelated; the prior
   conversation is a valid basis for follow-ups on the same topic.
3. For any other support-related query — one that introduces a fact not already established in
   this conversation — answer ONLY using the provided Context block.
4. CRITICAL RULE: If a query falls under Rule 3 and the answer is NOT present in the Context
   block, AND it is not covered by Rule 2, you MUST respond exactly with the phrase: "Sorry, I
   don't know based on the given context." This applies to genuinely new topics unrelated to
   support, this conversation, or the context — for example general-knowledge questions like
   "who is Spider-Man" or "who is the Prime Minister of India." Do not provide a partial answer.
5. CITATIONS: Only when a sentence is drawn from the Context block, end it with the bracketed
   marker of the source it came from, e.g. [1] or [2]. Use the numbers exactly as they appear in
   the Context block. Never invent a citation number, and never cite the conversation history —
   it is not a numbered source.
6. Keep answers clear, simple, and professional.
7. Provide troubleshooting steps in bullet points when applicable.
8. Do NOT add assumptions or external information beyond the context or the established
   conversation.

Conversation so far (a valid source for follow-ups under Rule 2 — but never cite it with a [n] marker):
{history}

Context:
{context}

User Question:
{question}

Answer:
"""
)

rewrite_prompt = PromptTemplate(
    input_variables=["history", "question"],
    template="""
Rewrite the user's latest question into a standalone search query that makes sense
without the conversation history. Resolve pronouns, implicit references, and action follow-ups
("it", "that pump", "the same procedure", "this topic", "search on web for this topic") using the history.

IMPORTANT INSTRUCTIONS:
- If the latest question requests an action like "search on web for this topic" or "tell me more about it",
  extract the actual subject/topic from the history and return the topic as a standalone search query.
  Example History:
    User: What is the formula NEMA provides for temperature rise at high altitude?
    Assistant: TRSL = TRA * [1 - (ALT-3300)/33000]...
  Example Question: search on web for this topic
  Standalone Query: NEMA formula for temperature rise at high altitude

Return ONLY the rewritten query with no preamble or quotes.

Conversation history:
{history}

Latest question: {question}

Standalone query:"""
)

# =========================================================
# LLM
# =========================================================

# Overridable without a code change, so switching between a paid model and a
# free one (any id ending in `:free`) is an env edit plus a restart.
OPENROUTER_MODEL = os.getenv("OPENROUTER_MODEL", "openai/gpt-oss-20b:free")
LLM_MAX_TOKENS = int(os.getenv("LLM_MAX_TOKENS", "1000"))

llm = ChatOpenAI(
    api_key=OPENROUTER_API_KEY,
    base_url="https://openrouter.ai/api/v1",
    model=OPENROUTER_MODEL,
    max_tokens=LLM_MAX_TOKENS,
)

# =========================================================
# CONVERSATION MEMORY
# =========================================================

def format_history(history: list[dict[str, str]] | None) -> str:
    """Render prior turns for the prompt. `history` is a list of
    {"role": "user"|"assistant", "content": str}, oldest first."""
    if not history:
        return "(no previous messages)"

    recent = history[-MAX_HISTORY_TURNS:]
    lines = []
    for turn in recent:
        role = "User" if turn.get("role") == "user" else "Kairo"
        content = " ".join(str(turn.get("content", "")).split())
        if len(content) > 500:
            content = content[:500] + "…"
        lines.append(f"{role}: {content}")
    return "\n".join(lines)


def rewrite_query(question: str, history: list[dict[str, str]] | None) -> str:
    """Resolve follow-ups into standalone queries before retrieval.

    Without this, "what about the other pump?" retrieves on those five words
    alone and finds nothing.
    """
    if not history:
        return question

    try:
        chain = rewrite_prompt | llm | StrOutputParser()
        rewritten = chain.invoke({
            "history": format_history(history),
            "question": question,
        }).strip()

        # Guard against the model returning an explanation or empty string
        if not rewritten or len(rewritten) > 400:
            return question
        return rewritten
    except Exception as e:
        print(f"[rewrite] falling back to raw question: {e}")
        return question


# =========================================================
# SECONDARY RAG / FALLBACK
# =========================================================

def is_support_relevant(question: str) -> bool:
    relevance_prompt = PromptTemplate(
        input_variables=["question"],
        template="""
Determine if the following question is related to technical support, IT help, troubleshooting, operations, equipment, safety, compliance, or general workplace queries.
Respond with exactly YES or NO.

Question: {question}
"""
    )
    chain = relevance_prompt | llm | StrOutputParser()
    try:
        result = chain.invoke({"question": question})
        return "YES" in result.strip().upper()
    except Exception:
        return False


def exa_search_fallback(question: str) -> tuple[str, list[Citation]]:
    """Answer from the open web. Returns (answer, citations) so the caller can
    label the result as ungrounded rather than passing it off as plant
    documentation.

    Raises on API failure so the caller can fall back to an honest "I don't
    know" instead of labelling an error string as a web-sourced answer.
    """
    try:
        response = exa.answer(question, text=True)
        answer_text = getattr(response, "answer", "") or str(response)
    except Exception as e:
        print(f"[exa] answer call failed, trying search_and_contents fallback: {e}")
        try:
            search_res = exa.search_and_contents(question, num_results=5, text=True)
            results = getattr(search_res, "results", [])
            snippets = [f"Source [{i+1}] {r.title}: {r.text[:300]}" for i, r in enumerate(results) if getattr(r, "text", None)]
            prompt_text = f"Based on these web search results, answer the question: {question}\n\nWeb Sources:\n" + "\n".join(snippets)
            answer_text = llm.invoke(prompt_text).content
            response = search_res
        except Exception as err:
            raise err

    citations: list[Citation] = []
    seen_urls: set[str] = set()

    exa_citations = getattr(response, "citations", None) or getattr(response, "results", None) or []
    for item in exa_citations:
        url = getattr(item, "url", None)
        title = getattr(item, "title", None) or url or "Web Source"
        text_content = getattr(item, "text", "") or getattr(item, "snippet", "") or ""
        snippet = " ".join(str(text_content).split())[:220]

        if url and url not in seen_urls:
            seen_urls.add(url)
            citations.append(Citation(
                index=len(citations) + 1,
                document=title,
                snippet=snippet,
                score=0.0,
                url=url,
            ))

    # Index whatever text Exa returned, keyed by URL, so links found only in the
    # answer body can still show a preview instead of a bare title.
    text_by_url: dict[str, str] = {}
    for item in exa_citations:
        item_url = getattr(item, "url", None)
        if not item_url:
            continue
        raw = (
            getattr(item, "text", "")
            or getattr(item, "snippet", "")
            or getattr(item, "summary", "")
            or ""
        )
        if not raw:
            highlights = getattr(item, "highlights", None) or []
            if highlights:
                raw = " ".join(str(h) for h in highlights)
        if raw:
            text_by_url[item_url] = " ".join(str(raw).split())[:220]

    links = re.findall(r'\[([^\]]+)\]\((https?://[^\)]+)\)', answer_text)
    for title, url in links:
        if url not in seen_urls:
            seen_urls.add(url)
            citations.append(Citation(
                index=len(citations) + 1,
                document=title or "Web Source",
                snippet=text_by_url.get(url, ""),
                score=0.0,
                url=url,
            ))

    answer_text = re.sub(r'\s*\((?:\[[^\]]+\]\((?:https?://[^\)]+)\)(?:,\s*)?)+\)', '', answer_text)
    answer_text = re.sub(r'\[([^\]]+)\]\((https?://[^\)]+)\)', r'\1', answer_text)

    return clean_answer(answer_text), citations


# =========================================================
# RAG FUNCTION
# =========================================================

_FALLBACK_TRIGGERS = [
    "don't know based on the given context",
    "don’t know based on the given context",
    "do not know based on the given context",
    "don't know based on the context",
    "don’t know based on the context",
    "don't know",  # catch shorter versions of the LLM defying prompt rules
]


_MOJIBAKE_MARKERS = ("â€", "Ã", "Â", "â€™", "â€œ")


def _repair_mojibake(text: str) -> str:
    """Undo UTF-8 bytes that were decoded as cp1252 ("Pâ€'101A" -> "P‑101A").

    Repairs run by run so characters outside cp1252 (emoji, CJK) survive, and
    only when the round-trip decodes cleanly — genuine accented text fails that
    check and is left untouched.
    """
    if not text or not any(m in text for m in _MOJIBAKE_MARKERS):
        return text

    out: list[str] = []
    buf: list[str] = []

    def flush() -> None:
        if not buf:
            return
        chunk = "".join(buf)
        try:
            out.append(chunk.encode("cp1252").decode("utf-8"))
        except (UnicodeEncodeError, UnicodeDecodeError):
            out.append(chunk)
        buf.clear()

    for ch in text:
        try:
            ch.encode("cp1252")
        except UnicodeEncodeError:
            flush()
            out.append(ch)
        else:
            buf.append(ch)
    flush()

    return "".join(out)


def _normalize_citation_markers(text: str) -> str:
    """Models emit 【1】, [ 1 ] and [1] interchangeably. Normalise to [1] so the
    markers render correctly and can actually be parsed."""
    return re.sub(r'[\[【〔]\s*(\d{1,2})\s*[\]】〕]', r'[\1]', text)


def clean_answer(text: str) -> str:
    # Order matters: normalising brackets first removes non-cp1252 characters
    # that would otherwise block the mojibake repair.
    return _repair_mojibake(_normalize_citation_markers(text)).strip()


def _cited_indices(answer: str) -> set[int]:
    return {int(n) for n in re.findall(r'\[(\d{1,2})\]', answer)}


# An explicit instruction to go to the web. These are commands, not questions —
# "search the web about this" carries no topic of its own, so the generic
# relevance check reads it as off-topic and would silently suppress the search
# the user just asked for.
_WEB_SEARCH_INTENT = re.compile(
    r'\b('
    # "search ... the web" / "look ... up online" — allow a short gap so
    # "search about this in the web" and "search this up online" both match,
    # while staying inside one clause (no sentence punctuation in the gap).
    r'(?:search|look|find|check|browse|google)\b[^.?!\n]{0,40}?\b(?:web|internet|online|google)'
    r'|(?:web|internet|online|google)\s+search'
    r'|google\s+(?:it|this|that)'
    r')\b',
    re.IGNORECASE,
)


def wants_web_search(question: str) -> bool:
    """True when the user explicitly asked us to search the web."""
    return bool(_WEB_SEARCH_INTENT.search(question or ""))


def describe_llm_failure(err: Exception) -> str:
    """Turn a provider exception into something the operator can act on.

    A bare "network error" sends people hunting through their own stack for a
    fault that is actually an account or rate-limit problem upstream.
    """
    text = str(err)
    lowered = text.lower()

    if "402" in text or "more credits" in lowered or "insufficient" in lowered:
        return (
            "**The language model is out of credits.**\n\n"
            "Kairo reached OpenRouter but the account can't fund this request. "
            "Retrieval and your document library are unaffected.\n\n"
            "To fix this, either:\n"
            "- Add credits at [openrouter.ai/settings/credits](https://openrouter.ai/settings/credits), or\n"
            "- Switch `OPENROUTER_MODEL` to a free model (one whose id ends in `:free`) and restart the backend."
        )
    if "429" in text or "rate limit" in lowered:
        return (
            "**Rate limited by the model provider.**\n\n"
            "Too many requests in a short window. Wait a few seconds and try again."
        )
    if "401" in text or "invalid api key" in lowered or "no auth" in lowered:
        return (
            "**The model provider rejected our API key.**\n\n"
            "Check that `OPENROUTER_API_KEY` in the backend `.env` is present and valid, then restart the backend."
        )
    if "timeout" in lowered or "timed out" in lowered:
        return (
            "**The model took too long to respond.**\n\n"
            "This is usually transient — please try again."
        )
    return (
        "**The language model is temporarily unavailable.**\n\n"
        f"Your documents and search index are fine. Technical detail: `{text[:180]}`"
    )


# The command wrapper itself, to be removed before the topic is sent to Exa.
# Every alternative is \b-anchored — without that, the "on" filler ate the
# start of "online" and left "line" in the query.
_WEB_SEARCH_COMMAND_NOISE = re.compile(
    r'\b(?:please|kindly|can|could|you)\b'
    r'|\b(?:search|look|find|check|browse|google)\b'
    r'|\b(?:web|internet|online)\b'
    r'|\b(?:it|this|that|them|more|out|up|for|about|regarding|on|in|over|the|a|an|of)\b',
    re.IGNORECASE,
)


def strip_web_command(text: str) -> str:
    """Remove the 'search the web for ...' wrapper, leaving the topic.

    Returns "" when nothing meaningful survives — the caller should then fall
    back to the history-rewritten query rather than searching for filler.
    """
    stripped = _WEB_SEARCH_COMMAND_NOISE.sub(' ', text or '')
    stripped = re.sub(r'\s+', ' ', stripped).strip(' ,.;:-?!')
    # Require real content, not one stray token like "this".
    return stripped if len(stripped) >= 4 and len(stripped.split()) >= 1 else ''


def rag_answer(
    question: str,
    db: Session = None,
    history: list[dict[str, str]] | None = None,
) -> RagResult:
    """Answer a question against the indexed corpus.

    Returns a RagResult carrying the answer plus the citations and confidence
    the UI needs. Callers that only want text can use `.answer`.
    """
    # 1. FAQ check — a curated answer always wins
    if db is not None:
        try:
            active_rules = db.query(FAQRule).filter(FAQRule.is_active == True).all()  # noqa: E712
            q_lower = question.lower()
            matches = [r for r in active_rules if r.keyword.lower() in q_lower]
            if matches:
                best_match = max(matches, key=lambda r: len(r.keyword))
                return RagResult(
                    answer=best_match.response,
                    citations=[],
                    confidence=1.0,
                    source_type="faq",
                )
        except Exception as e:
            print(f"Error matching FAQ rules: {e}")

    # 2. Resolve follow-ups, then retrieve
    search_query = rewrite_query(question, history)
    explicit_web = wants_web_search(question)

    # An explicit "search the web" is a direct instruction — honour it without
    # first making the user sit through a document answer they didn't ask for.
    if explicit_web:
        try:
            web_answer, web_citations = exa_search_fallback(search_query)
            return RagResult(
                answer=web_answer,
                citations=web_citations,
                confidence=0.35 if web_citations else 0.2,
                source_type="web",
                retrieval_failed=False,
            )
        except Exception as e:
            print(f"Exa search (explicit request) failed: {e}")
            return RagResult(
                answer=(
                    "I couldn't run a web search just now — the search service is "
                    "unavailable. Please try again shortly, or ask me to answer from "
                    "your indexed documents instead."
                ),
                citations=[],
                confidence=0.0,
                source_type="none",
                retrieval_failed=True,
            )

    context, citations, highest_score = retrieve_context(search_query)

    chain = prompt | llm | StrOutputParser()
    answer = clean_answer(chain.invoke({
        "context": context or "(no documents matched this query)",
        "question": question,
        "history": format_history(history),
    }))

    answer_lower = answer.lower()
    refused = any(trigger in answer_lower for trigger in _FALLBACK_TRIGGERS)

    source_type = "documents"
    confidence = _confidence_from(highest_score, citations)

    # 3. Web fallback — clearly labelled, never blended with document answers
    if refused:
        citations = []
        confidence = 0.0
        source_type = "none"

        # Judge relevance on the rewritten query, not the raw one: a follow-up
        # like "and what about that?" carries no topic of its own and would
        # otherwise be dismissed as off-topic, suppressing a valid fallback.
        if is_support_relevant(search_query):
            extended_query = f"{search_query} technical support troubleshooting manual"
            try:
                web_answer, web_citations = exa_search_fallback(extended_query)
                answer = web_answer
                citations = web_citations
                source_type = "web"
                confidence = 0.35 if web_citations else 0.2
            except Exception as e:
                # Keep the honest refusal rather than presenting an API error
                # under a "answered from the web" banner.
                print(f"Exa search fallback failed: {e}")
                answer = (
                    "I couldn't find anything about this in your indexed documents, "
                    "and the web search fallback is currently unavailable. "
                    "Try rephrasing, or ask an administrator to upload the relevant document."
                )
    else:
        # Keep only the citations the model actually referenced. If it cited
        # nothing, it didn't draw on the retrieved context at all — under the
        # new Rule 2 it likely answered from the established conversation (or
        # is a greeting/identity reply under Rule 1) — so don't attach
        # document confidence/sources to an answer that isn't grounded in them.
        used = _cited_indices(answer)
        citations = [c for c in citations if c.index in used]
        if not citations:
            confidence = 0.0
            source_type = "conversation" if history else "none"

    # 4. Log the gap for the knowledge-gap dashboard. Only a genuine refusal
    # counts as a gap — a follow-up answered from conversation memory
    # succeeded, and logging it would make the dashboard misleading.
    if refused and db is not None:
        try:
            db.add(FailedRetrieval(
                query_text=question,
                highest_score=highest_score,
                fallback_triggered=(source_type == "web"),
            ))
            db.commit()
        except Exception as e:
            db.rollback()
            print(f"Failed to log retrieval analytics: {e}")

    return RagResult(
        answer=answer,
        citations=citations,
        confidence=confidence,
        source_type=source_type,
        retrieval_failed=refused,
    )


def serialize_citations(citations: list[Citation]) -> str:
    return json.dumps([asdict(c) for c in citations])


# =========================================================
# FOLLOW-UP SUGGESTIONS
# =========================================================

follow_up_prompt = PromptTemplate(
    input_variables=["question", "answer", "sources"],
    template="""
You suggest follow-up questions for a technician using an industrial support copilot.

Given the question just asked, the answer given, and excerpts from the source
documents, propose up to 3 short follow-up questions the user is likely to ask next.

Rules:
- Each question must be answerable from the same document material shown below.
  Do not invent topics the sources say nothing about.
- Keep each under 60 characters. Write them as the user would type them.
- Make them specific: prefer "What is the vibration limit for P-101A?" over
  "Tell me more about this".
- Do not repeat the question that was already asked.
- Output ONE question per line, with no numbering, bullets or quotes.
- If no useful follow-up exists (for example the answer was a greeting, an error,
  or the sources are empty), output exactly: NONE

Question asked: {question}

Answer given: {answer}

Source excerpts:
{sources}

Follow-up questions:"""
)


def generate_follow_ups(
    question: str,
    answer: str,
    citations: list[Citation] | list[dict] | None = None,
) -> list[str]:
    """Propose follow-up questions grounded in the same sources as the answer.

    Returns [] when nothing sensible can be suggested — the caller should then
    render no chips rather than falling back to canned text.
    """
    snippets: list[str] = []
    for c in (citations or []):
        text = c.get("snippet") if isinstance(c, dict) else c.snippet
        name = c.get("document") if isinstance(c, dict) else c.document
        if text:
            snippets.append(f"- ({name}) {text}")

    if not snippets:
        return []

    try:
        chain = follow_up_prompt | llm | StrOutputParser()
        raw = chain.invoke({
            "question": question,
            "answer": answer[:1500],
            "sources": "\n".join(snippets[:6]),
        })
    except Exception as e:
        print(f"[follow-ups] generation failed: {e}")
        return []

    raw = clean_answer(raw)
    if "NONE" in raw.upper()[:20]:
        return []

    suggestions: list[str] = []
    for line in raw.splitlines():
        # Strip bullets, numbering and stray quotes the model may add anyway
        line = re.sub(r'^\s*(?:[-*•]|\d+[.)])\s*', '', line).strip().strip('"\'')
        if not line or len(line) > 120:
            continue
        if line.lower() == question.lower().strip():
            continue
        suggestions.append(line)
        if len(suggestions) == 3:
            break

    return suggestions


# =========================================================
# AGENTIC STREAMING RAG PIPELINE
# =========================================================

def run_agentic_rag_stream(
    question: str,
    db: Session = None,
    history: list[dict[str, str]] | None = None,
):
    """
    Generator yielding real-time agent execution events and streamed tokens.
    Yields dict objects with keys: 'type' ('thought'|'tool_start'|'tool_end'|'reflection'|'token'|'final')
    """
    yield {
        "type": "thought",
        "content": f"Analyzing user query: '{question}' across canned rules and vector indexes..."
    }

    # Detect explicit web search request intent. A fixed substring list missed
    # ordinary phrasings — "search on the web about this" matches neither
    # "search on web" nor "search the web" — so the user's explicit request was
    # silently dropped. wants_web_search() handles the intervening words.
    is_explicit_web_request = wants_web_search(question)

    # 1. Resolve history & rewrite query first
    search_query = question
    if history:
        yield {
            "type": "thought",
            "content": "Resolving follow-up references against conversation history..."
        }
        search_query = rewrite_query(question, history)
        if search_query != question:
            yield {
                "type": "reflection",
                "content": f"Rewrote follow-up question to standalone query: '{search_query}'"
            }

    # Strip the "search the web" instruction itself so it isn't sent to Exa as
    # part of the topic. It can appear anywhere in the sentence, not just as a
    # prefix ("search about this in the web"), so this is not anchored to ^.
    if is_explicit_web_request:
        # Only accept the cleanup if something meaningful survives; otherwise the
        # question was pure command ("search the web") and the rewritten query
        # from history is the better search term.
        stripped = strip_web_command(search_query)
        if stripped:
            search_query = stripped

    # If user explicitly requested web search, route directly to Exa Web Search tool
    if is_explicit_web_request:
        yield {
            "type": "thought",
            "content": f"User explicitly requested web search. Routing directly to Exa Web Search Tool for: '{search_query}'..."
        }
        yield {
            "type": "tool_start",
            "tool": "exa_web_search",
            "input": {"query": search_query}
        }

        try:
            web_answer, web_citations = exa_search_fallback(f"{search_query} technical manual troubleshooting")
            yield {
                "type": "tool_end",
                "tool": "exa_web_search",
                "output": {"web_citations_found": len(web_citations)}
            }
            yield {
                "type": "reflection",
                "content": f"Retrieved web search results from {len(web_citations)} verified external sources."
            }

            for token in web_answer:
                yield {"type": "token", "content": token}

            yield {
                "type": "final",
                "answer": web_answer,
                "citations": [asdict(c) for c in web_citations],
                "confidence": 0.35 if web_citations else 0.2,
                "source_type": "web",
            }
            return
        except Exception as e:
            print(f"Exa search failed for explicit request: {e}")
            err_msg = (
                "I tried searching the web for this topic, but the external web search engine is currently unreachable. "
                "Please try again in a few moments."
            )
            for token in err_msg:
                yield {"type": "token", "content": token}
            yield {
                "type": "final",
                "answer": err_msg,
                "citations": [],
                "confidence": 0.0,
                "source_type": "none",
            }
            return

    # 2. Check canned FAQ rules
    yield {
        "type": "tool_start",
        "tool": "check_canned_faqs",
        "input": {"query": question}
    }

    faq_matched = False
    best_match = None
    if db is not None:
        try:
            active_rules = db.query(FAQRule).filter(FAQRule.is_active == True).all()  # noqa: E712
            q_lower_clean = question.lower()
            matches = [r for r in active_rules if r.keyword.lower() in q_lower_clean]
            if matches:
                best_match = max(matches, key=lambda r: len(r.keyword))
                faq_matched = True
        except Exception as e:
            print(f"Error matching FAQ rules: {e}")

    if faq_matched and best_match:
        yield {
            "type": "tool_end",
            "tool": "check_canned_faqs",
            "output": {"match": True, "keyword": best_match.keyword}
        }
        yield {
            "type": "reflection",
            "content": f"Matched exact canned FAQ rule for '{best_match.keyword}'. Instant response triggered."
        }

        for token in best_match.response:
            yield {"type": "token", "content": token}

        yield {
            "type": "final",
            "answer": best_match.response,
            "citations": [],
            "confidence": 1.0,
            "source_type": "faq",
        }
        return

    yield {
        "type": "tool_end",
        "tool": "check_canned_faqs",
        "output": {"match": False}
    }

    # 3. Vector database retrieval tool
    yield {
        "type": "thought",
        "content": f"Executing dense passage retrieval for query: '{search_query}'..."
    }
    yield {
        "type": "tool_start",
        "tool": "chroma_vector_search",
        "input": {"query": search_query, "k": RETRIEVAL_K}
    }

    context, citations, highest_score = retrieve_context(search_query)

    yield {
        "type": "tool_end",
        "tool": "chroma_vector_search",
        "output": {
            "retrieved_chunks": len(citations),
            "highest_similarity_score": round(highest_score, 3),
            "documents": list(set(c.document for c in citations))
        }
    }

    confidence = _confidence_from(highest_score, citations)
    yield {
        "type": "reflection",
        "content": f"Retrieved {len(citations)} document chunk(s) with max similarity score {round(highest_score, 3)} (Blended confidence: {confidence})."
    }

    # 4. Check if local retrieval succeeded before generating answer
    if not context or not citations or highest_score < RELEVANCE_THRESHOLD:
        yield {
            "type": "reflection",
            "content": f"No local document chunks met relevance threshold ({RELEVANCE_THRESHOLD}). Evaluating query for web search fallback..."
        }

        if is_support_relevant(search_query):
            extended_query = f"{search_query} technical support troubleshooting manual"
            yield {
                "type": "thought",
                "content": f"Query evaluated as support-relevant. Activating Exa Web Search tool for '{extended_query}'..."
            }
            yield {
                "type": "tool_start",
                "tool": "exa_web_search",
                "input": {"query": extended_query}
            }

            try:
                web_answer, web_citations = exa_search_fallback(extended_query)
                yield {
                    "type": "tool_end",
                    "tool": "exa_web_search",
                    "output": {"web_citations_found": len(web_citations)}
                }
                yield {
                    "type": "reflection",
                    "content": f"Retrieved web search results from {len(web_citations)} verified external sources."
                }

                for token in web_answer:
                    yield {"type": "token", "content": token}

                yield {
                    "type": "final",
                    "answer": web_answer,
                    "citations": [asdict(c) for c in web_citations],
                    "confidence": 0.35 if web_citations else 0.2,
                    "source_type": "web",
                }
                return
            except Exception as e:
                print(f"Exa search fallback failed: {e}")
                err_text = (
                    "I couldn't find anything about this in your indexed documents, "
                    "and the web search fallback is currently unavailable. "
                    "Try rephrasing, or ask an administrator to upload the relevant document."
                )
                for token in err_text:
                    yield {"type": "token", "content": token}

                yield {
                    "type": "final",
                    "answer": err_text,
                    "citations": [],
                    "confidence": 0.0,
                    "source_type": "none",
                }
                return
        else:
            refusal_text = "I couldn't find relevant information in your indexed document library for this query."
            for token in refusal_text:
                yield {"type": "token", "content": token}

            yield {
                "type": "final",
                "answer": refusal_text,
                "citations": [],
                "confidence": 0.0,
                "source_type": "none",
            }
            return

    # 5. Local document retrieval succeeded — synthesize answer using LLM
    yield {
        "type": "thought",
        "content": "Synthesizing answer using grounded prompt and retrieved document context..."
    }

    chain = prompt | llm | StrOutputParser()

    full_answer_chunks = []
    try:
        stream = chain.stream({
            "context": context,
            "question": question,
            "history": format_history(history),
        })
        for chunk in stream:
            full_answer_chunks.append(chunk)
            yield {"type": "token", "content": chunk}
    except Exception as e:
        print(f"Error during LLM streaming: {e}")
        try:
            # One non-streaming retry — some providers fail only on SSE.
            answer_text = chain.invoke({
                "context": context,
                "question": question,
                "history": format_history(history),
            })
            full_answer_chunks.append(answer_text)
            yield {"type": "token", "content": answer_text}
        except Exception as retry_err:
            # This retry used to be unguarded, so a provider outage propagated
            # out of the generator, tore down the SSE connection mid-response,
            # and surfaced in the browser as a bare "network error".
            print(f"LLM retry also failed: {retry_err}")
            err_text = describe_llm_failure(retry_err)
            for token in err_text:
                yield {"type": "token", "content": token}
            yield {
                "type": "final",
                "answer": err_text,
                "citations": [],
                "confidence": 0.0,
                "source_type": "none",
                "error": True,
            }
            return

    raw_answer = "".join(full_answer_chunks)
    cleaned_ans = clean_answer(raw_answer)
    used = _cited_indices(cleaned_ans)
    citations = [c for c in citations if c.index in used]

    # A refusal is not an answer "from the conversation" — labelling it that way
    # produced the contradictory "Answered from earlier in this conversation"
    # banner sitting directly above "Sorry, I don't know based on the context."
    refused = any(t in cleaned_ans.lower() for t in _FALLBACK_TRIGGERS)
    if refused:
        source_type = "none"
        confidence = 0.0
    elif citations:
        source_type = "documents"
    else:
        source_type = "conversation" if history else "none"
        confidence = 0.0

    yield {
        "type": "final",
        "answer": cleaned_ans,
        "citations": [asdict(c) for c in citations],
        "confidence": confidence,
        "source_type": source_type,
    }
