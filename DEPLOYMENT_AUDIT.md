# Deployment Readiness Audit Report — Valar

This report outlines the deployment readiness, runtime components, storage needs, env configuration, and recommended architectures for moving **Valar** to production.

---

## 1. Project Architecture Diagram

Below is the dynamic visual flow of Valar's data paths:

```
                  +-----------------------------------------+
                  |           Browser (User Client)         |
                  +-----------------------------------------+
                                    │   ▲
                     HTTPS / JWT    │   │  JSON Response / HTML
                                    ▼   │
                  +-----------------------------------------+
                  |         Next.js Web Frontend            |
                  +-----------------------------------------+
                                    │   ▲
                       REST API     │   │  JSON Response / CORs
                                    ▼   │
                  +-----------------------------------------+
                  |            FastAPI Backend              |
                  +-----------------------------------------+
                     │        │                 │        │
      Ingest / Split │        │ Read / Write    │ Query  │ Web Fallback
                     ▼        ▼                 ▼        ▼
       +---------------+  +---------------+  +-------+  +---------------+
       | Local Files   |  | SQLite DB     |  |Chroma |  | External APIs |
       | (.pdf, .txt,  |  | (users.db)    |  |Vector |  | (OpenRouter,  |
       |  .docx)       |  |               |  |Store  |  |  Exa Search)  |
       +---------------+  +---------------+  +-------+  +---------------+
```

---

## 2. Complete Component Inventory

The following elements compose the Valar application context:

| Component | Purpose | Technology | Runs Continuously? | Persistent Storage? | External Dependency? |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Frontend Web App** | Renders Chat UI, escalates support tickets, and displays the Admin Dashboard. | Next.js (TypeScript, Tailwind CSS) | Yes | No (Static client assets) | No |
| **Backend API Server** | Handles RAG querying, user registration, JWT generation, file ingestion, and FAQ caching. | FastAPI (Python 3, Uvicorn) | Yes | No (Stateless execution code) | No |
| **SQLite Database** | Stores user credentials, session history, chat messages, active FAQ rules, and retrieval logs. | SQLite (via SQLAlchemy ORM) | Yes (In-process file access) | **Yes** (`users.db` file) | No |
| **Chroma Vector Store** | Indexes chunked document embeddings and executes cosine similarity searches. | ChromaDB (LangChain Community) | Yes (In-process file access) | **Yes** (`chroma_db/` folder) | No |
| **Document Storage** | Holds raw user uploads for file management and re-indexing. | Local directory | Yes (Local disk) | **Yes** (`uploaded_files/` folder) | No |
| **RAG Settings Configuration** | Holds RAG hyper-parameters (temperature, threshold, top-k, system prompt). | JSON file | No (I/O reading/writing) | **Yes** (`settings.json` file) | No |
| **System Activity Logs** | Records operational auditor logs (logins, settings changes, failed queries). | JSON file | No (I/O appending) | **Yes** (`activity_logs.json` file) | No |
| **OpenRouter API** | Provides embeddings and LLM text generation reasoning. | REST Web Service | No (Outbound API calls) | No | **Yes** (OpenRouter subscription key) |
| **Exa Search API** | Performs live web searches when vector store retrieval fails to cover technical queries. | REST Web Service | No (Outbound API calls) | No | **Yes** (Exa API key) |

---

## 3. Required Services

To launch Valar in a production environment, the following runtimes must be provisioned:
1. **Next.js Runtime Node Server**: Runs the Next.js app (or static HTML/CSS files if fully exported, though app features require a Node server context for routing and API relays).
2. **Python 3.10+ ASGI Runtime Environment**: Runs FastAPI via `uvicorn app:app`.
3. **Persistent Volume Storage Service**: Connects SQLite, Chroma vector store database, upload directories, logs, and settings parameters, ensuring they do not reset on restart.

---

## 4. Environment Variables

Below are the configurations required to boot the RAG backend service:

| Variable Name | Purpose | Required? | Default Value | Usage Location |
| :--- | :--- | :--- | :--- | :--- |
| `OPENROUTER_API_KEY` | Auths connection to OpenRouter to utilize `openai/text-embedding-ada-002` and `openai/gpt-oss-120b` models. | **Yes** | *None* | `rag_pipeline.py` |
| `EXA_API_KEY` | Auths connection to Exa Search API for technical web fallback searches. | **Yes** | *None* | `rag_pipeline.py` |
| `SECRET_KEY` | Signs session JWT authentication tokens securely. | No (Highly Recommended) | `"supersecretkey"` | `auth.py` |
| `LANGCHAIN_TRACING_V2` | Enables LangSmith telemetry. | No | `"true"` | `rag_pipeline.py` |
| `LANGCHAIN_ENDPOINT` | LangSmith API server URL. | No | `"https://api.smith.langchain.com"` | `rag_pipeline.py` |

