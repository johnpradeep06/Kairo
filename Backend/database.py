import os
from dotenv import load_dotenv
from sqlalchemy import (
    create_engine, Column, Integer, String, Text, ForeignKey, DateTime,
    Boolean, Float, inspect, text,
)
from sqlalchemy.orm import sessionmaker, declarative_base, relationship
from datetime import datetime

load_dotenv()

SQLALCHEMY_DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./users.db")

connect_args = {"check_same_thread": False} if SQLALCHEMY_DATABASE_URL.startswith("sqlite") else {}
engine = create_engine(SQLALCHEMY_DATABASE_URL, connect_args=connect_args)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

Base = declarative_base()

class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    username = Column(String, unique=True, index=True)
    hashed_password = Column(String)
    role = Column(String)  # "technician" or "manager"
    sessions = relationship("ChatSession", back_populates="user", cascade="all, delete-orphan")

class ChatSession(Base):
    __tablename__ = "chat_sessions"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"))
    title = Column(String, default="New Chat")
    created_at = Column(DateTime, default=datetime.utcnow)

    user = relationship("User", back_populates="sessions")
    messages = relationship("ChatMessage", back_populates="session", cascade="all, delete-orphan", order_by="ChatMessage.created_at")

class ChatMessage(Base):
    __tablename__ = "chat_messages"

    id = Column(Integer, primary_key=True, index=True)
    session_id = Column(Integer, ForeignKey("chat_sessions.id"))
    role = Column(String)  # "user" or "assistant"
    content = Column(Text)
    created_at = Column(DateTime, default=datetime.utcnow)

    # Grounding metadata (assistant messages only)
    citations = Column(Text, nullable=True)        # JSON-encoded list[Citation]
    confidence = Column(Float, nullable=True)      # 0.0 - 1.0
    source_type = Column(String, nullable=True)    # "documents" | "web" | "hybrid" | "none"
    follow_ups = Column(Text, nullable=True)       # JSON-encoded list[str]
    claims_verification = Column(Text, nullable=True) # JSON-encoded list[VerifiedClaim]
    overall_trust_score = Column(Float, nullable=True) # 0.0 - 100.0

    session = relationship("ChatSession", back_populates="messages")
    feedback = relationship("MessageFeedback", back_populates="message", cascade="all, delete-orphan")

class FAQRule(Base):
    __tablename__ = "faq_rules"

    id = Column(Integer, primary_key=True, index=True)
    keyword = Column(String, unique=True, index=True)
    response = Column(Text)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, default=datetime.utcnow)

class FailedRetrieval(Base):
    __tablename__ = "failed_retrievals"

    id = Column(Integer, primary_key=True, index=True)
    query_text = Column(String)
    highest_score = Column(Float)
    fallback_triggered = Column(Boolean, default=False)
    created_at = Column(DateTime, default=datetime.utcnow)

class Document(Base):
    """Tracks every ingested source file. Previously the corpus existed only as
    entries in os.listdir(), which meant no status, no owner and no dedupe."""
    __tablename__ = "documents"

    id = Column(Integer, primary_key=True, index=True)
    filename = Column(String, index=True)          # display name
    stored_path = Column(String)                   # path on disk
    content_hash = Column(String, index=True)      # sha256 of file bytes
    size_bytes = Column(Integer, default=0)
    status = Column(String, default="queued")      # queued|processing|indexed|error
    error_detail = Column(Text, nullable=True)
    chunk_count = Column(Integer, default=0)
    uploaded_by = Column(Integer, ForeignKey("users.id"), nullable=True)
    uploaded_at = Column(DateTime, default=datetime.utcnow)
    indexed_at = Column(DateTime, nullable=True)

class MessageFeedback(Base):
    """Thumbs up/down on an assistant answer. Previously these buttons only
    fired an alert() in the browser and were never stored."""
    __tablename__ = "message_feedback"

    id = Column(Integer, primary_key=True, index=True)
    message_id = Column(Integer, ForeignKey("chat_messages.id"), index=True)
    user_id = Column(Integer, ForeignKey("users.id"), index=True)
    rating = Column(String)                        # "helpful" | "not_helpful"
    comment = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    message = relationship("ChatMessage", back_populates="feedback")

class AuditLog(Base):
    """Append-only record of who asked what and how it was answered.
    Regulated environments require this."""
    __tablename__ = "audit_log"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=True, index=True)
    username = Column(String, index=True)
    action = Column(String, index=True)            # query|upload|delete|reindex|feedback
    query_text = Column(Text, nullable=True)
    answer_preview = Column(Text, nullable=True)   # first 500 chars
    confidence = Column(Float, nullable=True)
    source_type = Column(String, nullable=True)
    detail = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, index=True)


# ---------------------------------------------------------------------------
# Lightweight migration
# ---------------------------------------------------------------------------
# create_all() adds new tables but never new columns to existing ones. Users
# upgrading an existing users.db would otherwise hit "no such column" on every
# query. Alembic is the right long-term answer; this keeps existing DBs working.

_ADDED_COLUMNS = {
    "chat_messages": {
        "citations": "TEXT",
        "confidence": "FLOAT",
        "source_type": "VARCHAR",
        "follow_ups": "TEXT",
        "claims_verification": "TEXT",
        "overall_trust_score": "FLOAT",
    },
}

def run_migrations() -> None:
    if not SQLALCHEMY_DATABASE_URL.startswith("sqlite"):
        return  # non-sqlite deployments should use Alembic

    inspector = inspect(engine)
    existing_tables = set(inspector.get_table_names())

    with engine.begin() as conn:
        for table, columns in _ADDED_COLUMNS.items():
            if table not in existing_tables:
                continue
            present = {c["name"] for c in inspector.get_columns(table)}
            for name, sql_type in columns.items():
                if name not in present:
                    conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {name} {sql_type}"))


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
