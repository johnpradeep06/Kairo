import os
import json
import shutil
import hashlib
import logging
import secrets
from typing import Annotated, Optional
from fastapi import FastAPI, Depends, HTTPException, status, UploadFile, File, BackgroundTasks, Response
from fastapi.responses import StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy.orm import Session
from sqlalchemy import func
from pydantic import BaseModel

from database import (
    engine, Base, get_db, SessionLocal, run_migrations,
    User, ChatSession, ChatMessage, FAQRule, FailedRetrieval,
    Document, MessageFeedback, AuditLog,
)
from datetime import datetime
from auth import (
    get_password_hash,
    verify_password,
    create_access_token,
    get_current_user,
    get_current_admin_user,
    ACCESS_TOKEN_EXPIRE_MINUTES,
    timedelta
)
from rag_pipeline import (
    rag_answer, ingest_document, delete_document_chunks, serialize_citations,
    generate_follow_ups, run_agentic_rag_stream, describe_llm_failure,
)
from multi_agent_pipeline import run_multi_agent_pipeline_stream
from graph_router import router as graph_router

# Create Tables, then patch in any newly added columns on existing DBs
Base.metadata.create_all(bind=engine)
run_migrations()

# Configure logging
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger(__name__)

app = FastAPI(
    title="Kairo - Compliance Knowledge Graph API",
    description="Backend Graph RAG API for Kairo Enterprise Compliance",
    version="2.1.0",
)

# Universal CORS middleware configuration
# allow_origin_regex=r".*" dynamically reflects the requesting origin (e.g., https://valar-mu.vercel.app)
# allowing all frontend origins and Vercel preview URLs while supporting credentials.
raw_origins = os.getenv("ALLOWED_ORIGINS", "").split(",")
env_origins = [o.strip() for o in raw_origins if o.strip()]
default_origins = ["http://localhost:3000", "http://localhost:3001", "https://valar-mu.vercel.app"]
allowed_origins_list = list(set(default_origins + env_origins))

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins_list,
    allow_origin_regex=r".*",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(graph_router)

@app.options("/{full_path:path}")
async def options_route(full_path: str):
    return Response(status_code=200)

MAX_UPLOAD_BYTES = int(os.getenv("MAX_UPLOAD_MB", "50")) * 1024 * 1024

# -------------------------
# Helpers
# -------------------------

def safe_filename(filename: str) -> str:
    """Strip any directory component from a user-supplied filename.

    `os.path.join(UPLOAD_DIR, "../../app.py")` escapes the upload directory,
    which turned upload into arbitrary file write and delete into arbitrary
    file removal.
    """
    name = os.path.basename(filename.replace("\\", "/")).strip()
    if not name or name in {".", ".."}:
        raise HTTPException(status_code=400, detail="Invalid filename.")
    return name


def write_audit(
    db: Session,
    user: Optional[User],
    action: str,
    *,
    query_text: str | None = None,
    answer_preview: str | None = None,
    confidence: float | None = None,
    source_type: str | None = None,
    detail: str | None = None,
) -> None:
    """Append-only audit trail. Never let a logging failure break the request."""
    try:
        db.add(AuditLog(
            user_id=user.id if user else None,
            username=user.username if user else None,
            action=action,
            query_text=query_text,
            answer_preview=(answer_preview or "")[:500] or None,
            confidence=confidence,
            source_type=source_type,
            detail=detail,
        ))
        db.commit()
    except Exception as e:
        db.rollback()
        logger.warning("[audit] failed to record %s: %s", action, e)


