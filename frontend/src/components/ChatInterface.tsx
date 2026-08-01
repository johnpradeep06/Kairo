"use client";

import { useState, useRef, useEffect, useCallback, Children } from "react";
import { Send, Menu, Plus, Bot, Loader2, MessageSquare, X, Globe, Building, HelpCircle, BookOpen, Briefcase, Download, Ticket, ThumbsUp, ThumbsDown, RotateCcw, Copy, Trash2, CheckCircle2, FileText, AlertTriangle, Sparkles, ChevronDown, ShieldCheck, LayoutDashboard } from "lucide-react";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useRouter } from "next/navigation";
import { exportAsMarkdown, exportAsPlainText, exportAsPDF } from "../lib/chatExport";
import { apiFetch, apiJson, type Citation, type SourceType, type AskResponse, type VerifiedClaim } from "../lib/api";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';

function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs));
}

type AgentTraceItem = {
    type: "thought" | "tool_start" | "tool_end" | "reflection" | "verification_audit";
    agent?: string;
    content?: string;
    tool?: string;
    input?: any;
    output?: any;
};

function ClaimVerificationMatrix({ claims, trustScore }: { claims?: VerifiedClaim[]; trustScore?: number | null }) {
    if (!claims || claims.length === 0) return null;

    return (
        <div className="mt-5 p-4 rounded-2xl bg-card-background border border-border-default space-y-3 font-sans text-xs shadow-sm">
            <div className="flex items-center justify-between border-b border-border-default pb-2.5">
                <div className="flex items-center gap-2 font-semibold text-text-primary">
                    <ShieldCheck className="w-4 h-4 text-emerald-500" />
                    <span>Multi-Agent Fact-Verification Audit</span>
                </div>
                {trustScore !== undefined && trustScore !== null && (
                    <span className={cn(
                        "px-2.5 py-1 rounded-full text-xs font-bold font-mono border",
                        trustScore >= 80 ? "bg-emerald-500/10 text-emerald-500 border-emerald-500/30" :
                        trustScore >= 50 ? "bg-amber-500/10 text-amber-500 border-amber-500/30" :
                        "bg-red-500/10 text-red-500 border-red-500/30"
                    )}>
                        {Math.round(trustScore)}% Trust Index
                    </span>
                )}
            </div>

            <div className="space-y-2">
                {claims.map((item, idx) => {
                    const isSupported = item.status === "SUPPORTED";
                    const isContradicted = item.status === "CONTRADICTED";
                    return (
                        <div key={idx} className="p-3 rounded-xl bg-bg-tertiary/60 border border-border-default space-y-1.5">
                            <div className="flex items-start justify-between gap-3">
                                <span className="font-medium text-text-primary leading-snug text-[13px]">
                                    {item.claim}
                                </span>
                                <span className={cn(
                                    "px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider shrink-0",
                                    isSupported ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30" :
                                    isContradicted ? "bg-red-500/15 text-red-600 dark:text-red-400 border border-red-500/30" :
                                    "bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/30"
                                )}>
                                    {isSupported ? "🟢 Supported" : isContradicted ? "🔴 Contradicted" : "🟡 Unverified"}
                                </span>
                            </div>
                            <div className="flex items-center justify-between text-[11px] text-text-secondary pt-0.5">
                                <span>{item.reasoning}</span>
                                <span className="font-mono text-text-secondary/80 font-medium ml-2 shrink-0">
                                    {Math.round(item.confidence * 100)}%
                                </span>
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

function AgentTraceAccordion({ trace, isStreaming, thinkingTime }: { trace?: AgentTraceItem[]; isStreaming?: boolean; thinkingTime?: number }) {
    const [isOpen, setIsOpen] = useState(false);

    if (!trace || trace.length === 0) return null;

    const toolCallsCount = trace.filter(t => t.type === 'tool_start').length;

    const formatToolLabel = (toolName?: string) => {
        switch (toolName) {
            case 'check_canned_faqs': return 'FAQ Router';
            case 'chroma_vector_search': return 'Knowledge Base Search';
            case 'exa_web_search': return 'Exa Web Search';
            default: return toolName || 'Tool Execution';
        }
    };

    return (
        <div className="mb-4 text-xs font-sans">
            <button
                type="button"
                onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setIsOpen((prev) => !prev);
                }}
                className="inline-flex items-center gap-2 py-1.5 pl-2.5 pr-3 rounded-full border border-border-default bg-card-background text-text-secondary hover:text-text-primary hover:border-border-strong transition-colors group cursor-pointer font-medium focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none outline-none"
            >
                <div className="flex items-center gap-1.5">
                    {isStreaming ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin text-accent-text" />
                    ) : (
                        <Sparkles className="w-3.5 h-3.5 text-accent-text" />
                    )}
                    <span className="text-xs tracking-tight font-medium">
                        {isStreaming ? "Multi-Agent Research Pipeline running..." : `Agents executed in ${thinkingTime || 1.8}s`}
                    </span>
                </div>

                {toolCallsCount > 0 && (
                    <span className="text-[10px] text-text-secondary bg-bg-tertiary px-1.5 py-0.5 rounded font-mono font-medium">
                        {toolCallsCount} {toolCallsCount === 1 ? "step" : "steps"}
                    </span>
                )}

                <ChevronDown className={cn("w-3.5 h-3.5 text-text-secondary opacity-60 group-hover:opacity-100 transition-transform duration-200", isOpen && "rotate-180")} />
            </button>

            {isOpen && (
                <div className="mt-2.5 pl-3 border-l-2 border-accent-line dark:border-accent-line space-y-2 text-xs text-text-secondary leading-relaxed">
                    {trace.map((item, idx) => {
                        if (item.type === 'thought') {
                            return (
                                <div key={idx} className="text-text-secondary/90 italic flex items-center gap-1.5">
                                    {item.agent && <span className="font-semibold not-italic font-mono text-[10px] text-accent-text uppercase bg-accent-soft px-1.5 py-0.5 rounded">{item.agent}</span>}
                                    <span>{item.content}</span>
                                </div>
                            );
                        }
                        if (item.type === 'tool_start') {
                            return (
                                <div key={idx} className="flex items-center gap-2 font-mono text-[11px] text-text-primary">
                                    <span className="w-1.5 h-1.5 rounded-full bg-accent shrink-0" />
                                    <span className="font-semibold text-text-primary">{formatToolLabel(item.tool)}</span>
                                    {item.input?.query && (
                                        <span className="text-text-secondary/70 truncate max-w-xs font-normal">
                                            "{item.input.query}"
                                        </span>
                                    )}
                                </div>
                            );
                        }
                        if (item.type === 'tool_end') {
                            if (!item.output) return null;
                            return (
                                <div key={idx} className="text-[11px] text-text-secondary/80 pl-3.5 font-mono">
                                    {item.output.retrieved_chunks !== undefined ? (
                                        <span>Retrieved {item.output.retrieved_chunks} chunk(s) · max score {item.output.highest_similarity_score}</span>
                                    ) : item.output.web_citations_found !== undefined ? (
                                        <span className="text-amber-500 dark:text-amber-400 font-sans">Retrieved {item.output.web_citations_found} web sources</span>
                                    ) : null}
                                </div>
                            );
                        }
                        if (item.type === 'reflection') {
                            return (
                                <div key={idx} className="text-text-secondary text-[11px] pl-3.5 font-sans opacity-85">
                                    {item.content}
                                </div>
                            );
                        }
                        return null;
                    })}
                </div>
            )}
        </div>
    );
}

type Message = {
    id?: number;
    role: "user" | "assistant";
    content: string;
    citations?: Citation[];
    confidence?: number | null;
    source_type?: SourceType | null;
    agent_trace?: AgentTraceItem[];
    claims_verification?: VerifiedClaim[];
    overall_trust_score?: number | null;
    isStreaming?: boolean;
    thinkingTimeSeconds?: number;
};

type ChatSession = {
    id: number;
    title: string;
    created_at: string;
};

type ParsedSource = {
    title: string;
    uri: string;
};

const SUGGESTED_QUERIES = [
    { text: "Research the core principles and architecture of autonomous multi-agent AI networks.", icon: Sparkles, label: "Multi-Agent Systems" },
    { text: "Fact-check claims and audit potential hallucinations in renewable energy storage methods.", icon: ShieldCheck, label: "Fact Verification" },
    { text: "Cross-verify key technical claims against uploaded documents and external research sources.", icon: BookOpen, label: "Document Audit" },
    { text: "Synthesize a citation-backed research report with per-claim confidence scoring.", icon: FileText, label: "Research Synthesis" },
];

const PLACEHOLDERS = [
    "Enter a research topic or claim to verify...",
    "Analyze and fact-check claims regarding...",
    "Cross-verify document findings for...",
    "Run autonomous multi-agent research on..."
];

const FOLLOW_UP_STOP_WORDS = new Set([
    "the", "and", "for", "with", "from", "that", "this", "what", "when", "where", "which",
    "how", "can", "does", "do", "is", "are", "was", "were", "to", "of", "in", "on", "a",
    "an", "by", "at", "or", "as", "it", "be", "about", "please", "show", "tell", "give",
]);

const stripExtension = (value: string) => value.replace(/\.[^/.]+$/, "");

const normalizeLabel = (value: string) =>
    stripExtension(value)
        .replace(/[\-_]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();

const extractKeywords = (value: string, limit = 3) => {
    const words = value
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((word) => word.length > 3 && !FOLLOW_UP_STOP_WORDS.has(word));

    return Array.from(new Set(words)).slice(0, limit);
};

const extractDocumentSections = (content: string) => {
    const sourcesMatch = content.match(/\*\*Sources:\*\*\s*\n([\s\S]+)/);
    const relatedMatch = content.match(/\*\*Related Documents:\*\*\s*\n([\s\S]+)/);

    return {
        sources: parseMarkdownList(sourcesMatch?.[1] || ""),
        relatedDocuments: parsePlainList(relatedMatch?.[1] || ""),
    };
};

const parseMarkdownList = (block: string): ParsedSource[] => {
    const sources: ParsedSource[] = [];
    const sourceRegex = /-\s+\[(.*?)\]\((.*?)\)/g;
    let match;

    while ((match = sourceRegex.exec(block)) !== null) {
        sources.push({ title: match[1], uri: match[2] });
    }

    return sources;
};

const parsePlainList = (block: string) => {
    return block
        .split("\n")
        .map((line) => line.replace(/^[-*]\s*/, "").trim())
        .filter(Boolean);
};

const buildFollowUpSuggestions = (answer: string, userQuestion: string, documentNames: string[]) => {
    const suggestions: string[] = [];
    const primaryDocument = normalizeLabel(documentNames[0] || "");
    const secondaryDocument = normalizeLabel(documentNames[1] || "");
    const questionKeywords = extractKeywords(userQuestion, 2);
    const answerKeywords = extractKeywords(answer, 3);
    const topic = questionKeywords[0] || answerKeywords[0] || "this document";

    if (primaryDocument) {
        suggestions.push(`Summarize the key points from ${primaryDocument}.`);
        suggestions.push(`What actions, requirements, or deadlines are mentioned in ${primaryDocument}?`);
    }

    if (primaryDocument && secondaryDocument) {
        suggestions.push(`Compare the guidance in ${primaryDocument} and ${secondaryDocument}.`);
    } else if (primaryDocument) {
        suggestions.push(`Which part of ${primaryDocument} is most relevant to ${topic}?`);
    }

    if (!suggestions.length) {
        suggestions.push(`What does the uploaded document say about ${topic}?`);
    }

    return Array.from(new Set(suggestions)).slice(0, 3);
};

interface ChatInterfaceProps {
    role?: string | null;
    handleLogout?: () => void;
}

/** Retrieval confidence, banded so a weak match never reads as authoritative. */
function ConfidenceBadge({ value }: { value: number }) {
    const pct = Math.round(value * 100);
    const band =
        value >= 0.7 ? { label: "High confidence", dot: "bg-good", cls: "bg-good-soft text-good" } :
            value >= 0.4 ? { label: "Moderate confidence", dot: "bg-amber-500", cls: "bg-amber-500/10 text-amber-600 dark:text-amber-400" } :
                { label: "Low confidence", dot: "bg-red-500", cls: "bg-red-500/10 text-red-600 dark:text-red-400" };

    return (
        <span
            title={`Retrieval confidence ${pct}% — how strongly the cited documents matched your question.`}
            className={cn("inline-flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide px-2.5 py-1 rounded-full shrink-0", band.cls)}
        >
            <span className={cn("w-[6px] h-[6px] rounded-full", band.dot)} />
            {band.label} · {pct}%
        </span>
    );
}

/** Hostname without the www. prefix, for display. Returns "" for junk input. */
function domainOf(url?: string | null): string {
    if (!url) return "";
    try {
        return new URL(url).hostname.replace(/^www\./, "");
    } catch {
        return "";
    }
}

/**
 * A web result rendered the way a search product renders it: favicon + domain
 * first (that's how people judge trustworthiness), page title beneath.
 * Falls back to a letter tile when the favicon can't be fetched.
 */
function WebSourceCard({
    citation,
    citationKey,
    isActive,
}: {
    citation: Citation;
    citationKey: string;
    isActive: boolean;
}) {
    const [faviconFailed, setFaviconFailed] = useState(false);
    const domain = domainOf(citation.url);
    const initial = (domain || citation.document || "?").charAt(0).toUpperCase();

    return (
        <a
            href={citation.url ?? undefined}
            target="_blank"
            rel="noreferrer"
            data-citation-key={citationKey}
            className={cn(
                "group snap-start shrink-0 w-[220px] sm:w-auto flex flex-col justify-between gap-2",
                "bg-card-background border border-border-default rounded-[14px] px-3.5 py-3 shadow-[var(--shadow-card)]",
                "hover:border-accent transition-[border-color,transform] duration-150 hover:-translate-y-px",
                "focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none outline-none",
                isActive && "citation-active"
            )}
        >
            <div className="flex items-center gap-1.5 min-w-0">
                {domain && !faviconFailed ? (
                    <img
                        src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`}
                        alt=""
                        aria-hidden="true"
                        width={14}
                        height={14}
                        loading="lazy"
                        className="w-3.5 h-3.5 rounded-sm shrink-0"
                        onError={() => setFaviconFailed(true)}
                    />
                ) : (
                    <span
                        aria-hidden="true"
                        className="w-3.5 h-3.5 rounded-sm bg-accent-soft text-accent-text text-[8px] font-bold flex items-center justify-center shrink-0"
                    >
                        {initial}
                    </span>
                )}
                <span className="text-[11px] text-text-secondary truncate flex-1">
                    {domain || "Web source"}
                </span>
                <span className="text-[10px] text-text-secondary/70 tabular-nums shrink-0">
                    {citation.index}
                </span>
            </div>

            <p className="text-[12.5px] font-medium text-text-primary leading-[1.4] line-clamp-2 group-hover:text-accent-text transition-colors">
                {citation.document}
            </p>

            {citation.snippet && (
                <p className="text-[11px] text-text-secondary leading-[1.45] line-clamp-2">
                    {citation.snippet}
                </p>
            )}
        </a>
    );
}

export default function ChatInterface({ role, handleLogout }: ChatInterfaceProps = {}) {
    const [messages, setMessages] = useState<Message[]>([]);
    const [input, setInput] = useState("");
    const [isLoading, setIsLoading] = useState(false);
    const [sidebarOpen, setSidebarOpen] = useState(true);
    const [sessions, setSessions] = useState<ChatSession[]>([]);
    const [currentSessionId, setCurrentSessionId] = useState<number | null>(null);
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const router = useRouter();

    const [currentPlaceholder, setCurrentPlaceholder] = useState("");
    const [placeholderIndex, setPlaceholderIndex] = useState(0);
    const [isDeleting, setIsDeleting] = useState(false);

    // Support Features State (Placeholder UI & LocalStorage mock)
    const [searchQuery, setSearchQuery] = useState("");
    const [isTicketModalOpen, setIsTicketModalOpen] = useState(false);
    const [ticketSubject, setTicketSubject] = useState("");
    const [ticketDescription, setTicketDescription] = useState("");
    const [ticketPriority, setTicketPriority] = useState("Medium");
    const [ticketSuccess, setTicketSuccess] = useState(false);
    const [isExportMenuOpen, setIsExportMenuOpen] = useState(false);
    const [sessionToDelete, setSessionToDelete] = useState<number | null>(null);
    const [toast, setToast] = useState<{ message: string; type: 'info' | 'error' | 'success' } | null>(null);
    const [username, setUsername] = useState("");

    const showToast = (message: string, type: 'info' | 'error' | 'success' = 'info') => {
        setToast({ message, type });
    };

    useEffect(() => {
        const stored = localStorage.getItem("username");
        if (stored) {
            setUsername(stored);
            return;
        }

        const token = localStorage.getItem('token');
        if (!token) {
            return;
        }

        const fetchProfile = async () => {
            try {
                const res = await fetch(`${API_BASE_URL}/users/me`, {
                    headers: { 'Authorization': `Bearer ${token}` }
                });

                if (res.ok) {
                    const data = await res.json();
                    if (data.username) {
                        localStorage.setItem('username', data.username);
                        setUsername(data.username);
                    }
                }
            } catch {
                // Keep the fallback empty state if the profile call fails.
            }
        };

        fetchProfile();
    }, []);

    const profileInitial = (username.trim().charAt(0) || 'U').toUpperCase();
    const latestAssistantMessage = [...messages].reverse().find((message) => message.role === 'assistant');
    const latestUserMessage = [...messages].reverse().find((message) => message.role === 'user');
    const extractedSections = latestAssistantMessage ? extractDocumentSections(latestAssistantMessage.content) : { sources: [], relatedDocuments: [] };
    const followUpSuggestions = latestAssistantMessage
        ? buildFollowUpSuggestions(
            latestAssistantMessage.content,
            latestUserMessage?.content || "",
            extractedSections.relatedDocuments.length > 0
                ? extractedSections.relatedDocuments
                : extractedSections.sources.map((source) => source.title)
        )
        : [];

    const clearConversation = () => {
        setMessages([]);
        setCurrentSessionId(null);
        setInput("");
        setIsExportMenuOpen(false);
        setSessionToDelete(null);
    };

    useEffect(() => {
        if (toast) {
            const timer = setTimeout(() => setToast(null), 3000);
            return () => clearTimeout(timer);
        }
    }, [toast]);

    // message_id -> "helpful" | "not_helpful", so the UI reflects what was saved
    const [feedbackGiven, setFeedbackGiven] = useState<Record<number, string>>({});
    const [copiedIdx, setCopiedIdx] = useState<number | null>(null);

    // Which source card is currently highlighted, keyed "<messageId>:<index>",
    // so clicking an inline [n] marker points at the right card.
    const [activeCitation, setActiveCitation] = useState<string | null>(null);

    const focusCitation = useCallback((messageId: number, index: number) => {
        const key = `${messageId}:${index}`;
        setActiveCitation(key);
        // Defer so the highlight class is applied before we scroll to it.
        requestAnimationFrame(() => {
            document
                .querySelector(`[data-citation-key="${key}"]`)
                ?.scrollIntoView({ behavior: "smooth", block: "nearest" });
        });
        window.setTimeout(() => {
            setActiveCitation((cur) => (cur === key ? null : cur));
        }, 2200);
    }, []);

    // message_id -> generated follow-up questions (cached server-side)
    const [followUps, setFollowUps] = useState<Record<number, string[]>>({});
    const [followUpsLoading, setFollowUpsLoading] = useState<number | null>(null);

    const confirmDeleteSession = async (sessionId: number) => {
        try {
            const res = await apiFetch(`/sessions/${sessionId}`, { method: 'DELETE' });
            if (res.ok) {
                if (currentSessionId === sessionId) {
                    setMessages([]);
                    setCurrentSessionId(null);
                }
                fetchSessions();
                showToast("Conversation deleted successfully", "success");
            } else {
                throw new Error("Failed to delete session");
            }
        } catch (err) {
            console.error(err);
            showToast("Failed to delete this conversation. Please try again.", "error");
        }
    };

    const submitFeedback = async (messageId: number | undefined, rating: "helpful" | "not_helpful") => {
        if (!messageId) return;
        const previous = feedbackGiven[messageId];
        setFeedbackGiven(prev => ({ ...prev, [messageId]: rating }));  // optimistic
        try {
            await apiJson(`/messages/${messageId}/feedback`, {
                method: 'POST',
                body: JSON.stringify({ rating }),
            });
        } catch (err) {
            console.error("Failed to save feedback", err);
            setFeedbackGiven(prev => {
                const next = { ...prev };
                if (previous) next[messageId] = previous;
                else delete next[messageId];
                return next;
            });
        }
    };

    useEffect(() => {
        const timeoutContext = setTimeout(() => {
            const fullText = PLACEHOLDERS[placeholderIndex];

            if (!isDeleting) {
                setCurrentPlaceholder(fullText.substring(0, currentPlaceholder.length + 1));
                if (currentPlaceholder.length === fullText.length) {
                    setTimeout(() => setIsDeleting(true), 1500);
                }
            } else {
                setCurrentPlaceholder(fullText.substring(0, currentPlaceholder.length - 1));
                if (currentPlaceholder.length === 0) {
                    setIsDeleting(false);
                    setPlaceholderIndex((prev) => (prev + 1) % PLACEHOLDERS.length);
                }
            }
        }, isDeleting ? 30 : 50);

        return () => clearTimeout(timeoutContext);
    }, [currentPlaceholder, isDeleting, placeholderIndex]);

    useEffect(() => {
        if (window.innerWidth < 768) {
            setSidebarOpen(false);
        }
    }, []);

    const scrollToBottom = () => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    };

    useEffect(() => {
        scrollToBottom();
    }, [messages]);

    // Fetch follow-ups for the newest answer once it has rendered. Kept out of
    // the /ask response so the answer is never held back waiting on them.
    // `attempted` guarantees one request per message even if it fails —
    // without it, a failing endpoint would be retried on every render.
    const followUpsAttempted = useRef<Set<number>>(new Set());

    useEffect(() => {
        const last = messages[messages.length - 1];
        if (!last || last.role !== "assistant" || !last.id) return;

        const messageId = last.id;
        if (followUpsAttempted.current.has(messageId)) return;
        followUpsAttempted.current.add(messageId);

        setFollowUpsLoading(messageId);
        apiJson<{ follow_ups: string[] }>(`/messages/${messageId}/followups`)
            .then(({ follow_ups }) => setFollowUps(prev => ({ ...prev, [messageId]: follow_ups })))
            .catch(err => {
                console.error("Failed to load follow-ups", err);
                setFollowUps(prev => ({ ...prev, [messageId]: [] }));
            })
            .finally(() => setFollowUpsLoading(curr => (curr === messageId ? null : curr)));
    }, [messages]);

    const [theme, setTheme] = useState<'light' | 'dark'>('dark');

    useEffect(() => {
        const savedTheme = localStorage.getItem('theme') as 'light' | 'dark' || 'dark';
        setTheme(savedTheme);
        if (savedTheme === 'dark') {
            document.documentElement.classList.add('dark');
        } else {
            document.documentElement.classList.remove('dark');
        }
    }, []);

    const toggleTheme = () => {
        const nextTheme = theme === 'dark' ? 'light' : 'dark';
        setTheme(nextTheme);
        localStorage.setItem('theme', nextTheme);
        if (nextTheme === 'dark') {
            document.documentElement.classList.add('dark');
        } else {
            document.documentElement.classList.remove('dark');
        }
    };

    const fetchSessions = async (search?: string) => {
        try {
            let path = '/sessions';
            if (search && search.trim() !== '') {
                path += `?search=${encodeURIComponent(search.trim())}`;
            }
            const data = await apiJson<ChatSession[]>(path);
            setSessions(data);
        } catch (error) {
            console.error("Failed to fetch sessions", error);
        }
    };

    // Debounce conversation search by 300ms
    useEffect(() => {
        const delayDebounce = setTimeout(() => {
            fetchSessions(searchQuery);
        }, 300);
        return () => clearTimeout(delayDebounce);
    }, [searchQuery]);

    const loadSession = async (sessionId: number) => {
        setCurrentSessionId(sessionId);
        setIsLoading(true);
        try {
            const data = await apiJson<Message[]>(`/sessions/${sessionId}/messages`);
            setMessages(data.map((m) => ({
                id: m.id,
                role: m.role,
                content: m.content,
                citations: m.citations ?? [],
                confidence: m.confidence,
                source_type: m.source_type,
            })));
        } catch (error) {
            console.error("Failed to load session", error);
        } finally {
            setIsLoading(false);
            if (window.innerWidth < 768) {
                setSidebarOpen(false);
            }
        }
    };

    useEffect(() => {
        fetchSessions();
    }, []);

    const handleSubmit = async (e?: React.FormEvent, overrideInput?: string) => {
        e?.preventDefault();
        const textToSubmit = overrideInput !== undefined ? overrideInput : input;
        if (!textToSubmit.trim() || isLoading) return;

        const userMessage = textToSubmit.trim();
        setInput("");
        setMessages((prev) => [...prev, { role: "user", content: userMessage }]);
        setIsLoading(true);

        const startTime = Date.now();

        try {
            let activeSessionId = currentSessionId;

            if (!activeSessionId) {
                const newSession = await apiJson<ChatSession>('/sessions', { method: 'POST' });
                activeSessionId = newSession.id;
                setCurrentSessionId(activeSessionId);
            }

            setMessages((prev) => [
                ...prev,
                {
                    role: "assistant",
                    content: "",
                    agent_trace: [],
                    isStreaming: true,
                    thinkingTimeSeconds: 0,
                    source_type: "none",
                },
            ]);

            const token = typeof window !== 'undefined' ? localStorage.getItem("token") : null;
            const res = await fetch(`${API_BASE_URL}/sessions/${activeSessionId}/ask/stream`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(token ? { 'Authorization': `Bearer ${token}` } : {})
                },
                body: JSON.stringify({ question: userMessage })
            });

            if (!res.ok) {
                throw new Error(`Server returned HTTP ${res.status}`);
            }

            const reader = res.body?.getReader();
            const decoder = new TextDecoder();
            let buffer = "";

            if (reader) {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;

                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split("\n\n");
                    buffer = lines.pop() || "";

                    for (const line of lines) {
                        const trimmed = line.trim();
                        if (trimmed.startsWith("data: ")) {
                            const rawJson = trimmed.substring(6);
                            try {
                                const event = JSON.parse(rawJson);
                                setMessages((prev) => {
                                    const updated = [...prev];
                                    const lastMsg = updated[updated.length - 1];
                                    if (!lastMsg || lastMsg.role !== "assistant") return prev;

                                    if (event.type === "token") {
                                        lastMsg.content += event.content;
                                    } else if (event.type === "final") {
                                        lastMsg.id = event.message_id;
                                        lastMsg.content = event.answer;
                                        lastMsg.citations = event.citations || [];
                                        lastMsg.confidence = event.confidence;
                                        lastMsg.source_type = event.source_type;
                                        lastMsg.isStreaming = false;
                                        lastMsg.thinkingTimeSeconds = Math.max(0.5, Number(((Date.now() - startTime) / 1000).toFixed(1)));
                                    } else if (["thought", "tool_start", "tool_end", "reflection"].includes(event.type)) {
                                        lastMsg.agent_trace = [...(lastMsg.agent_trace || []), event];
                                    }
                                    return updated;
                                });
                            } catch (parseErr) {
                                console.error("SSE parse error", parseErr);
                            }
                        }
                    }
                }
            }

            fetchSessions();
        } catch (error) {
            console.error(error);
            setMessages((prev) => {
                const updated = [...prev];
                const lastMsg = updated[updated.length - 1];
                if (lastMsg && lastMsg.role === "assistant" && lastMsg.isStreaming) {
                    lastMsg.content = error instanceof Error && error.message !== "Unauthorized"
                        ? `Sorry, something went wrong: ${error.message}`
                        : "Sorry, I had trouble connecting to the server. Please check your backend connection.";
                    lastMsg.isStreaming = false;
                    return updated;
                }
                return [
                    ...prev,
                    {
                        role: "assistant",
                        content: error instanceof Error && error.message !== "Unauthorized"
                            ? `Sorry, something went wrong: ${error.message}`
                            : "Sorry, I had trouble connecting to the server. Please check your backend connection.",
                        source_type: "none",
                    },
                ];
            });
        } finally {
            setIsLoading(false);
        }
    };

    const renderMessageContent = (msg: Message) => {
        const mainContent = msg.content;
        const citations = msg.citations ?? [];
        const sourceType = msg.source_type ?? null;
        const confidence = msg.confidence;
        const trace = msg.agent_trace ?? [];
        const validIndices = new Set(citations.map((c) => c.index));

        /**
         * Render `[1]` markers as interactive superscript chips.
         * Markers with no matching source are dropped rather than shown as a
         * dead reference. Splitting happens on text nodes only, so markdown
         * structure (lists, tables, code) is untouched.
         */
        const withCitationChips = (nodes: React.ReactNode): React.ReactNode =>
            Children.map(nodes, (node) => {
                if (typeof node !== "string") return node;
                if (!node.includes("[")) return node;

                const parts = node.split(/(\[\d{1,2}\])/g);
                if (parts.length === 1) return node;

                return parts.map((part, i) => {
                    const m = /^\[(\d{1,2})\]$/.exec(part);
                    if (!m) return part;
                    const idx = parseInt(m[1], 10);
                    if (!validIndices.has(idx)) return null;
                    return (
                        <button
                            key={i}
                            type="button"
                            onClick={() => focusCitation(msg.id ?? -1, idx)}
                            title={`Jump to source ${idx}`}
                            className="font-sans inline-flex items-center justify-center align-super mx-0.5 min-w-[16px] h-[16px] px-1.5 rounded-md text-[11px] font-semibold tabular-nums
                                       bg-accent-soft text-accent-text
                                       hover:bg-accent-softer transition-colors cursor-pointer
                                       focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none outline-none"
                        >
                            {idx}
                        </button>
                    );
                });
            });

        const md = (Tag: React.ElementType, cls: string) =>
            ({ children, ...props }: { children?: React.ReactNode }) => (
                <Tag className={cls} {...props}>{withCitationChips(children)}</Tag>
            );

        return (
            <div className="flex flex-col w-full min-w-0">
                {/* Thinking & tool-call trace */}
                <AgentTraceAccordion
                    trace={trace}
                    isStreaming={msg.isStreaming}
                    thinkingTime={msg.thinkingTimeSeconds}
                />

                {/* Provenance — a compact inline pill, not a full-width alert box.
                    A web answer must still never be mistaken for plant documentation. */}
                {sourceType === "web" && (
                    <div className="inline-flex items-center gap-1.5 self-start mb-3 pl-2 pr-2.5 py-1 rounded-full bg-amber-500/10 border border-amber-500/20">
                        <Globe size={11} className="shrink-0 text-amber-600 dark:text-amber-400" />
                        <span className="text-[11px] font-medium text-amber-700 dark:text-amber-300">
                            From the web — not your document library
                        </span>
                    </div>
                )}

                {sourceType === "hybrid" && (
                    <div className="inline-flex items-center gap-1.5 self-start mb-3 pl-2 pr-2.5 py-1 rounded-full bg-accent-soft border border-accent-line">
                        <Sparkles size={11} className="shrink-0 text-accent-text" />
                        <span className="text-[11px] font-medium text-accent-text">
                            Hybrid — Document Library & External Web Sources
                        </span>
                    </div>
                )}

                {sourceType === "conversation" && (
                    <div className="inline-flex items-center gap-1.5 self-start mb-3 pl-2 pr-2.5 py-1 rounded-full bg-accent-soft border border-accent-line">
                        <MessageSquare size={11} className="shrink-0 text-accent-text" />
                        <span className="text-[11px] font-medium text-accent-text">
                            From earlier in this conversation
                        </span>
                    </div>
                )}

                {/* Editorial serif body per the design — headings, lists, quotes
                    and prose inherit Newsreader; code/tables opt back to sans/mono
                    below since tabular and monospaced content reads better there. */}
                <div className="prose-answer flex-1 text-[18px] leading-[1.6] break-words text-text-primary w-full">
                    <ReactMarkdown
                        remarkPlugins={[remarkGfm]}
                        components={{
                            ul: (props) => <ul className="list-disc pl-5 space-y-2 mb-5 marker:text-text-tertiary" {...props} />,
                            ol: (props) => <ol className="list-decimal pl-5 space-y-2 mb-5 marker:text-text-tertiary" {...props} />,
                            li: md("li", "pl-1 leading-[1.55]"),
                            h1: md("h1", "font-sans text-[1.35rem] font-semibold mt-7 mb-3 first:mt-0 tracking-tight text-text-primary"),
                            h2: md("h2", "font-sans text-[1.15rem] font-semibold mt-6 mb-2.5 first:mt-0 tracking-tight text-text-primary"),
                            h3: md("h3", "font-sans text-[1.02rem] font-semibold mt-5 mb-2 first:mt-0 tracking-tight text-text-primary"),
                            p: md("p", "mb-4 last:mb-0"),
                            a: (props) => <a className="text-accent-text hover:underline underline-offset-2 decoration-accent-line transition-colors focus-visible:ring-2 focus-visible:ring-accent rounded px-0.5 outline-none" target="_blank" rel="noreferrer" {...props} />,
                            code: ({ className, children, ...props }) => {
                                const match = /language-(\w+)/.exec(className || '')
                                return match ? (
                                    <pre className="font-sans block bg-bg-tertiary p-4 rounded-lg text-[13px] leading-relaxed font-mono my-5 overflow-x-auto border border-border-default max-w-full">
                                        <code className={cn("text-text-primary", className)} {...props as any}>
                                            {children}
                                        </code>
                                    </pre>
                                ) : (
                                    <code className="bg-bg-tertiary border border-border-default rounded px-1.5 py-0.5 text-[0.8em] font-mono text-text-primary" {...props as any}>
                                        {children}
                                    </code>
                                )
                            },
                            strong: md("strong", "font-medium text-text-primary"),
                            blockquote: (props) => <blockquote className="border-l-2 border-accent-line pl-4 py-0.5 text-text-secondary my-5 italic" {...props} />,
                            hr: () => <hr className="my-6 border-border-default" />,
                            table: (props) => <div className="font-sans w-full overflow-x-auto my-5 max-w-full rounded-lg border border-border-default"><table className="w-full text-[13.5px] text-left border-collapse" {...props} /></div>,
                            th: md("th", "font-sans bg-bg-tertiary px-3 py-2.5 border-b border-border-default font-semibold text-text-primary text-[13px]"),
                            td: md("td", "font-sans px-3 py-2.5 border-b border-border-default last:border-0 align-top"),
                        }}
                    >
                        {mainContent}
                    </ReactMarkdown>
                </div>

                {citations.length > 0 && (
                    <div className="w-full mt-6">
                        <div className="flex items-center justify-between mb-2.5">
                            <div className="text-[11px] font-semibold text-text-secondary flex items-center gap-1.5 uppercase tracking-[0.06em]">
                                {sourceType === "web"
                                    ? <Globe size={12} className="text-text-secondary" />
                                    : <FileText size={12} className="text-text-secondary" />}
                                {sourceType === "web" ? "Web sources" : "Sources"}
                                <span className="text-text-secondary/60 font-normal normal-case tracking-normal">
                                    · {citations.length}
                                </span>
                            </div>
                            {typeof confidence === "number" && sourceType === "documents" && (
                                <ConfidenceBadge value={confidence} />
                            )}
                        </div>

                        {sourceType === "web" ? (
                            /* Perplexity-style: favicon + domain lead, title beneath.
                               Horizontal rail on narrow screens, grid on wide. */
                            <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1 snap-x sm:grid sm:grid-cols-2 lg:grid-cols-3 sm:overflow-visible sm:mx-0 sm:px-0 custom-scrollbar">
                                {citations.map((c) => (
                                    <WebSourceCard
                                        key={c.index}
                                        citation={c}
                                        citationKey={`${msg.id ?? -1}:${c.index}`}
                                        isActive={activeCitation === `${msg.id ?? -1}:${c.index}`}
                                    />
                                ))}
                            </div>
                        ) : (
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                                {citations.map((c) => {
                                    const key = `${msg.id ?? -1}:${c.index}`;
                                    const label = c.page !== null && c.page !== undefined
                                        ? `${c.document} · p.${c.page + 1}`
                                        : c.document;
                                    return (
                                        <div
                                            key={c.index}
                                            data-citation-key={key}
                                            title={c.snippet}
                                            className={cn(
                                                "group flex flex-col bg-card-background border border-border-default rounded-[14px] px-3.5 py-3 text-left w-full overflow-hidden shadow-[var(--shadow-card)] transition-[border-color,transform] duration-150 hover:border-accent hover:-translate-y-px",
                                                activeCitation === key && "citation-active"
                                            )}
                                        >
                                            <div className="flex items-center gap-2 min-w-0">
                                                <span className="w-5 h-5 rounded-md bg-accent-soft text-accent-text flex items-center justify-center text-[10px] font-bold shrink-0 tabular-nums">
                                                    {c.index}
                                                </span>
                                                <span className="text-[13.5px] font-semibold text-text-primary truncate flex-1">
                                                    {label}
                                                </span>
                                                {c.score > 0 && (
                                                    <span className="text-[11px] font-semibold text-text-secondary tabular-nums shrink-0">
                                                        {Math.round(c.score * 100)}%
                                                    </span>
                                                )}
                                            </div>
                                            {c.snippet && (
                                                <p className="text-[12px] text-text-secondary mt-1.5 line-clamp-2 leading-[1.5]">
                                                    {c.snippet}
                                                </p>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                )}

                <ClaimVerificationMatrix claims={msg.claims_verification} trustScore={msg.overall_trust_score} />

                {/* Grounded answer with no usable sources — say so rather than implying authority */}
                {!msg.isStreaming && citations.length === 0 && sourceType === "none" && (
                    <div className="mt-4 text-[11px] text-text-secondary flex items-center gap-1.5">
                        <AlertTriangle size={12} className="text-text-secondary" />
                        No supporting document was found for this answer.
                    </div>
                )}
            </div>
        );
    };

    return (
        <div className="flex h-full w-full bg-bg-primary text-text-primary font-sans overflow-hidden">
            {/* Mobile Overlay */}
            {sidebarOpen && (
                <div
                    className="fixed inset-0 bg-black/70 z-30 md:hidden transition-opacity"
                    onClick={() => setSidebarOpen(false)}
                />
            )}

            {/* Sidebar */}
            <div
                className={cn(
                    "fixed inset-y-0 left-0 z-40 w-[300px] bg-bg-secondary transform transition-all duration-300 ease-in-out md:relative md:translate-x-0 flex flex-col border-r border-border-default",
                    !sidebarOpen && "-translate-x-full md:w-0 md:opacity-0 md:border-none overflow-hidden"
                )}
            >
                <div className="flex flex-col h-full p-3 w-[300px]">
                    <div className="flex items-center justify-between mb-4 md:hidden text-text-secondary px-1 pt-1">
                        <span className="font-semibold text-text-primary">Menu</span>
                        <button onClick={() => setSidebarOpen(false)} className="p-1 hover:bg-button-secondary rounded-xl transition-colors focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none outline-none" title="Close Sidebar">
                            <X size={20} />
                        </button>
                    </div>

                    <button
                        onClick={() => {
                            setMessages([]);
                            setCurrentSessionId(null);
                            if (window.innerWidth < 768) setSidebarOpen(false);
                        }}
                        className="flex items-center gap-3 px-3 py-3 rounded-xl hover:bg-bg-tertiary transition-all text-sm text-text-primary border border-border-default shadow-sm mb-4 focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none outline-none font-medium cursor-pointer"
                    >
                        <Plus size={16} />
                        New chat
                    </button>

                    {/* Search Bar */}
                    <div className="mb-4 shrink-0 px-1">
                        <input
                            type="text"
                            placeholder="Search conversations..."
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            className="w-full text-xs p-2.5 bg-input-background border border-border-default rounded-xl focus:outline-none text-text-primary focus:border-accent focus:ring-1 focus:ring-accent transition-all font-sans placeholder-text-secondary/60 focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
                        />
                    </div>

                    <div className="flex-1 overflow-y-auto custom-scrollbar pr-2">
                        <div className="text-xs font-semibold text-text-secondary opacity-75 px-3 py-2 mb-1">Recent Chats</div>
                        {sessions.length === 0 ? (
                            <div className="px-3 py-2 text-sm text-text-secondary italic">No previous chats</div>
                        ) : (
                            sessions
                                .map((session) => (
                                    <div
                                        key={session.id}
                                        onClick={() => loadSession(session.id)}
                                        className={cn(
                                            "group px-3 py-2.5 text-sm truncate rounded-xl cursor-pointer transition-all mb-1 flex items-center gap-3 border focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none outline-none",
                                            currentSessionId === session.id
                                                ? "bg-accent-soft text-accent-text font-semibold border-accent-line shadow-sm"
                                                : "text-text-secondary hover:text-text-primary hover:bg-bg-tertiary border-transparent"
                                        )}
                                    >
                                        <MessageSquare size={14} className={currentSessionId === session.id ? "text-accent-text" : "text-text-secondary"} />
                                        <span className="truncate flex-1">{session.title}</span>

                                        <button
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                setSessionToDelete(session.id);
                                            }}
                                            className="opacity-0 group-hover:opacity-100 p-1 hover:bg-button-secondary rounded-lg text-text-secondary hover:text-red-500 transition-all shrink-0 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:outline-none outline-none"
                                            title="Delete Session"
                                        >
                                            <Trash2 size={12} />
                                        </button>
                                    </div>
                                ))
                        )}
                    </div>

                    {/* Support Status & Help Indicators */}
                    <div className="border-t border-border-default pt-3 mt-2 space-y-2">
                        <div className="px-3 py-2 flex items-center justify-between text-[11px] text-text-secondary bg-bg-tertiary rounded-xl border border-border-default">
                            <span className="flex items-center gap-1.5 font-medium">
                                <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse"></span>
                                Multi-Agent System
                            </span>
                            <span className="text-text-secondary font-semibold uppercase text-[9px] tracking-wider bg-green-500/10 text-green-400 px-1.5 py-0.5 rounded">Ready</span>
                        </div>

                        <div className="flex items-center gap-3 px-3 py-2 rounded-xl hover:bg-bg-tertiary transition-colors cursor-pointer focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none outline-none">
                            <div className="w-8 h-8 rounded-full bg-text-primary text-bg-primary border border-border-default flex items-center justify-center font-bold text-sm shadow-md uppercase">
                                {profileInitial}
                            </div>
                            <div className="text-sm font-medium text-text-primary truncate max-w-[150px]">
                                {username || 'Signed in user'}
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            {/* Main Content */}
            <div className="flex-1 flex flex-col h-full relative w-full overflow-x-hidden">
                {/* Header */}
                <div className="sticky top-0 z-30 flex items-center justify-between p-3 text-text-primary bg-bg-primary/95 backdrop-blur-md border-b border-border-default w-full">
                    <div className="flex items-center">
                        <button
                            onClick={() => setSidebarOpen(!sidebarOpen)}
                            className="p-2 hover:bg-bg-tertiary rounded-xl text-text-secondary hover:text-text-primary transition-colors focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none outline-none cursor-pointer"
                            title="Toggle Sidebar"
                        >
                            <Menu size={20} />
                        </button>
                        <span className="ml-3 font-semibold text-base text-text-primary flex items-center gap-2">
                            <Bot size={18} className="text-accent-text font-bold" />
                            Kairo — Compliance Knowledge Graph
                        </span>
                    </div>

                    {/* Quick Support Actions */}
                    <div className="flex items-center gap-2">
                        <button
                            onClick={toggleTheme}
                            className="p-1.5 bg-button-secondary hover:bg-bg-tertiary border border-border-default rounded-xl text-text-secondary hover:text-text-primary transition-colors flex items-center justify-center animate-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none outline-none cursor-pointer"
                            title={theme === 'dark' ? "Switch to Light Theme" : "Switch to Dark Theme"}
                        >
                            {theme === 'dark' ? (
                                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-yellow-400"><circle cx="12" cy="12" r="4" /><path d="M12 2v2" /><path d="M12 20v2" /><path d="m4.93 4.93 1.41 1.41" /><path d="m17.66 17.66 1.41 1.41" /><path d="M2 12h2" /><path d="M20 12h2" /><path d="m6.34 17.66-1.41 1.41" /><path d="m19.07 4.93-1.41 1.41" /></svg>
                            ) : (
                                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-blue-400"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" /></svg>
                            )}
                        </button>

                        <button
                            onClick={() => router.push('/ops_admin')}
                            className="bg-button-secondary text-text-primary px-3 py-1.5 rounded-xl text-xs font-medium hover:bg-bg-tertiary transition-all border border-border-default flex items-center gap-1.5 focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none outline-none cursor-pointer"
                        >
                            <LayoutDashboard size={14} />
                            <span className="hidden sm:inline">Dashboard</span>
                        </button>

                        {messages.length > 0 && (
                            <div className="relative">
                                <button
                                    onClick={() => setIsExportMenuOpen(!isExportMenuOpen)}
                                    className="p-1.5 bg-button-secondary hover:bg-bg-tertiary border border-border-default rounded-xl text-text-secondary hover:text-text-primary text-xs font-medium transition-all flex items-center gap-1.5 focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none outline-none cursor-pointer"
                                    title="Export Session"
                                >
                                    <Download size={14} />
                                    Export
                                </button>

                                {isExportMenuOpen && (
                                    <div className="absolute right-0 top-10 w-44 bg-card-background border border-border-default rounded-xl shadow-md py-1 z-50 animate-in fade-in zoom-in-95 duration-200">
                                        <button
                                            onClick={() => { exportAsMarkdown(messages); setIsExportMenuOpen(false); }}
                                            className="w-full text-left px-4 py-2 text-xs text-text-primary hover:bg-bg-tertiary hover:text-text-primary transition-colors flex items-center gap-2 cursor-pointer focus-visible:bg-bg-tertiary outline-none"
                                        >
                                            <Download size={11} className="text-text-secondary" />
                                            Markdown (.md)
                                        </button>
                                        <button
                                            onClick={() => { exportAsPDF(messages); setIsExportMenuOpen(false); }}
                                            className="w-full text-left px-4 py-2 text-xs text-text-primary hover:bg-bg-tertiary hover:text-text-primary transition-colors flex items-center gap-2 cursor-pointer focus-visible:bg-bg-tertiary outline-none"
                                        >
                                            <Download size={11} className="text-text-secondary" />
                                            PDF Document (.pdf)
                                        </button>
                                        <button
                                            onClick={() => { exportAsPlainText(messages); setIsExportMenuOpen(false); }}
                                            className="w-full text-left px-4 py-2 text-xs text-text-primary hover:bg-bg-tertiary hover:text-text-primary transition-colors flex items-center gap-2 cursor-pointer focus-visible:bg-bg-tertiary outline-none"
                                        >
                                            <Download size={11} className="text-text-secondary" />
                                            Plain Text (.txt)
                                        </button>
                                    </div>
                                )}
                            </div>
                        )}

                        {messages.length > 0 && (
                            <button
                                onClick={clearConversation}
                                className="bg-button-secondary hover:bg-bg-tertiary text-text-primary px-3 py-1.5 rounded-xl text-xs font-medium transition-all flex items-center gap-1.5 border border-border-default focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none outline-none cursor-pointer"
                                title="Clear current conversation"
                            >
                                <Trash2 size={14} />
                                Clear Chat
                            </button>
                        )}

                        {handleLogout && (
                            <button
                                onClick={handleLogout}
                                className="bg-red-500/10 text-red-500 border border-red-500/20 px-3 py-1.5 rounded-xl text-xs font-medium hover:bg-red-500 hover:text-white transition-all focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:outline-none outline-none cursor-pointer"
                            >
                                Logout
                            </button>
                        )}
                    </div>
                </div>                {/* Messages Area */}
                {messages.length > 0 && (
                    <div className="flex-1 overflow-y-auto custom-scrollbar w-full flex flex-col items-center">
                        {/* ~72ch measure: past ~75 characters per line the eye
                            loses its place on the return sweep. */}
                        <div className="flex flex-col w-full max-w-[46rem] pb-6 pt-6 px-4 md:px-0">
                            {messages.map((msg, idx) => (
                                <div key={idx} className={cn("group/msg flex w-full mt-8 first:mt-0", msg.role === 'user' ? "justify-end" : "justify-start")}>
                                    {msg.role === 'user' ? (
                                        <div className="max-w-[85%] md:max-w-[75%] bg-user-bubble text-text-primary rounded-[16px_16px_4px_16px] px-[18px] py-[13px] text-[15px] leading-[1.5] break-words whitespace-pre-wrap">
                                            {msg.content}
                                        </div>
                                    ) : (
                                        /* Unboxed, like Claude/ChatGPT — the assistant answer is the page
                                           content, not a card floating on it. */
                                        <div className="flex flex-col w-full min-w-0">
                                            {renderMessageContent(msg)}

                                            {/* Actions reveal on hover to keep the reading surface calm.
                                                Always visible on touch devices, where hover doesn't exist. */}
                                            <div className="flex items-center gap-0.5 mt-3 -ml-1.5 text-text-secondary opacity-100 md:opacity-0 md:focus-within:opacity-100 md:group-hover/msg:opacity-100 transition-opacity duration-200">
                                                <button
                                                    onClick={() => {
                                                        navigator.clipboard.writeText(msg.content);
                                                        setCopiedIdx(idx);
                                                        setTimeout(() => setCopiedIdx(null), 2000);
                                                    }}
                                                    className="h-8 w-8 inline-flex items-center justify-center rounded-lg hover:bg-button-secondary hover:text-text-primary transition-colors focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none outline-none cursor-pointer"
                                                    title={copiedIdx === idx ? "Copied" : "Copy answer"}
                                                    aria-label={copiedIdx === idx ? "Copied" : "Copy answer"}
                                                >
                                                    {copiedIdx === idx
                                                        ? <CheckCircle2 size={14} className="text-emerald-500" />
                                                        : <Copy size={14} />}
                                                </button>

                                                <button
                                                    onClick={() => handleSubmit(undefined, messages[idx - 1]?.content || "")}
                                                    className="h-8 w-8 inline-flex items-center justify-center rounded-lg hover:bg-button-secondary hover:text-text-primary transition-colors focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none outline-none cursor-pointer"
                                                    title="Regenerate response"
                                                    aria-label="Regenerate response"
                                                >
                                                    <RotateCcw size={14} />
                                                </button>

                                                {msg.id && (
                                                    <>
                                                        <span className="w-px h-4 bg-border-default mx-1.5" aria-hidden="true" />
                                                        <button
                                                            onClick={() => submitFeedback(msg.id, "helpful")}
                                                            className={cn(
                                                                "h-8 w-8 inline-flex items-center justify-center rounded-lg transition-colors cursor-pointer focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none outline-none hover:bg-button-secondary",
                                                                feedbackGiven[msg.id] === "helpful" ? "text-emerald-500" : "hover:text-emerald-500"
                                                            )}
                                                            title="Good response"
                                                            aria-label="Good response"
                                                            aria-pressed={feedbackGiven[msg.id] === "helpful"}
                                                        >
                                                            <ThumbsUp size={14} />
                                                        </button>
                                                        <button
                                                            onClick={() => submitFeedback(msg.id, "not_helpful")}
                                                            className={cn(
                                                                "h-8 w-8 inline-flex items-center justify-center rounded-lg transition-colors cursor-pointer focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none outline-none hover:bg-button-secondary",
                                                                feedbackGiven[msg.id] === "not_helpful" ? "text-red-500" : "hover:text-red-500"
                                                            )}
                                                            title="Bad response"
                                                            aria-label="Bad response"
                                                            aria-pressed={feedbackGiven[msg.id] === "not_helpful"}
                                                        >
                                                            <ThumbsDown size={14} />
                                                        </button>
                                                        {feedbackGiven[msg.id] && (
                                                            <span className="text-[11px] text-text-secondary ml-1.5">Thanks for the feedback</span>
                                                        )}
                                                    </>
                                                )}
                                            </div>

                                            {/* Contextual follow-ups, generated from this answer's own sources */}
                                            {idx === messages.length - 1 && !isLoading && (
                                                <div className="mt-6 flex flex-col gap-2.5 animate-in fade-in slide-in-from-bottom-1 duration-300">
                                                    {msg.id && (followUpsLoading === msg.id || (followUps[msg.id]?.length ?? 0) > 0) && (
                                                        <span className="text-[11px] font-semibold tracking-[0.05em] uppercase text-text-tertiary">
                                                            Follow-up
                                                        </span>
                                                    )}

                                                    <div className="flex flex-wrap gap-2 items-center">
                                                        {msg.id && followUpsLoading === msg.id && (
                                                            <span className="text-xs text-text-secondary flex items-center gap-1.5">
                                                                <Loader2 size={11} className="animate-spin" />
                                                                Suggesting follow-ups
                                                            </span>
                                                        )}

                                                        {msg.id && (followUps[msg.id]?.length ?? 0) > 0 && (
                                                            <>
                                                                {followUps[msg.id].map((q, i) => (
                                                                    <button
                                                                        key={i}
                                                                        onClick={() => handleSubmit(undefined, q)}
                                                                        className="group/fu text-[13.5px] bg-card-background border border-border-default rounded-[11px] pl-3.5 pr-3 py-2 text-text-primary hover:border-accent hover:bg-bg-tertiary transition-colors font-medium focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none outline-none cursor-pointer inline-flex items-center gap-2"
                                                                    >
                                                                        {q}
                                                                        <Plus size={13} className="text-text-tertiary shrink-0" />
                                                                    </button>
                                                                ))}
                                                            </>
                                                        )}

                                                        <button
                                                            onClick={() => setIsTicketModalOpen(true)}
                                                            className="text-[13px] text-text-secondary hover:text-text-primary rounded-full px-3 py-1.5 hover:bg-button-secondary transition-colors flex items-center gap-1.5 font-medium focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none outline-none cursor-pointer"
                                                        >
                                                            <Ticket size={11} />
                                                            Escalate
                                                        </button>
                                                    </div>
                                                </div>
                                            )}
                                        </div>
                                    )}
                                </div>
                            ))}
                            <div ref={messagesEndRef} className="h-4" />
                        </div>
                    </div>
                )}

                {/* Input Area */}
                <div className={cn(
                    "w-full px-4 md:px-0 flex flex-col items-center z-20 shrink-0 transition-all duration-500",
                    messages.length === 0 ? "flex-1 justify-center mt-[-8vh]" : "bg-bg-primary pt-4 pb-6 justify-end"
                )}>
                    <div className="w-full max-w-5xl relative flex flex-col items-center animate-none">
                        {messages.length === 0 && (
                            <div className="flex flex-col items-center gap-5 mb-8">
                                <div className="flex items-center gap-2 px-4 py-2 bg-accent-soft border border-accent-line rounded-full animate-in fade-in slide-in-from-top-3 duration-500">
                                    <span className="text-[11px] font-semibold text-accent-text tracking-wide uppercase">How it works</span>
                                    <span className="text-[11px] text-text-secondary">Expands our Knowledge base</span>
                                    <span className="text-text-secondary opacity-60">&#8594;</span>
                                    <span className="text-[11px] text-text-secondary">Ask Kairo anything</span>
                                    <span className="text-text-secondary opacity-60">&#8594;</span>
                                    <span className="text-[11px] text-text-secondary">Get trusted response</span>
                                </div>
                                <h2 className="text-3xl md:text-4xl font-medium text-text-primary tracking-tight text-center">
                                    How can I help you today?
                                </h2>
                            </div>
                        )}

                        <style>{`
                            @keyframes spin-slow {
                                from { transform: translate(-50%, -50%) rotate(0deg); }
                                to { transform: translate(-50%, -50%) rotate(360deg); }
                            }
                        `}</style>
                        <div className="relative w-full rounded-xl shadow-[var(--shadow-card)] group overflow-hidden border border-border-strong">
                            <div
                                className={cn(
                                    "absolute top-1/2 left-1/2 w-[200%] h-[200%] bg-[conic-gradient(from_0deg,transparent_40%,var(--text-primary)_100%)] rounded-full z-0 pointer-events-none transition-opacity duration-500",
                                    isLoading ? "opacity-100" : "opacity-0"
                                )}
                                style={{ animation: 'spin-slow 3s linear infinite' }}
                            />

                            <div className="relative flex flex-col w-[calc(100%-2px)] bg-input-background focus-within:bg-bg-tertiary rounded-xl m-[1px] transition-all duration-300 z-10 focus-within:ring-2 focus-within:ring-accent focus-within:outline-none">
                                <textarea
                                    value={input}
                                    onChange={(e) => setInput(e.target.value)}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter' && !e.shiftKey) {
                                            e.preventDefault();
                                            handleSubmit();
                                        }
                                    }}
                                    placeholder={currentPlaceholder + (isDeleting ? "" : "|")}
                                    className="w-full bg-transparent text-text-primary placeholder-text-secondary/60 resize-none focus:outline-none min-h-[56px] py-4 px-5 text-[15px] custom-scrollbar font-sans outline-none font-medium"
                                    style={{ height: 'auto', minHeight: '56px' }}
                                    rows={1}
                                />
                                <div className="flex items-center justify-between px-3 pb-3">
                                    <div className="flex items-center gap-2">
                                        <button className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-button-secondary hover:bg-bg-tertiary text-text-secondary hover:text-text-primary transition-colors text-[12.5px] font-medium focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none outline-none cursor-pointer border border-border-default">
                                            <Bot size={13} />
                                            Model · Kairo Pro
                                            <ChevronDown size={12} className="text-text-tertiary" />
                                        </button>
                                    </div>
                                    <button
                                        onClick={() => handleSubmit()}
                                        disabled={!input.trim() || isLoading}
                                        className={cn(
                                            "p-2 rounded-lg transition-all flex items-center justify-center w-9 h-9 focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none outline-none cursor-pointer",
                                            input.trim() && !isLoading ? "bg-accent text-accent-ink hover:bg-accent-strong shadow-sm" : "bg-button-secondary text-text-secondary/50 cursor-not-allowed border border-border-default"
                                        )}
                                    >
                                        {isLoading ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} className="ml-0.5" />}
                                    </button>
                                </div>
                            </div>
                        </div>

                        {messages.length === 0 && (
                            <div className="flex flex-wrap items-center justify-center gap-2.5 mt-6 w-full px-2">
                                {SUGGESTED_QUERIES.map((query, idx) => (
                                    <button
                                        key={idx}
                                        onClick={() => handleSubmit(undefined, query.text)}
                                        className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-bg-tertiary border border-border-default hover:bg-bg-primary hover:border-text-secondary text-text-secondary hover:text-text-primary transition-all text-[13px] font-medium shadow-sm hover:shadow-md focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none outline-none cursor-pointer"
                                    >
                                        <query.icon size={15} className="text-text-secondary" />
                                        {query.label}
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>
                </div>
            </div>

            {/* Escalation Ticket Modal */}
            {isTicketModalOpen && (
                <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[100] flex items-center justify-center p-4 animate-in fade-in duration-300">
                    <div className="bg-card-background border border-border-default w-full max-w-lg rounded-2xl overflow-hidden shadow-md relative">
                        <div className="absolute top-0 left-0 w-full h-1 bg-accent"></div>

                        <div className="p-6 font-sans">
                            <div className="flex items-center justify-between mb-4">
                                <h3 className="text-lg font-semibold text-text-primary flex items-center gap-2">
                                    <Ticket className="text-accent-text" size={20} />
                                    Raise Support Ticket
                                </h3>
                                <button
                                    onClick={() => setIsTicketModalOpen(false)}
                                    className="p-1 hover:bg-bg-tertiary rounded-xl text-text-secondary hover:text-text-primary transition-all focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none outline-none cursor-pointer"
                                >
                                    <X size={18} />
                                </button>
                            </div>

                            {ticketSuccess ? (
                                <div className="py-8 flex flex-col items-center justify-center text-center animate-in zoom-in-95 duration-200">
                                    <CheckCircle2 size={48} className="text-green-400 mb-3 animate-bounce" />
                                    <h4 className="text-text-primary font-medium text-base">Ticket Submitted Successfully!</h4>
                                    <p className="text-text-secondary text-xs mt-1">Our support administrators have been notified.</p>
                                </div>
                            ) : (
                                <div className="space-y-4">
                                    <div>
                                        <label className="block text-xs font-medium text-text-secondary mb-1 font-semibold">Subject</label>
                                        <input
                                            type="text"
                                            value={ticketSubject}
                                            onChange={(e) => setTicketSubject(e.target.value)}
                                            placeholder="Briefly describe the support request..."
                                            className="w-full p-3 bg-input-background border border-border-default rounded-xl text-text-primary placeholder-text-secondary/60 text-sm focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none transition-all font-sans font-medium"
                                        />
                                    </div>

                                    <div>
                                        <label className="block text-xs font-medium text-text-secondary mb-1 font-semibold">Priority Level</label>
                                        <select
                                            value={ticketPriority}
                                            onChange={(e) => setTicketPriority(e.target.value)}
                                            className="w-full p-3 bg-input-background border border-border-default rounded-xl text-text-primary text-sm focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none transition-all font-sans font-semibold cursor-pointer"
                                        >
                                            <option value="Low">Low Priority</option>
                                            <option value="Medium">Medium Priority</option>
                                            <option value="High">High Priority</option>
                                            <option value="Urgent">Urgent Priority</option>
                                        </select>
                                    </div>

                                    <div>
                                        <label className="block text-xs font-medium text-text-secondary mb-1 font-semibold">Detailed Description</label>
                                        <textarea
                                            value={ticketDescription}
                                            onChange={(e) => setTicketDescription(e.target.value)}
                                            placeholder="Provide system errors, steps to reproduce, or details to assist support staff..."
                                            className="w-full p-3 bg-input-background border border-border-default rounded-xl text-text-primary placeholder-text-secondary/60 text-sm focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none transition-all font-sans min-h-[100px] resize-none font-medium"
                                            rows={4}
                                        />
                                    </div>

                                    <div className="pt-2 flex justify-end gap-3">
                                        <button
                                            onClick={() => setIsTicketModalOpen(false)}
                                            className="px-4 py-2 bg-button-secondary hover:bg-bg-tertiary border border-border-default rounded-xl text-xs font-medium text-text-secondary transition-colors focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none outline-none cursor-pointer font-sans"
                                        >
                                            Cancel
                                        </button>
                                        <button
                                            onClick={() => {
                                                if (!ticketSubject.trim() || !ticketDescription.trim()) {
                                                    showToast("Please fill in all fields.", "error");
                                                    return;
                                                }
                                                const existing = localStorage.getItem("support_tickets");
                                                const tickets = existing ? JSON.parse(existing) : [];
                                                const newT = {
                                                    id: `TKT-${Math.floor(1000 + Math.random() * 9000)}`,
                                                    subject: ticketSubject,
                                                    description: ticketDescription,
                                                    priority: ticketPriority,
                                                    status: "Open",
                                                    createdAt: new Date().toISOString(),
                                                    user: localStorage.getItem("username") || "Agent"
                                                };
                                                tickets.push(newT);
                                                localStorage.setItem("support_tickets", JSON.stringify(tickets));

                                                setTicketSuccess(true);
                                                setTimeout(() => {
                                                    setTicketSuccess(false);
                                                    setIsTicketModalOpen(false);
                                                    setTicketSubject("");
                                                    setTicketDescription("");
                                                }, 2000);
                                            }}
                                            className="px-4 py-2 bg-accent hover:bg-accent-strong text-accent-ink rounded-xl text-xs font-semibold transition-colors focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none outline-none cursor-pointer font-sans"
                                        >
                                            Submit Ticket
                                        </button>
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            )}

            {/* Custom Deletion Confirmation Modal */}
            {sessionToDelete !== null && (
                <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[100] flex items-center justify-center p-4 animate-in fade-in duration-300">
                    <div className="bg-card-background border border-border-default w-full max-w-sm rounded-2xl overflow-hidden shadow-md relative font-sans">
                        <div className="absolute top-0 left-0 w-full h-1 bg-red-500"></div>
                        <div className="p-6 text-center">
                            <div className="w-12 h-12 bg-red-500/10 text-red-500 rounded-full flex items-center justify-center mx-auto mb-4 shadow-inner">
                                <Trash2 size={20} />
                            </div>
                            <h3 className="text-base font-semibold text-text-primary mb-2 font-sans">Delete Conversation?</h3>
                            <p className="text-xs text-text-secondary mb-6 leading-relaxed font-sans">
                                Are you sure you want to delete this conversation? This action cannot be undone and will permanently remove all messages.
                            </p>
                            <div className="flex gap-3 justify-center">
                                <button
                                    onClick={() => setSessionToDelete(null)}
                                    className="px-4 py-2 bg-button-secondary hover:bg-bg-tertiary border border-border-default rounded-xl text-xs font-medium text-text-secondary transition-colors focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none outline-none cursor-pointer font-sans"
                                >
                                    Cancel
                                </button>
                                <button
                                    onClick={async () => {
                                        const id = sessionToDelete;
                                        setSessionToDelete(null);
                                        await confirmDeleteSession(id);
                                    }}
                                    className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-xl text-xs font-medium font-semibold transition-colors focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:outline-none outline-none cursor-pointer font-sans"
                                >
                                    Delete
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* Custom Toast Notification */}
            {toast && (
                <div className="fixed bottom-6 right-6 z-[100] animate-in slide-in-from-bottom-5 duration-300 pointer-events-auto">
                    <div className={cn(
                        "px-4 py-3 rounded-xl border flex items-center gap-3 shadow-md backdrop-blur-md",
                        toast.type === 'error' ? "bg-red-500/10 border-red-500/20 text-red-200" :
                            toast.type === 'success' ? "bg-green-500/10 border-green-500/20 text-green-200" :
                                "bg-card-background border-border-default text-text-primary"
                    )}>
                        <span className="text-xs font-semibold">{toast.message}</span>
                        <button onClick={() => setToast(null)} className="hover:bg-button-secondary p-1 rounded-lg transition-colors text-text-secondary hover:text-text-primary focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none outline-none cursor-pointer">
                            <X size={12} />
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}