---

## 5. Storage Requirements

Because Valar operates stateful services in-process (SQLite and Chroma), several paths **must persist** across production deployments. If these directories are ephemeral, restarting the container will wipe all accounts, chats, settings, uploaded files, and search indices.

* **Persistent Files & Folders**:
  - `Backend/users.db` (SQLite Database)
  - `Backend/chroma_db/` (Vector embeddings collection store)
  - `Backend/uploaded_files/` (Uploaded PDFs, TXT, DOCX files)
  - `Backend/settings.json` (Customized RAG settings & System Prompt)
  - `Backend/activity_logs.json` (System operation activity logs)

> [warning]
> Do not deploy the backend on Serverless services like AWS Lambda, Vercel Serverless Functions, or basic Render/Heroku dynos without attaching a **Persistent Volume**. Ephemeral local disks will result in immediate database corruption and data loss.

---

## 6. Critical Deployment Blockers

Before successfully hosting this project on public URLs, the following blockers must be addressed:

1. **Hardcoded API URLs in Frontend**:
   All frontend requests (`fetch` and `XMLHttpRequest`) are hardcoded to `http://localhost:8000`. These must be changed to point to a dynamic backend host URL (e.g. `process.env.NEXT_PUBLIC_API_URL` or relative paths via a proxy configuration).
2. **Hardcoded SQLite & Chroma Directories**:
   SQLite and Chroma directories are hardcoded to path strings (`sqlite:///./users.db` and `./chroma_db`). These should be configurable via environment paths (e.g., `/var/data/users.db`) to reside safely inside mounted network volumes.
3. **CORS Allow All Origins (`*`)**:
   FastAPI CORS setup is configured to allow all origins (`allow_origins=["*"]`). While helpful during testing, this is a security risk in production and should be locked to the specific frontend client domain.
4. **Local File Storage Dependability**:
   The `settings_manager` and `activity_logger` load and save files directly on the local filesystem. If these directories are read-only in production, the backend will fail to boot or throw write exceptions when users save settings or log queries.

---

## 7. Cloud Compatibility Matrix

| Provider | Frontend Compatibility | Backend Compatibility | Storage Compatibility |
| :--- | :--- | :--- | :--- |
| **Vercel** | **Excellent** (Native host for Next.js) | *Poor* (Serverless timeouts limit RAG/parsing execution) | *No* (No local persistence volume) |
| **Render** | **Good** (Node Web Service) | **Good** (Python Web Service) | **Excellent** (Supports mounting persistent disk volumes directly to `/app/Backend/data/`) |
| **Railway** | **Good** (Node App Service) | **Good** (Python App Service) | **Excellent** (Supports Persistent Volumes and mounts) |
| **Fly.io** | **Good** (Docker container deployment) | **Good** (Docker container deployment) | **Excellent** (Fly Volumes support persistent storage mounts) |
| **AWS** | **Excellent** (S3 + CloudFront static export or Amplify Node app) | **Excellent** (ECS Fargate + EFS persistent mount) | **Excellent** (Amazon EFS mounts solve SQLite/Chroma needs) |
| **DigitalOcean** | **Good** (App Platform) | **Good** (Droplet / Docker App Platform) | **Excellent** (Supports App Platform Volumes) |

---

## 8. Recommended Deployment Architecture

To get Valar running in production quickly while respecting its storage requirements, the following setup is recommended:

* **Frontend**: Deploy on **Vercel** as a Next.js web application. Set a build-time environment variable `NEXT_PUBLIC_API_URL` pointing to the Render backend service.
* **Backend API**: Deploy on **Render** (or **Railway**) as a Python Web Service using the `requirements.txt` environment.
* **Database & File Storage**: Attach a **Persistent Disk (10GB+)** to the Render/Railway service and mount it to `/app/Backend/persistent_data`. Update the backend paths for the SQLite connection string, Chroma database directory, uploaded files directory, settings, and activity logs to run inside this persistent path.
* **CORS**: Update FastAPI's origins in `app.py` to only allow requests from the Vercel frontend URL.

---

## 9. Estimated Deployment Difficulty

* **Difficulty: Medium**
* **Rationale**: The RAG pipeline relies on local folder storage for Chroma database files and SQLite records. While this simplifies development, it adds configuration steps to production, requiring the setup of persistent network mounts instead of stateless serverless containers. Adjusting the frontend base URL strings to read dynamically from environment parameters is a prerequisite.