def sha256_of(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


# -------------------------
# Schemas
# -------------------------

class UserCreate(BaseModel):
    username: str
    password: str
    role: str = "technician"  # default to technician
    setup_token: str | None = None  # first-run bootstrap only, see /register_admin

class Token(BaseModel):
    access_token: str
    token_type: str

class QueryRequest(BaseModel):
    question: str

class CitationResponse(BaseModel):
    index: int
    document: str
    page: int | None = None
    snippet: str = ""
    score: float = 0.0
    doc_id: int | None = None
    url: str | None = None

class ChatMessageResponse(BaseModel):
    id: int
    role: str
    content: str
    created_at: datetime
    citations: list[CitationResponse] = []
    confidence: float | None = None
    source_type: str | None = None
    claims_verification: list[dict] = []
    overall_trust_score: float | None = None

    model_config = {"from_attributes": True}

class ChatSessionResponse(BaseModel):
    id: int
    title: str
    created_at: datetime

    model_config = {"from_attributes": True}

class FeedbackCreate(BaseModel):
    rating: str          # "helpful" | "not_helpful"
    comment: str | None = None

class DocumentResponse(BaseModel):
    id: int
    filename: str
    size: int
    status: str
    chunk_count: int
    error_detail: str | None = None
    uploaded_at: str

class AnalyticsGapItem(BaseModel):
    query_text: str
    failure_count: int
    highest_score: float
    created_at: str

class AnalyticsGapsResponse(BaseModel):
    failed_rate: str
    total_failed: int
    gaps: list[AnalyticsGapItem]

class FAQRuleCreate(BaseModel):
    keyword: str
    response: str
    is_active: bool = True

class FAQRuleResponse(BaseModel):
    id: int
    keyword: str
    response: str
    is_active: bool
    created_at: datetime
    
    model_config = {"from_attributes": True}


def message_to_response(msg: ChatMessage) -> dict:
    """Decode the stored citation and verification JSON for the API layer."""
    citations = []
    if msg.citations:
        try:
            citations = json.loads(msg.citations)
        except (ValueError, TypeError):
            citations = []

    claims_verification = []
    if getattr(msg, "claims_verification", None):
        try:
            claims_verification = json.loads(msg.claims_verification)
        except (ValueError, TypeError):
            claims_verification = []

    return {
        "id": msg.id,
        "role": msg.role,
        "content": msg.content,
        "created_at": msg.created_at,
        "citations": citations,
        "confidence": msg.confidence,
        "source_type": msg.source_type,
        "claims_verification": claims_verification,
        "overall_trust_score": getattr(msg, "overall_trust_score", None),
    }


# -------------------------
# Auth Endpoints
# -------------------------

@app.post("/register", status_code=status.HTTP_201_CREATED)
def register(user: UserCreate, db: Session = Depends(get_db)):
    db_user = db.query(User).filter(User.username == user.username).first()
    if db_user:
        raise HTTPException(status_code=400, detail="Username already registered")

    hashed_password = get_password_hash(user.password)
    new_user = User(
        username=user.username,
        hashed_password=hashed_password,
        role=user.role if user.role in {"technician", "manager"} else "technician"
    )
    db.add(new_user)
    db.commit()
    return {"message": "User created successfully"}


@app.post("/register_admin", status_code=status.HTTP_201_CREATED)
def register_admin(
    user: UserCreate,
    db: Session = Depends(get_db),
):
    """Create a manager account.

    This endpoint used to be completely unauthenticated — anyone who could
    reach the API could mint themselves a manager. It now requires either an
    existing manager's token or, for first-run bootstrap only, the
    ADMIN_SETUP_TOKEN when no manager exists yet.
    """
    existing_managers = db.query(User).filter(User.role == "manager").count()

    if existing_managers > 0:
        raise HTTPException(
            status_code=403,
            detail="A manager account already exists. Ask an existing manager to create additional admin users via /admin/users.",
        )

    setup_token = os.getenv("ADMIN_SETUP_TOKEN")
    if not setup_token:
        raise HTTPException(
            status_code=403,
            detail="Admin bootstrap is disabled. Set ADMIN_SETUP_TOKEN in the backend environment to create the first manager.",
        )

    if not user.setup_token or not secrets.compare_digest(user.setup_token, setup_token):
        raise HTTPException(status_code=403, detail="Invalid admin setup token.")

    if db.query(User).filter(User.username == user.username).first():
        raise HTTPException(status_code=400, detail="Username already registered")

    new_user = User(
        username=user.username,
        hashed_password=get_password_hash(user.password),
        role="manager",
    )
    db.add(new_user)
    db.commit()
    logger.info("[auth] bootstrap manager account created: %s", user.username)
    return {"message": "Admin user created successfully"}


@app.post("/admin/users", status_code=status.HTTP_201_CREATED)
def create_user_as_admin(
    user: UserCreate,
    current_user: User = Depends(get_current_admin_user),
    db: Session = Depends(get_db),
):
    """Managers can provision further accounts of either role."""
    if user.role not in {"technician", "manager"}:
        raise HTTPException(status_code=400, detail="Role must be 'technician' or 'manager'.")
    if db.query(User).filter(User.username == user.username).first():
        raise HTTPException(status_code=400, detail="Username already registered")

    new_user = User(
        username=user.username,
        hashed_password=get_password_hash(user.password),
        role=user.role,
    )
    db.add(new_user)
    db.commit()
    write_audit(db, current_user, "create_user", detail=f"{user.username} as {user.role}")
    return {"message": f"User '{user.username}' created with role '{user.role}'."}


@app.post("/token", response_model=Token)
def login_for_access_token(
    form_data: Annotated[OAuth2PasswordRequestForm, Depends()],
    db: Session = Depends(get_db)
):
    user = db.query(User).filter(User.username == form_data.username).first()
    if not user or not verify_password(form_data.password, user.hashed_password):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect username or password",
            headers={"WWW-Authenticate": "Bearer"},
        )

    access_token_expires = timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    access_token = create_access_token(
        data={"sub": user.username, "role": user.role},
        expires_delta=access_token_expires
    )
    write_audit(db, user, "login")
    return {"access_token": access_token, "token_type": "bearer"}


