/**
 * Central API client.
 *
 * The base URL used to be hardcoded as http://localhost:8000 in ~20 places,
 * which made the app impossible to deploy. Set NEXT_PUBLIC_API_URL to point at
 * a real backend; it falls back to localhost for development.
 */

export const API_BASE =
    process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "") || "http://localhost:8000";

export function apiUrl(path: string): string {
    if (path.startsWith("http://") || path.startsWith("https://")) {
        return path;
    }
    return `${API_BASE}${path.startsWith("/") ? path : `/${path}`}`;
}

export function getToken(): string | null {
    if (typeof window === "undefined") return null;
    return localStorage.getItem("token");
}

export function clearSession(): void {
    if (typeof window === "undefined") return;
    localStorage.removeItem("token");
    localStorage.removeItem("role");
    localStorage.removeItem("username");
}

export class UnauthorizedError extends Error {
    constructor() {
        super("Unauthorized");
        this.name = "UnauthorizedError";
    }
}

type ApiOptions = RequestInit & {
    /** Redirect to /login on a 401 instead of throwing. Defaults to true. */
    redirectOnUnauthorized?: boolean;
};

/**
 * fetch() wrapper that attaches the bearer token, surfaces backend `detail`
 * messages as real errors, and centralises 401 handling.
 */
export async function apiFetch(path: string, options: ApiOptions = {}): Promise<Response> {
    const { redirectOnUnauthorized = true, headers, ...rest } = options;

    const token = getToken();
    const finalHeaders = new Headers(headers);
    if (token) finalHeaders.set("Authorization", `Bearer ${token}`);

    const res = await fetch(apiUrl(path), { ...rest, headers: finalHeaders });

    if (res.status === 401) {
        clearSession();
        if (redirectOnUnauthorized && typeof window !== "undefined") {
            window.location.href = "/login";
        }
        throw new UnauthorizedError();
    }

    return res;
}

/** apiFetch + JSON parsing + error-detail extraction. */
export async function apiJson<T = unknown>(path: string, options: ApiOptions = {}): Promise<T> {
    const isJsonBody = options.body !== undefined && !(options.body instanceof FormData);
    const headers = new Headers(options.headers);
    if (isJsonBody && !headers.has("Content-Type")) {
        headers.set("Content-Type", "application/json");
    }

    const res = await apiFetch(path, { ...options, headers });

    if (!res.ok) {
        let detail = `Request failed (${res.status})`;
        try {
            const body = await res.json();
            if (body?.detail) detail = body.detail;
        } catch {
            /* non-JSON error body */
        }
        throw new Error(detail);
    }

    if (res.status === 204) return undefined as T;
    return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Shared response types
// ---------------------------------------------------------------------------

export type Citation = {
    index: number;
    document: string;
    page: number | null;
    snippet: string;
    score: number;
    doc_id: number | null;
    url: string | null;
};

export type VerifiedClaim = {
    claim: string;
    status: "SUPPORTED" | "CONTRADICTED" | "UNVERIFIED_HALLUCINATED";
    confidence: number;
    reasoning: string;
    citations: number[];
};

export type SourceType = "documents" | "web" | "hybrid" | "conversation" | "none";

export type AskResponse = {
    question: string;
    message_id: number;
    answer: string;
    citations: Citation[];
    confidence: number;
    source_type: SourceType;
    claims_verification?: VerifiedClaim[];
    overall_trust_score?: number;
};
