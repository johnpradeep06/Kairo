# Valar — Autonomous Multi-Agent Research & Fact-Verification System

This document outlines the core features implemented in the Valar ecosystem and the underlying technology stack that powers them.

---

## 🌟 Core Features

### 1. Autonomous Multi-Agent Pipeline
The system utilizes a specialized, 3-tier autonomous agent architecture working in tandem to research, verify, and synthesize information:
* **🔍 Researcher Agent**: Analyzes user prompts and orchestrates information retrieval. It queries the local document vector database and automatically falls back to web searches if the local context is insufficient. It extracts atomic factual claims from the raw data.
* **🛡️ Verification & Hallucination Detector Agent**: Acts as an independent auditor. It cross-references every extracted claim against the raw source text to detect AI hallucinations or contradictions. It categorizes claims into `SUPPORTED`, `CONTRADICTED`, or `UNVERIFIED_HALLUCINATED`.
* **📊 Synthesis & Report Compiler Agent**: Compiles the final, publication-ready markdown report. It seamlessly integrates inline citations and structures the verified claims into a comprehensive Trust Matrix.

### 2. Hybrid RAG (Retrieval-Augmented Generation) Engine
* **Multi-Format Document Parsing**: Supports uploading `.pdf`, `.docx`, and `.txt` files.
* **Semantic Vector Search**: Chunks and embeds documents into a high-dimensional vector space for semantic similarity searches.
* **Exa Web Search Integration**: If the local vector store similarity falls below a configurable threshold, the system autonomously queries the Exa Web Search API to augment its knowledge base.

### 3. Claim Verification Matrix & Trust Index
* **Per-Claim Scoring**: Every synthesized claim is assigned a confidence score (0.0 - 1.0).
* **Visual Status Badges**: UI rendering of 🟢 `Supported`, 🔴 `Contradicted`, and 🟡 `Unverified` badges for transparent AI reasoning.
* **Overall Trust Index**: Calculates a holistic trustworthiness percentage for the entire research report.

### 4. Real-Time Streaming & Agent Tracing
* **Server-Sent Events (SSE)**: Streams agent thoughts, tool executions, and text generation in real-time to the frontend.
* **Agent Trace UI**: An interactive accordion component that lets users peek "under the hood" to see exactly which agent is executing which tool (e.g., Chroma Vector Search, Exa Search Fallback) and what data they are processing.

### 5. Document Corpus Management
* **Upload Dashboard**: A dedicated interface for users to upload, monitor, and manage the knowledge base.
* **Dynamic Re-indexing**: Supports deleting obsolete documents and dynamically re-indexing the Chroma vector store.

### 6. Security, Authentication, & UI
* **Role-based JWT Authentication**: Secure login system with hashed passwords. 
* **Mobile-Responsive Design**: A fluid, app-like experience with a mobile hamburger drawer, responsive matrices, and dark/light mode toggles.
* **Export Capabilities**: Allows users to download conversations and research reports in `.md`, `.txt`, or `.pdf` formats.

---

## 🛠️ Technology Stack

### Frontend Architecture
* **Framework**: [Next.js (React)](https://nextjs.org/) — Used for server-side rendering, routing, and building interactive React components.
* **Styling**: [Tailwind CSS](https://tailwindcss.com/) — Utility-first CSS framework for rapid UI styling, dark mode configuration, and mobile responsiveness.
* **Icons & Typography**: [Lucide React](https://lucide.dev/) for crisp, scalable iconography.
* **Markdown Rendering**: `react-markdown` and `remark-gfm` to securely and accurately render the AI's markdown reports and tables.
* **State Management**: React Hooks (`useState`, `useEffect`, `useCallback`) for managing SSE streams, chat history, and UI toggles.

### Backend Architecture
* **Web Framework**: [FastAPI](https://fastapi.tiangolo.com/) — High-performance Python web framework handling async requests, SSE streaming, and REST endpoints.
* **Server**: [Uvicorn](https://www.uvicorn.org/) — ASGI web server implementation.
* **Database & ORM**: SQLite paired with **SQLAlchemy** for relational data mapping (Users, Chat History, Audit Logs).
* **Data Validation**: **Pydantic** for robust schema validation and API serialization.
* **Authentication**: `python-jose` (JWT) and `passlib[bcrypt]` for secure password hashing and token generation.

### AI, Machine Learning & RAG
* **LLM Orchestration**: [LangChain](https://www.langchain.com/) — Framework for chaining prompts, managing memory, and structuring tool calls.
* **Model Routing**: [OpenRouter API](https://openrouter.ai/) — Used to flexibly route prompts to advanced LLMs (e.g., Gemini, Claude) via LangChain's `ChatOpenAI` wrapper.
* **Vector Database**: [ChromaDB](https://www.trychroma.com/) — Local, high-performance vector store for persisting and querying document embeddings.
* **Embeddings**: `langchain-google-genai` leveraging **Gemini Embeddings** (`gemini-embedding-001`) to convert text chunks into vector representations.
* **Web Search Tooling**: [Exa API](https://exa.ai/) (`exa-py`) — Neural web search engine optimized for AI agents to retrieve high-quality web content.
* **Document Parsers**: `pypdf` (PDF extraction), `python-docx` and `docx2txt` (Word document extraction), and `BeautifulSoup4` (HTML parsing).