@app.get("/users/me")
def read_users_me(current_user: User = Depends(get_current_user)):
    return {
        "username": current_user.username,
        "role": current_user.role
    }


# -------------------------
# File Upload (Admin Only)
# -------------------------

UPLOAD_DIR = os.getenv("UPLOAD_DIRECTORY", "uploaded_files")
os.makedirs(UPLOAD_DIR, exist_ok=True)

ALLOWED_EXTENSIONS = {".pdf", ".txt", ".docx"}


@app.on_event("startup")
def backfill_documents() -> None:
    """Adopt files uploaded before the Document table existed.

    They were already ingested under the old flow, so their chunks are in
    Chroma keyed by `source` path — delete_document_chunks falls back to that.
    """
    db = SessionLocal()
    try:
        if not os.path.isdir(UPLOAD_DIR):
            return

        known = {d.filename for d in db.query(Document.filename).all()}
        adopted = 0

        for filename in os.listdir(UPLOAD_DIR):
            path = os.path.join(UPLOAD_DIR, filename)
            if not os.path.isfile(path) or filename in known:
                continue

            db.add(Document(
                filename=filename,
                stored_path=path,
                content_hash=sha256_of(path),
                size_bytes=os.path.getsize(path),
                status="indexed",
                uploaded_at=datetime.fromtimestamp(os.path.getmtime(path)),
                indexed_at=datetime.fromtimestamp(os.path.getmtime(path)),
            ))
            adopted += 1

        if adopted:
            db.commit()
            logger.info("[startup] adopted %d pre-existing document(s) into the Document table", adopted)
    except Exception as e:
        db.rollback()
        logger.warning("[startup] document backfill skipped: %s", e)
    finally:
        db.close()


def update_doc_status(db: Session, doc_id: int, status: str, *, error_detail: str | None = None, chunk_count: int | None = None):
    """Safely update Document status, committing changes so UI polling sees state transitions."""
    try:
        doc = db.query(Document).filter(Document.id == doc_id).first()
        if doc:
            doc.status = status
            if error_detail is not None:
                doc.error_detail = error_detail
            if chunk_count is not None:
                doc.chunk_count = chunk_count
            if status == "indexed":
                doc.indexed_at = datetime.utcnow()
            db.commit()
            logger.info("[ingest-stage] Doc %d -> STATUS: %s", doc_id, status)
    except Exception as err:
        db.rollback()
        logger.error("[ingest-stage] Could not update status %s for doc %d: %s", status, doc_id, err)


def _do_ingest(doc_id: int, file_location: str) -> None:
    """Background ingestion with strict state transitions and progress logging:
    UPLOADED -> PARSING -> EXTRACTING -> GRAPH_BUILDING -> INDEXING -> INDEXED (or FAILED)
    """
    db = SessionLocal()
    try:
        logger.info("[ingest 1/5] UPLOADED — Starting background ingestion for doc %d", doc_id)
        update_doc_status(db, doc_id, "PARSING")

        # Stage 2 & 3: PARSING & EXTRACTING (Vector Store Chunks)
        logger.info("[ingest 2/5] PARSING & EXTRACTING — Generating vector embeddings...")
        update_doc_status(db, doc_id, "EXTRACTING")
        chunk_count = ingest_document(file_location, doc_id=doc_id)

        # Stage 4: GRAPH_BUILDING (Entity Resolution & Knowledge Graph Synthesis)
        update_doc_status(db, doc_id, "GRAPH_BUILDING")
        logger.info("[ingest 3/5] GRAPH_BUILDING — Extracting compliance entities & building Neo4j graph...")
        try:
            from graph_service import graph_service
            graph_service.process_document_for_graph(file_location, doc_id=doc_id)
        except Exception as kg_err:
            logger.error("[ingest 3/5] GRAPH_BUILDING note for doc %d: %s", doc_id, kg_err, exc_info=True)

        # Stage 5: INDEXING & INDEXED
        update_doc_status(db, doc_id, "INDEXING")
        logger.info("[ingest 4/5] INDEXING — Finalizing index metadata...")
        update_doc_status(db, doc_id, "indexed", chunk_count=chunk_count)
        logger.info("[ingest 5/5] SUCCESS — Doc %d fully indexed with %d chunks!", doc_id, chunk_count)

    except Exception as e:
        logger.error("[ingest] FAILED for doc %d: %s", doc_id, e, exc_info=True)
        update_doc_status(db, doc_id, "error", error_detail=str(e)[:1000])
        if os.path.exists(file_location):
            try:
                os.remove(file_location)
            except Exception:
                pass
    finally:
        db.close()


@app.post("/upload", status_code=status.HTTP_202_ACCEPTED)
def upload_file(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Accept a document, then index it in the background.

    Returns 202 with a document id the client polls for status.
    """
    filename = safe_filename(file.filename or "")
    ext = os.path.splitext(filename)[1].lower()

    if ext == ".doc":
        raise HTTPException(
            status_code=400,
            detail="Legacy .doc format requires system-level dependencies (antiword/LibreOffice) to parse. Please convert the file to .docx or .pdf before uploading."
        )
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported file type '{ext}'. Allowed: PDF, TXT, DOCX."
        )

    file_location = os.path.join(UPLOAD_DIR, filename)
    with open(file_location, "wb") as buffer:
        shutil.copyfileobj(file.file, buffer)

    size = os.path.getsize(file_location)
    if size > MAX_UPLOAD_BYTES:
        os.remove(file_location)
        raise HTTPException(
            status_code=413,
            detail=f"File is {size / 1024 / 1024:.1f} MB; the limit is {MAX_UPLOAD_BYTES // 1024 // 1024} MB.",
        )

    content_hash = sha256_of(file_location)

    # Replacing an existing document or content hash: clear old vectors and graph relationships
    previous = db.query(Document).filter(
        (Document.filename == filename) | (Document.content_hash == content_hash)
    ).first()
    if previous:
        try:
            delete_document_chunks(previous.stored_path, doc_id=previous.id)
            from graph_service import graph_service
            graph_service.delete_document_graph(previous.id)
        except Exception as e:
            logger.warning("[upload] could not purge previous chunks/graph for %s: %s", filename, e)
        db.delete(previous)
        db.commit()

    doc = Document(
        filename=filename,
        stored_path=file_location,
        content_hash=content_hash,
        size_bytes=size,
        status="queued",
        uploaded_by=current_user.id,
    )
    db.add(doc)
    db.commit()
    db.refresh(doc)

    background_tasks.add_task(_do_ingest, doc.id, file_location)
    write_audit(db, current_user, "upload", detail=f"{filename} ({size} bytes)")

    return {
        "id": doc.id,
        "filename": filename,
        "status": "queued",
        "message": "Upload received. Indexing has started in the background.",
    }


@app.get("/files", response_model=list[DocumentResponse])
def list_files(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """List the corpus from the Document table, which unlike os.listdir()
    knows each file's indexing status and chunk count."""
    docs = db.query(Document).order_by(Document.uploaded_at.desc()).all()
    return [
        DocumentResponse(
            id=d.id,
            filename=d.filename,
            size=d.size_bytes or 0,
            status=d.status,
            chunk_count=d.chunk_count or 0,
            error_detail=d.error_detail,
            uploaded_at=(d.uploaded_at or datetime.utcnow()).isoformat(),
        )
        for d in docs
    ]


@app.get("/files/{doc_id}/status")
def get_document_status(
    doc_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    doc = db.query(Document).filter(Document.id == doc_id).first()
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")
    return {
        "id": doc.id,
        "filename": doc.filename,
        "status": doc.status,
        "chunk_count": doc.chunk_count or 0,
        "detail": doc.error_detail,
    }


@app.delete("/files/{filename}", status_code=status.HTTP_200_OK)
def delete_file(
    filename: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Delete an uploaded document: purge its embeddings, drop its row, and
    remove the file from disk."""
    filename = safe_filename(filename)
    file_location = os.path.join(UPLOAD_DIR, filename)

    doc = db.query(Document).filter(Document.filename == filename).first()

    if not doc and not os.path.exists(file_location):
        raise HTTPException(status_code=404, detail=f"File '{filename}' not found.")

    try:
        removed = delete_document_chunks(
            doc.stored_path if doc else file_location,
            doc_id=doc.id if doc else None,
        )
        if doc:
            try:
                from graph_service import graph_service
                graph_service.delete_document_graph(doc.id)
            except Exception as kg_err:
                logger.warning("[delete] Knowledge Graph deletion note: %s", kg_err)
        logger.info("[delete] purged %d embeddings for %s", removed, filename)
    except Exception as e:
        logger.error("[delete] Failed to purge embeddings: %s", e)
        raise HTTPException(status_code=500, detail=f"Failed to remove vector embeddings: {str(e)}")

    if doc:
        db.delete(doc)
        db.commit()

    try:
        if os.path.exists(file_location):
            os.remove(file_location)
    except Exception as e:
        logger.error("[delete] Failed to remove file from disk: %s", e)
        raise HTTPException(status_code=500, detail=f"Could not delete file from disk: {str(e)}")

    write_audit(db, current_user, "delete", detail=filename)
    return {"filename": filename, "status": "deleted"}


# -------------------------
# Re-index Endpoint (Admin Only)
# -------------------------

def _do_reindex(doc_id: int, file_location: str) -> None:
    """Background task: remove old embeddings then re-ingest the document."""
    db = SessionLocal()
    try:
        doc = db.query(Document).filter(Document.id == doc_id).first()
        if not doc:
            return

        doc.status = "processing"
        db.commit()
        logger.info("[Re-index] START — %s", doc.filename)

        try:
            removed = delete_document_chunks(file_location, doc_id=doc_id)
            logger.info("[Re-index] Removed %d old chunks for %s", removed, doc.filename)
        except Exception as del_err:
            logger.warning("[Re-index] Could not remove old chunks (non-fatal): %s", del_err)

        chunk_count = ingest_document(file_location, doc_id=doc_id)

        doc.chunk_count = chunk_count
        doc.status = "indexed"
        doc.indexed_at = datetime.utcnow()
        doc.error_detail = None
        db.commit()
        logger.info("[Re-index] DONE — %s (%d chunks)", doc.filename, chunk_count)
    except Exception as e:
        logger.error("[Re-index] FAILED — doc %s — %s", doc_id, e)
        try:
            doc = db.query(Document).filter(Document.id == doc_id).first()
            if doc:
                doc.status = "error"
                doc.error_detail = str(e)[:1000]
                db.commit()
        except Exception:
            db.rollback()
    finally:
        db.close()


@app.post("/reindex/{filename}")
def reindex_document(
    filename: str,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_admin_user),
    db: Session = Depends(get_db),
):
    filename = safe_filename(filename)
    file_location = os.path.join(UPLOAD_DIR, filename)
    if not os.path.exists(file_location):
        raise HTTPException(status_code=404, detail=f"File '{filename}' not found on disk.")

    doc = db.query(Document).filter(Document.filename == filename).first()
    if not doc:
        # File on disk with no DB row (uploaded before this table existed)
        doc = Document(
            filename=filename,
            stored_path=file_location,
            content_hash=sha256_of(file_location),
            size_bytes=os.path.getsize(file_location),
            status="queued",
            uploaded_by=current_user.id,
        )
        db.add(doc)
        db.commit()
        db.refresh(doc)

    if doc.status == "processing":
        raise HTTPException(status_code=409, detail="Re-index already in progress for this file.")

    doc.status = "queued"
    db.commit()

    background_tasks.add_task(_do_reindex, doc.id, file_location)
    write_audit(db, current_user, "reindex", detail=filename)
    logger.info("[Re-index] Queued background task for %s", filename)
    return {"id": doc.id, "filename": filename, "status": "queued", "message": "Re-indexing started in the background."}


@app.get("/reindex/{filename}/status")
def get_reindex_status(
    filename: str,
    current_user: User = Depends(get_current_admin_user),
    db: Session = Depends(get_db),
):
    filename = safe_filename(filename)
    doc = db.query(Document).filter(Document.filename == filename).first()
    if not doc:
        return {"filename": filename, "status": "idle"}

    if doc.status in {"queued", "processing"}:
        return {"filename": filename, "status": "running"}
    if doc.status == "indexed":
        return {"filename": filename, "status": "done", "chunk_count": doc.chunk_count}
    return {"filename": filename, "status": "error", "detail": doc.error_detail or "Unknown error"}


# -------------------------
# RAG Endpoint
# -------------------------

@app.post("/ask")
def ask_rag_deprecated(
    query: QueryRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    result = rag_answer(query.question, db)
    write_audit(
        db, current_user, "query",
        query_text=query.question,
        answer_preview=result.answer,
        confidence=result.confidence,
        source_type=result.source_type,
    )
    return {"question": query.question, **result.to_dict()}


# -------------------------
# Chat Session Endpoints
# -------------------------

@app.get("/sessions", response_model=list[ChatSessionResponse])
def get_sessions(
    search: str = None,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    query = db.query(ChatSession).filter(ChatSession.user_id == current_user.id)
    if search:
        search_term = f"%{search}%"
        query = query.outerjoin(ChatMessage).filter(
            (ChatSession.title.ilike(search_term)) |
            (ChatMessage.content.ilike(search_term))
        ).distinct()
    sessions = query.order_by(ChatSession.created_at.desc()).all()
    return sessions


@app.post("/sessions", response_model=ChatSessionResponse)
def create_session(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    new_session = ChatSession(user_id=current_user.id, title="New Chat")
    db.add(new_session)
    db.commit()
    db.refresh(new_session)
    return new_session


@app.get("/sessions/{session_id}/messages", response_model=list[ChatMessageResponse])
def get_session_messages(session_id: int, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    session = db.query(ChatSession).filter(ChatSession.id == session_id, ChatSession.user_id == current_user.id).first()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    return [message_to_response(m) for m in session.messages]


@app.post("/sessions/{session_id}/ask")
def ask_rag_session(
    session_id: int,
    query: QueryRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    session = db.query(ChatSession).filter(ChatSession.id == session_id, ChatSession.user_id == current_user.id).first()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    if session.title == "New Chat":
        session.title = query.question[:30] + ("..." if len(query.question) > 30 else "")
        db.commit()

    # Prior turns, oldest first — this is what makes follow-up questions work.
    history = [
        {"role": m.role, "content": m.content}
        for m in session.messages
    ]

    user_msg = ChatMessage(session_id=session.id, role="user", content=query.question)
    db.add(user_msg)
    db.commit()

    try:
        result = rag_answer(query.question, db, history=history)
    except Exception as e:
        logger.exception("[ask] RAG failure")
        raise HTTPException(status_code=500, detail=f"Error generating response: {str(e)}")

    asst_msg = ChatMessage(
        session_id=session.id,
        role="assistant",
        content=result.answer,
        citations=serialize_citations(result.citations),
        confidence=result.confidence,
        source_type=result.source_type,
    )
    db.add(asst_msg)
    db.commit()
    db.refresh(asst_msg)

    write_audit(
        db, current_user, "query",
        query_text=query.question,
        answer_preview=result.answer,
        confidence=result.confidence,
        source_type=result.source_type,
        detail=f"session={session.id}",
    )

    return {
        "question": query.question,
        "message_id": asst_msg.id,
        **result.to_dict(),
    }


@app.post("/sessions/{session_id}/ask/stream")
def ask_rag_session_stream(
    session_id: int,
    query: QueryRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    session = db.query(ChatSession).filter(ChatSession.id == session_id, ChatSession.user_id == current_user.id).first()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    if session.title == "New Chat":
        session.title = query.question[:30] + ("..." if len(query.question) > 30 else "")
        db.commit()

    history = [
        {"role": m.role, "content": m.content}
        for m in session.messages
    ]

    user_msg = ChatMessage(session_id=session.id, role="user", content=query.question)
    db.add(user_msg)
    db.commit()

    def persist_final(payload: dict) -> int | None:
        """Save the assistant message and return its id."""
        try:
            save_db = SessionLocal()
            try:
                asst_msg = ChatMessage(
                    session_id=session.id,
                    role="assistant",
                    content=payload.get("answer", ""),
                    citations=json.dumps(payload.get("citations", [])),
                    confidence=payload.get("confidence", 0.0),
                    source_type=payload.get("source_type", "none"),
                    claims_verification=json.dumps(payload.get("claims_verification", [])),
                    overall_trust_score=payload.get("overall_trust_score", 0.0),
                )
                save_db.add(asst_msg)
                save_db.commit()
                save_db.refresh(asst_msg)

                write_audit(
                    save_db, current_user, "query",
                    query_text=query.question,
                    answer_preview=payload.get("answer", ""),
                    confidence=payload.get("confidence", 0.0),
                    source_type=payload.get("source_type", "none"),
                    detail=f"session={session.id}",
                )
                return asst_msg.id
            finally:
                save_db.close()
        except Exception as e:
            logger.exception("[ask/stream] error saving message to DB: %s", e)
            return None

    def sse_event_generator():
        try:
            generator = run_multi_agent_pipeline_stream(query.question, history=history)
            for event in generator:
                if event["type"] == "final":
                    # Persist first, then attach the new row's id to the event.
                    event["message_id"] = persist_final(event)
                yield f"data: {json.dumps(event)}\n\n"
        except Exception as e:
            logger.exception("[ask/stream] pipeline failure")
            failure = {
                "type": "final",
                "answer": describe_llm_failure(e),
                "citations": [],
                "confidence": 0.0,
                "source_type": "none",
                "claims_verification": [],
                "overall_trust_score": 0.0,
                "error": True,
            }
            failure["message_id"] = persist_final(failure)
            yield f"data: {json.dumps(failure)}\n\n"

    return StreamingResponse(sse_event_generator(), media_type="text/event-stream")


@app.delete("/sessions/{session_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_session(session_id: int, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    session = db.query(ChatSession).filter(ChatSession.id == session_id, ChatSession.user_id == current_user.id).first()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    db.delete(session)
    db.commit()
    return


# -------------------------
# Answer Feedback
# -------------------------

@app.get("/messages/{message_id}/followups")
def get_follow_ups(
    message_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Contextual follow-up suggestions for an answer.

    Generated on first request and cached on the message, so this costs one
    small model call per answer and nothing on reload. It is a separate
    endpoint (rather than part of /ask) so the answer renders immediately and
    the chips fill in a beat later.
    """
    msg = (
        db.query(ChatMessage)
        .join(ChatSession, ChatMessage.session_id == ChatSession.id)
        .filter(ChatMessage.id == message_id, ChatSession.user_id == current_user.id)
        .first()
    )
    if not msg:
        raise HTTPException(status_code=404, detail="Message not found")

    if msg.role != "assistant":
        return {"message_id": message_id, "follow_ups": []}

    if msg.follow_ups is not None:
        try:
            return {"message_id": message_id, "follow_ups": json.loads(msg.follow_ups)}
        except (ValueError, TypeError):
            pass  # regenerate on corrupt cache

    # The question that prompted this answer is the preceding user message.
    question = (
        db.query(ChatMessage)
        .filter(
            ChatMessage.session_id == msg.session_id,
            ChatMessage.id < msg.id,
            ChatMessage.role == "user",
        )
        .order_by(ChatMessage.id.desc())
        .first()
    )

    citations = []
    if msg.citations:
        try:
            citations = json.loads(msg.citations)
        except (ValueError, TypeError):
            citations = []

    suggestions = generate_follow_ups(
        question.content if question else "",
        msg.content or "",
        citations,
    )

    msg.follow_ups = json.dumps(suggestions)
    db.commit()

    return {"message_id": message_id, "follow_ups": suggestions}


@app.post("/messages/{message_id}/feedback", status_code=status.HTTP_201_CREATED)
def submit_feedback(
    message_id: int,
    payload: FeedbackCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Record a thumbs up/down. Previously the UI only showed an alert()."""
    if payload.rating not in {"helpful", "not_helpful"}:
        raise HTTPException(status_code=400, detail="rating must be 'helpful' or 'not_helpful'")

    msg = (
        db.query(ChatMessage)
        .join(ChatSession, ChatMessage.session_id == ChatSession.id)
        .filter(ChatMessage.id == message_id, ChatSession.user_id == current_user.id)
        .first()
    )
    if not msg:
        raise HTTPException(status_code=404, detail="Message not found")

    existing = db.query(MessageFeedback).filter(
        MessageFeedback.message_id == message_id,
        MessageFeedback.user_id == current_user.id,
    ).first()

    if existing:
        existing.rating = payload.rating
        existing.comment = payload.comment
        existing.created_at = datetime.utcnow()
    else:
        db.add(MessageFeedback(
            message_id=message_id,
            user_id=current_user.id,
            rating=payload.rating,
            comment=payload.comment,
        ))
    db.commit()

    write_audit(db, current_user, "feedback", detail=f"message={message_id} rating={payload.rating}")
    return {"message_id": message_id, "rating": payload.rating, "status": "recorded"}


# -------------------------
# Analytics & Knowledge Gaps (Admin/Manager Only)
# -------------------------

@app.get("/analytics/gaps", response_model=AnalyticsGapsResponse)
def get_analytics_gaps(
    current_user: User = Depends(get_current_admin_user),
    db: Session = Depends(get_db)
):
    total_queries = db.query(ChatMessage).filter(ChatMessage.role == "user").count()
    total_failed = db.query(FailedRetrieval).count()

    failed_rate = 0.0
    if total_queries > 0:
        failed_rate = (total_failed / total_queries) * 100

    gaps_query = db.query(
        FailedRetrieval.query_text,
        func.count(FailedRetrieval.id).label("failure_count"),
        func.max(FailedRetrieval.highest_score).label("highest_score"),
        func.max(FailedRetrieval.created_at).label("created_at")
    ).group_by(FailedRetrieval.query_text).order_by(func.count(FailedRetrieval.id).desc()).all()

    gaps_list = [
        {
            "query_text": row.query_text,
            "failure_count": row.failure_count,
            "highest_score": row.highest_score if row.highest_score is not None else 0.0,
            "created_at": row.created_at.isoformat() if row.created_at else "",
        }
        for row in gaps_query
    ]

    return {
        "failed_rate": f"{failed_rate:.1f}%",
        "total_failed": total_failed,
        "gaps": gaps_list,
    }


@app.get("/analytics/feedback")
def get_feedback_analytics(
    current_user: User = Depends(get_current_admin_user),
    db: Session = Depends(get_db),
):
    """Aggregate answer quality from real user feedback."""
    helpful = db.query(MessageFeedback).filter(MessageFeedback.rating == "helpful").count()
    not_helpful = db.query(MessageFeedback).filter(MessageFeedback.rating == "not_helpful").count()
    total = helpful + not_helpful

    recent_negative = (
        db.query(MessageFeedback, ChatMessage)
        .join(ChatMessage, MessageFeedback.message_id == ChatMessage.id)
        .filter(MessageFeedback.rating == "not_helpful")
        .order_by(MessageFeedback.created_at.desc())
        .limit(20)
        .all()
    )

    avg_confidence = db.query(func.avg(ChatMessage.confidence)).filter(
        ChatMessage.confidence.isnot(None)
    ).scalar()

    return {
        "helpful": helpful,
        "not_helpful": not_helpful,
        "total": total,
        "satisfaction_rate": f"{(helpful / total * 100):.1f}%" if total else "–",
        "avg_confidence": round(float(avg_confidence), 3) if avg_confidence is not None else None,
        "recent_negative": [
            {
                "message_id": fb.message_id,
                "answer_preview": (msg.content or "")[:200],
                "source_type": msg.source_type,
                "confidence": msg.confidence,
                "comment": fb.comment,
                "created_at": fb.created_at.isoformat() if fb.created_at else "",
            }
            for fb, msg in recent_negative
        ],
    }


@app.get("/analytics/audit")
def get_audit_log(
    limit: int = 100,
    action: str | None = None,
    current_user: User = Depends(get_current_admin_user),
    db: Session = Depends(get_db),
):
    """Read the append-only audit trail."""
    q = db.query(AuditLog)
    if action:
        q = q.filter(AuditLog.action == action)
    rows = q.order_by(AuditLog.created_at.desc()).limit(min(limit, 500)).all()

    return [
        {
            "id": r.id,
            "username": r.username,
            "action": r.action,
            "query_text": r.query_text,
            "answer_preview": r.answer_preview,
            "confidence": r.confidence,
            "source_type": r.source_type,
            "detail": r.detail,
            "created_at": r.created_at.isoformat() if r.created_at else "",
        }
        for r in rows
    ]


_ACTIVITY_ACTION_LABELS = {
    "login": "Login",
    "upload": "Upload",
    "delete": "Delete",
    "reindex": "Re-index",
    "add_faq": "FAQ Added",
    "delete_faq": "FAQ Deleted",
    "query": "Query",
    "feedback": "Feedback",
    "create_user": "User Created",
}


@app.get("/analytics/activity")
def get_activity_log(
    limit: int = 100,
    current_user: User = Depends(get_current_admin_user),
    db: Session = Depends(get_db),
):
    """Same audit trail as /analytics/audit, reshaped to {username, action,
    target, timestamp} for the dashboard's Activity Logs tab, which was built
    against that field naming before /analytics/audit existed."""
    rows = db.query(AuditLog).order_by(AuditLog.created_at.desc()).limit(min(limit, 500)).all()

    result = []
    for r in rows:
        # query_text (the actual question) is more useful here than detail
        # (which for "query" rows is just internal session bookkeeping).
        target = r.query_text or r.detail
        if target and len(target) > 120:
            target = target[:120] + "…"
        result.append({
            "username": r.username or "unknown",
            "action": _ACTIVITY_ACTION_LABELS.get(r.action, r.action.replace("_", " ").title()),
            "target": target,
            "timestamp": r.created_at.isoformat() if r.created_at else "",
        })
    return result


# -------------------------
# FAQ Management (Admin/Manager Only)
# -------------------------

@app.get("/faq", response_model=list[FAQRuleResponse])
def get_faq_rules(
    current_user: User = Depends(get_current_admin_user),
    db: Session = Depends(get_db)
):
    return db.query(FAQRule).all()


@app.post("/faq", response_model=FAQRuleResponse, status_code=status.HTTP_201_CREATED)
def create_faq_rule(
    rule: FAQRuleCreate,
    current_user: User = Depends(get_current_admin_user),
    db: Session = Depends(get_db)
):
    existing = db.query(FAQRule).filter(func.lower(FAQRule.keyword) == func.lower(rule.keyword)).first()
    if existing:
        raise HTTPException(status_code=400, detail="FAQ rule with this keyword already exists")
    db_rule = FAQRule(
        keyword=rule.keyword,
        response=rule.response,
        is_active=rule.is_active
    )
    db.add(db_rule)
    db.commit()
    db.refresh(db_rule)
    write_audit(db, current_user, "add_faq", detail=db_rule.keyword)
    return db_rule


@app.delete("/faq/{id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_faq_rule(
    id: int,
    current_user: User = Depends(get_current_admin_user),
    db: Session = Depends(get_db)
):
    db_rule = db.query(FAQRule).filter(FAQRule.id == id).first()
    if not db_rule:
        raise HTTPException(status_code=404, detail="FAQ rule not found")
    keyword = db_rule.keyword
    db.delete(db_rule)
    db.commit()
    write_audit(db, current_user, "delete_faq", detail=keyword)
    return


@app.get("/")
def health_check():
    return {"status": "RAG service v2 is running"}
