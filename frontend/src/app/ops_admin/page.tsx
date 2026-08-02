"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import UploadComponent from "../../components/Upload";
import KnowledgeGraphView from "../../components/KnowledgeGraphView";
import { apiJson } from "../../lib/api";
import {
    ArrowLeft, LayoutDashboard, Database, Settings, FileText,
    Clock, Ticket, BarChart2, HelpCircle, Activity, ChevronRight,
    AlertCircle, Trash2, CheckCircle2, RotateCcw, Loader2, X,
    ThumbsUp, ThumbsDown, Network
} from "lucide-react";

type UploadedFile = {
    id: number;
    filename: string;
    size: number;
    status: "queued" | "processing" | "indexed" | "error";
    chunk_count: number;
    error_detail: string | null;
    uploaded_at: string;
};

type FeedbackAnalytics = {
    helpful: number;
    not_helpful: number;
    total: number;
    satisfaction_rate: string;
    avg_confidence: number | null;
    recent_negative: {
        message_id: number;
        answer_preview: string;
        source_type: string | null;
        confidence: number | null;
        comment: string | null;
        created_at: string;
    }[];
};

type SupportTicket = {
    id: string;
    subject: string;
    description: string;
    priority: "Low" | "Medium" | "High" | "Urgent";
    status: "Open" | "In Progress" | "Resolved";
    createdAt: string;
    user: string;
};

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';

function cn(...classes: string[]) {
    return classes.filter(Boolean).join(" ");
}

export default function AdminPage() {
    const router = useRouter();
    const [loading, setLoading] = useState(true);
    const [files, setFiles] = useState<UploadedFile[]>([]);

    // Tab routing state
    const [activeTab, setActiveTab] = useState<'documents' | 'graph' | 'tickets' | 'faq' | 'analytics' | 'activity'>('documents');

    useEffect(() => {
        if (typeof window !== "undefined") {
            const params = new URLSearchParams(window.location.search);
            const tabParam = params.get("tab");
            if (tabParam === "graph") {
                setActiveTab("graph");
            }
        }
    }, []);

    // Support tickets state
    const [tickets, setTickets] = useState<SupportTicket[]>([]);

    // FAQ and Analytics integrated states
    type FaqRule = { id: number; keyword: string; response: string; is_active: boolean };
    const [faqs, setFaqs] = useState<FaqRule[]>([]);
    const [newKeyword, setNewKeyword] = useState("");
    const [newResponse, setNewResponse] = useState("");
    const [newIsActive, setNewIsActive] = useState(true);
    const [toast, setToast] = useState<{ message: string; type: 'info' | 'success' | 'error' } | null>(null);
    const [faqToDelete, setFaqToDelete] = useState<number | null>(null);
    const [fileToDelete, setFileToDelete] = useState<string | null>(null);
    const [systemStatus, setSystemStatus] = useState({ vectorStore: "Checking Status", sqLite: "Checking Status" });

    // Settings Drawer state
    const [isSettingsOpen, setIsSettingsOpen] = useState(false);
    const [chunkSize, setChunkSize] = useState(1000);
    const [chunkOverlap, setChunkOverlap] = useState(200);
    const [temperature, setTemperature] = useState(0.7);
    const [topK, setTopK] = useState(4);
    const [similarityThreshold, setSimilarityThreshold] = useState(0.15);
    const [maxContextChunks, setMaxContextChunks] = useState(4);
    const [enableFaqRouter, setEnableFaqRouter] = useState(true);
    const [enableWebSearch, setEnableWebSearch] = useState(true);
    const [enableFailedLogging, setEnableFailedLogging] = useState(true);
    const [systemPrompt, setSystemPrompt] = useState("");

    // ---- Answer-quality feedback (now persisted server-side) ----
    const [feedbackData, setFeedbackData] = useState<FeedbackAnalytics | null>(null);

    // Activity Logs state
    type LogItem = { username: string; action: string; target?: string; timestamp: string };
    const [activityLogs, setActivityLogs] = useState<LogItem[]>([]);

    // Theme state
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

    const fetchSettings = async () => {
        try {
            const token = localStorage.getItem('token');
            const res = await fetch(`${API_BASE_URL}/settings`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (res.ok) {
                const data = await res.json();
                setChunkSize(data.chunk_size);
                setChunkOverlap(data.chunk_overlap);
                setTemperature(data.temperature);
                setTopK(data.top_k);
                setSimilarityThreshold(data.similarity_threshold);
                setMaxContextChunks(data.max_context_chunks);
                setEnableFaqRouter(data.enable_faq_router);
                setEnableWebSearch(data.enable_web_search);
                setEnableFailedLogging(data.enable_failed_logging);
                setSystemPrompt(data.system_prompt);
            }
        } catch (error) {
            console.error("Failed to fetch settings", error);
        }
    };

    const handleSaveSettings = async () => {
        try {
            const token = localStorage.getItem('token');
            let prompt = systemPrompt;
            if (!prompt.includes("{context}") || !prompt.includes("{question}")) {
                showToast("System Prompt missing required placeholders {context} or {question}. Restoring them automatically.", "info");
                if (!prompt.includes("{context}")) {
                    prompt += "\n\nContext:\n{context}";
                }
                if (!prompt.includes("{question}")) {
                    prompt += "\n\nUser Question:\n{question}";
                }
                setSystemPrompt(prompt);
            }

            const res = await fetch(`${API_BASE_URL}/settings`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({
                    chunk_size: chunkSize,
                    chunk_overlap: chunkOverlap,
                    temperature: temperature,
                    top_k: topK,
                    similarity_threshold: similarityThreshold,
                    max_context_chunks: maxContextChunks,
                    enable_faq_router: enableFaqRouter,
                    enable_web_search: enableWebSearch,
                    enable_failed_logging: enableFailedLogging,
                    system_prompt: prompt
                })
            });

            if (res.ok) {
                showToast("Settings updated successfully", "success");
                setIsSettingsOpen(false);
            } else {
                showToast("Failed to update settings", "error");
            }
        } catch (error) {
            console.error("Failed to save settings", error);
            showToast("Failed to save settings", "error");
        }
    };

    const handleResetSettings = async () => {
        try {
            const token = localStorage.getItem('token');
            const res = await fetch(`${API_BASE_URL}/settings/reset`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (res.ok) {
                const data = await res.json();
                setChunkSize(data.chunk_size);
                setChunkOverlap(data.chunk_overlap);
                setTemperature(data.temperature);
                setTopK(data.top_k);
                setSimilarityThreshold(data.similarity_threshold);
                setMaxContextChunks(data.max_context_chunks);
                setEnableFaqRouter(data.enable_faq_router);
                setEnableWebSearch(data.enable_web_search);
                setEnableFailedLogging(data.enable_failed_logging);
                setSystemPrompt(data.system_prompt);
                showToast("Settings reset to defaults", "success");
            } else {
                showToast("Failed to reset settings", "error");
            }
        } catch (error) {
            console.error("Failed to reset settings", error);
            showToast("Failed to reset settings", "error");
        }
    };

    const fetchActivityLogs = async () => {
        try {
            const token = localStorage.getItem('token');
            const res = await fetch(`${API_BASE_URL}/analytics/activity`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (res.ok) {
                const data = await res.json();
                setActivityLogs(data);
            }
        } catch (error) {
            console.error("Failed to fetch activity logs", error);
        }
    };



    const showToast = (message: string, type: 'info' | 'success' | 'error' = 'info') => {
        setToast({ message, type });
    };

    useEffect(() => {
        if (toast) {
            const timer = setTimeout(() => setToast(null), 3000);
            return () => clearTimeout(timer);
        }
    }, [toast]);

    type GapItem = { query_text: string; failure_count: number; highest_score: number; created_at: string };
    const [analyticsData, setAnalyticsData] = useState<{ failed_rate: string; total_failed: number; gaps: GapItem[] }>({
        failed_rate: "0.0%",
        total_failed: 0,
        gaps: [],
    });

    const [reindexState, setReindexState] = useState<Record<string, string>>({});
    const [deleteState, setDeleteState] = useState<Record<string, string>>({});

    const handleReindex = async (filename: string) => {
        if (reindexState[filename] === "loading") return; // prevent duplicate
        setReindexState(prev => ({ ...prev, [filename]: "loading" }));
        showToast("Re-indexing document... Please wait.", "info");
        try {
            const token = localStorage.getItem("token");
            const res = await fetch(`${API_BASE_URL}/reindex/${encodeURIComponent(filename)}`, {
                method: "POST",
                headers: { Authorization: `Bearer ${token}` },
            });
            if (!res.ok) {
                const err = await res.json();
                throw new Error(err.detail || "Re-index failed");
            }
            // Poll until done (max 120s, every 2s)
            let attempts = 0;
            const poll = setInterval(async () => {
                attempts++;
                try {
                    const statusRes = await fetch(
                        `${API_BASE_URL}/reindex/${encodeURIComponent(filename)}/status`,
                        { headers: { Authorization: `Bearer ${token}` } }
                    );
                    const statusData = await statusRes.json();
                    if (statusData.status === "done") {
                        clearInterval(poll);
                        setReindexState(prev => ({ ...prev, [filename]: "done" }));
                        showToast("Document re-indexed successfully.", "success");
                        setTimeout(() => setReindexState(prev => ({ ...prev, [filename]: "idle" })), 4000);
                    } else if (statusData.status === "error") {
                        clearInterval(poll);
                        setReindexState(prev => ({ ...prev, [filename]: `error:${statusData.detail}` }));
                        showToast(`Re-index failed: ${statusData.detail}`, "error");
                        setTimeout(() => setReindexState(prev => ({ ...prev, [filename]: "idle" })), 5000);
                    } else if (attempts >= 60) {
                        clearInterval(poll);
                        setReindexState(prev => ({ ...prev, [filename]: "error:Timed out" }));
                        showToast("Re-index failed: Timed out.", "error");
                        setTimeout(() => setReindexState(prev => ({ ...prev, [filename]: "idle" })), 5000);
                    }
                } catch { /* network hiccup, keep polling */ }
            }, 2000);
        } catch (err: any) {
            setReindexState(prev => ({ ...prev, [filename]: `error:${err.message}` }));
            showToast(`Re-index failed: ${err.message}`, "error");
            setTimeout(() => setReindexState(prev => ({ ...prev, [filename]: "idle" })), 5000);
        }
    };

    const confirmDeleteFile = async (filename: string) => {
        if (deleteState[filename] === "loading") return;
        setDeleteState(prev => ({ ...prev, [filename]: "loading" }));
        try {
            const token = localStorage.getItem("token");
            const res = await fetch(`${API_BASE_URL}/files/${encodeURIComponent(filename)}`, {
                method: "DELETE",
                headers: { Authorization: `Bearer ${token}` },
            });
            if (!res.ok) {
                const err = await res.json();
                throw new Error(err.detail || "Delete failed");
            }
            setDeleteState(prev => ({ ...prev, [filename]: "done" }));
            showToast(`Document "${filename}" deleted successfully`, "success");
            fetchFiles(); // refresh list
            setTimeout(() => setDeleteState(prev => ({ ...prev, [filename]: "idle" })), 3000);
        } catch (err: any) {
            setDeleteState(prev => ({ ...prev, [filename]: `error` }));
            showToast(`Failed to delete: ${err.message}`, "error");
            setTimeout(() => setDeleteState(prev => ({ ...prev, [filename]: "idle" })), 4000);
        }
    };

    const fetchFaqs = async () => {
        try {
            const token = localStorage.getItem('token');
            const res = await fetch(`${API_BASE_URL}/faq`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (res.ok) {
                const data = await res.json();
                setFaqs(data);
            }
        } catch (error) {
            console.error("Failed to fetch FAQs", error);
        }
    };

    const handleAddFaq = async () => {
        if (!newKeyword.trim() || !newResponse.trim()) {
            showToast("Please fill in both keyword and response.", "error");
            return;
        }
        try {
            const token = localStorage.getItem('token');
            const res = await fetch(`${API_BASE_URL}/faq`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({
                    keyword: newKeyword.trim(),
                    response: newResponse.trim(),
                    is_active: newIsActive
                })
            });
            if (res.ok) {
                setNewKeyword("");
                setNewResponse("");
                fetchFaqs();
                showToast("FAQ rule added successfully", "success");
            } else {
                const errorData = await res.json();
                showToast(errorData.detail || "Failed to add FAQ rule", "error");
            }
        } catch (error) {
            console.error("Failed to add FAQ", error);
            showToast("Failed to add FAQ rule due to connection error", "error");
        }
    };

    const confirmDeleteFaq = async (id: number) => {
        try {
            const token = localStorage.getItem('token');
            const res = await fetch(`${API_BASE_URL}/faq/${id}`, {
                method: 'DELETE',
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (res.ok) {
                fetchFaqs();
                showToast("FAQ rule deleted successfully", "success");
            } else {
                showToast("Failed to delete FAQ rule", "error");
            }
        } catch (error) {
            console.error("Failed to delete FAQ", error);
            showToast("Failed to delete FAQ rule due to connection error", "error");
        }
    };

    const fetchAnalytics = async () => {
        try {
            const token = localStorage.getItem('token');
            const res = await fetch(`${API_BASE_URL}/analytics/gaps`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (res.ok) {
                const data = await res.json();
                setAnalyticsData(data);
            }
        } catch (error) {
            console.error("Failed to fetch analytics gaps", error);
        }
    };
    const fetchFiles = async () => {
        try {
            const token = localStorage.getItem('token');
            const res = await fetch(`${API_BASE_URL}/files`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (res.ok) {
                const data = await res.json();
                setFiles(data.sort((a: any, b: any) => new Date(b.uploaded_at).getTime() - new Date(a.uploaded_at).getTime()));
            }
        } catch (error) {
            console.error("Failed to fetch files", error);
        }
    };

    const fetchFeedback = async () => {
        try {
            const token = localStorage.getItem('token');
            const res = await fetch(`${API_BASE_URL}/analytics/feedback`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (res.ok) {
                const data = await res.json();
                setFeedbackData(data);
            }
        } catch (e) { console.error("Failed to fetch feedback analytics", e); }
    };

    const loadTickets = () => {
        const existing = localStorage.getItem("support_tickets");
        if (existing) {
            setTickets(JSON.parse(existing));
        } else {
            // Seed a mock ticket if empty
            const seedTickets: SupportTicket[] = [
                {
                    id: "TKT-3120",
                    subject: "Refund approval permission setup",
                    description: "Refund request for client transaction TXN-8291 exceeds local agent limit ($500). Customer Support agent needs documentation on senior supervisor authorization procedure.",
                    priority: "High",
                    status: "Open",
                    createdAt: new Date(Date.now() - 3600000 * 4).toISOString(),
                    user: "Agent_A"
                },
                {
                    id: "TKT-2490",
                    subject: "Email routing failure for billing domain",
                    description: "Incoming support queries from billing domain are bypassing Zendesk routing queues and going to dead-letter folder. Please review filter configurations.",
                    priority: "Medium",
                    status: "In Progress",
                    createdAt: new Date(Date.now() - 3600000 * 24).toISOString(),
                    user: "Agent_Support"
                }
            ];
            localStorage.setItem("support_tickets", JSON.stringify(seedTickets));
            setTickets(seedTickets);
        }
    };

    const handleUpdateTicketStatus = (ticketId: string, newStatus: "Open" | "In Progress" | "Resolved") => {
        const updated = tickets.map(t => {
            if (t.id === ticketId) {
                return { ...t, status: newStatus };
            }
            return t;
        });
        setTickets(updated);
        localStorage.setItem("support_tickets", JSON.stringify(updated));
    };

    const handleDeleteTicket = (ticketId: string) => {
        const updated = tickets.filter(t => t.id !== ticketId);
        setTickets(updated);
        localStorage.setItem("support_tickets", JSON.stringify(updated));
    };

    useEffect(() => {
        const token = localStorage.getItem('token');
        const role = localStorage.getItem('role');

        if (!token) {
            router.push('/');
        } else {
            setLoading(false);
            fetchFiles();
            loadTickets();
            fetchFaqs();
            fetchAnalytics();
            fetchFeedback();
            fetchSettings();
            fetchActivityLogs();

            // Real-time backend system status check
            const checkHealth = async () => {
                try {
                    const res = await fetch(`${API_BASE_URL}/`);
                    if (res.ok) {
                        setSystemStatus({ vectorStore: "Online", sqLite: "Online" });
                    } else {
                        setSystemStatus({ vectorStore: "Offline", sqLite: "Offline" });
                    }
                } catch {
                    setSystemStatus({ vectorStore: "Offline", sqLite: "Offline" });
                }
            };
            checkHealth();
        }
    }, [router]);

    // Poll for files that are actively being indexed in the background
    useEffect(() => {
        const hasProcessing = files.some(f => f.status === 'queued' || f.status === 'processing');
        if (hasProcessing) {
            const interval = setInterval(() => {
                fetchFiles();
            }, 2000);
            return () => clearInterval(interval);
        }
    }, [files]);

    if (loading) return <div className="min-h-[100dvh] bg-bg-primary text-text-primary flex items-center justify-center">Loading Admin...</div>;

    return (
        <main className="h-[100dvh] overflow-y-auto w-full bg-bg-primary flex flex-col items-center custom-scrollbar">
            {/* Navigation Bar */}
            <div className="w-full bg-bg-secondary border-b border-border-default p-4 flex items-center justify-between sticky top-0 z-50 shadow-md">
                <div className="flex items-center gap-4 px-2 md:px-6">
                    <button
                        onClick={() => router.push('/')}
                        className="p-2 hover:bg-button-secondary rounded-lg text-text-secondary hover:text-text-primary transition-colors"
                        title="Back to Chat"
                    >
                        <ArrowLeft size={20} />
                    </button>
                    <div className="flex items-center gap-2 text-text-primary font-medium text-lg">
                        <LayoutDashboard size={20} className="text-accent-text" />
                        Kairo — Support Dashboard
                    </div>
                </div>
                <div className="flex items-center gap-4 px-6">
                    <button
                        onClick={toggleTheme}
                        className="p-2 hover:bg-button-secondary rounded-lg text-text-secondary hover:text-text-primary transition-colors animate-none"
                        title={theme === 'dark' ? "Switch to Light Theme" : "Switch to Dark Theme"}
                    >
                        {theme === 'dark' ? (
                            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-yellow-400"><circle cx="12" cy="12" r="4" /><path d="M12 2v2" /><path d="M12 20v2" /><path d="m4.93 4.93 1.41 1.41" /><path d="m17.66 17.66 1.41 1.41" /><path d="M2 12h2" /><path d="M20 12h2" /><path d="m6.34 17.66-1.41 1.41" /><path d="m19.07 4.93-1.41 1.41" /></svg>
                        ) : (
                            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-blue-400"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" /></svg>
                        )}
                    </button>
                </div>
            </div>

            {/* Dashboard Content */}
            <div className="w-full max-w-6xl p-6 md:p-12 flex flex-col gap-8 flex-1">
                <div className="flex flex-col gap-2">
                    <h1 className="text-3xl font-bold text-text-primary tracking-tight">Kairo — Support Console</h1>
                    <p className="text-text-secondary text-sm">Empower your support agents and administrators with document intelligence and tickets tracking.</p>
                </div>

                {/* Tabs Bar */}
                <div className="flex border-b border-border-default gap-6 text-sm text-text-secondary mt-2">
                    <button
                        onClick={() => setActiveTab('documents')}
                        className={cn("pb-3 font-medium transition-all relative flex items-center gap-1.5", activeTab === 'documents' ? "text-accent-text font-semibold" : "hover:text-accent-text")}
                    >
                        <FileText size={15} />
                        Knowledge Documents
                        {activeTab === 'documents' && <span className="absolute bottom-0 left-0 w-full h-[2px] bg-accent rounded-full" />}
                    </button>

                    <button
                        onClick={() => setActiveTab('graph')}
                        className={cn("pb-3 font-medium transition-all relative flex items-center gap-1.5", activeTab === 'graph' ? "text-accent-text font-semibold" : "hover:text-accent-text")}
                    >
                        <Network size={15} />
                        Knowledge Graph
                        {activeTab === 'graph' && <span className="absolute bottom-0 left-0 w-full h-[2px] bg-accent rounded-full" />}
                    </button>


                    <button
                        onClick={() => setActiveTab('analytics')}
                        className={cn("pb-3 font-medium transition-all relative flex items-center gap-1.5", activeTab === 'analytics' ? "text-accent-text font-semibold" : "hover:text-text-primary")}
                    >
                        <BarChart2 size={15} />
                        Analytics & Gaps
                        {activeTab === 'analytics' && <span className="absolute bottom-0 left-0 w-full h-[2px] bg-accent rounded-full" />}
                    </button>

                    <button
                        onClick={() => { setActiveTab('activity'); fetchActivityLogs(); }}
                        className={cn("pb-3 font-medium transition-all relative flex items-center gap-1.5", activeTab === 'activity' ? "text-accent-text font-semibold" : "hover:text-text-primary")}
                    >
                        <Activity size={15} />
                        Activity Logs
                        {activeTab === 'activity' && <span className="absolute bottom-0 left-0 w-full h-[2px] bg-accent rounded-full" />}
                    </button>
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1.85fr)_minmax(340px,0.95fr)] gap-8 flex-1 min-h-0">
                    <div className="lg:col-span-2 flex flex-col gap-6">

                        {/* TAB 1: Documents Management */}
                        {activeTab === 'documents' && (
                            <>
                                <UploadComponent onUploadSuccess={fetchFiles} />

                                <div className="bg-card-background border border-border-default rounded-2xl p-6 shadow-xl flex-1 flex flex-col min-h-[300px]">
                                    <h3 className="font-medium text-text-primary flex items-center gap-2 mb-4">
                                        <FileText size={18} className="text-accent-text" />
                                        Indexed Knowledge Base
                                    </h3>
                                    {files.length === 0 ? (
                                        <div className="text-center py-8 text-text-secondary text-sm">No documents found. Upload one to start tracking.</div>
                                    ) : (
                                        <div className="flex flex-col gap-3 overflow-y-auto flex-1 custom-scrollbar pr-2 min-h-0">
                                            {files.map((f, idx) => (
                                                <div key={idx} className="flex items-center justify-between p-3 rounded-lg bg-bg-tertiary border border-border-default hover:bg-bg-primary transition-colors">
                                                    <div className="flex items-center gap-3 overflow-hidden">
                                                        <div className="w-8 h-8 rounded-full bg-accent-soft flex items-center justify-center flex-shrink-0">
                                                            <FileText size={14} className="text-accent-text" />
                                                        </div>
                                                        <div className="overflow-hidden">
                                                            <p className="text-sm font-medium text-text-primary truncate">{f.filename}</p>
                                                            <div className="flex items-center gap-2 text-xs text-text-secondary">
                                                                <span>{(f.size / 1024 / 1024).toFixed(2)} MB</span>
                                                                {f.status === "indexed" && (
                                                                    <>
                                                                        <span className="text-text-secondary">·</span>
                                                                        <span>{f.chunk_count} chunks</span>
                                                                    </>
                                                                )}
                                                                {(f.status === "queued" || f.status === "processing") && (
                                                                    <span className="flex items-center gap-1 text-yellow-400 font-medium">
                                                                        <Loader2 size={10} className="animate-spin" />
                                                                        {f.status === "queued" ? "Queued" : "Indexing"}
                                                                    </span>
                                                                )}
                                                                {f.status === "error" && (
                                                                    <span
                                                                        className="flex items-center gap-1 text-red-400 font-medium truncate max-w-[220px]"
                                                                        title={f.error_detail || "Indexing failed"}
                                                                    >
                                                                        <AlertCircle size={10} />
                                                                        Indexing failed
                                                                    </span>
                                                                )}
                                                            </div>
                                                        </div>
                                                    </div>
                                                    <div className="flex items-center gap-4 text-xs text-text-secondary flex-shrink-0">
                                                        <div className="flex items-center gap-1.5">
                                                            <Clock size={12} />
                                                            <span>{new Date(f.uploaded_at).toLocaleDateString()}</span>
                                                        </div>                                                         {/* Re-index button with live state */}
                                                        {(() => {
                                                            const st = reindexState[f.filename] || "idle";
                                                            if (st === "loading") return (
                                                                <span className="flex items-center gap-1.5 text-yellow-400 font-medium cursor-wait">
                                                                    <Loader2 size={12} className="animate-spin" />
                                                                    Indexing...
                                                                </span>
                                                            );
                                                            if (st === "done") return (
                                                                <span className="flex items-center gap-1.5 text-green-400 font-medium">
                                                                    <CheckCircle2 size={12} />
                                                                    Indexed!
                                                                </span>
                                                            );
                                                            if (st.startsWith("error:")) return (
                                                                <span className="flex items-center gap-1.5 text-red-400 font-medium max-w-[140px] truncate" title={st.slice(6)}>
                                                                    Failed
                                                                </span>
                                                            );
                                                            return (
                                                                <button
                                                                    onClick={() => handleReindex(f.filename)}
                                                                    className="flex items-center gap-1.5 text-accent-text hover:text-accent-strong font-medium transition-colors"
                                                                    title="Re-index this document"
                                                                >
                                                                    <RotateCcw size={12} />
                                                                    Re-index
                                                                </button>
                                                            );
                                                        })()}

                                                        {/* Delete button with live state */}
                                                        {deleteState[f.filename] === "loading" ? (
                                                            <span className="flex items-center gap-1 text-text-secondary cursor-wait">
                                                                <Loader2 size={12} className="animate-spin" />
                                                            </span>
                                                        ) : (
                                                            <button
                                                                onClick={() => setFileToDelete(f.filename)}
                                                                className="p-1 hover:bg-red-500/10 text-text-secondary hover:text-red-400 rounded transition-colors"
                                                                title="Delete document"
                                                            >
                                                                <Trash2 size={13} />
                                                            </button>
                                                        )}
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            </>
                        )}

                        {/* TAB 1.5: Knowledge Graph Synthesis */}
                        {activeTab === 'graph' && (
                            <KnowledgeGraphView onGoToUpload={() => setActiveTab('documents')} />
                        )}

                        {/* TAB 2: Support Tickets (Interactive Table) */}
                        {activeTab === 'tickets' && (
                            <div className="bg-card-background border border-border-default rounded-2xl p-6 shadow-xl flex-1 flex flex-col min-h-[400px]">
                                <h3 className="font-medium text-text-primary flex items-center gap-2 mb-4">
                                    <Ticket size={18} className="text-accent-text" />
                                    Active Support Tickets ({tickets.length})
                                </h3>

                                {tickets.length === 0 ? (
                                    <div className="text-center py-12 text-text-secondary text-sm">No support tickets filed yet.</div>
                                ) : (
                                    <div className="flex flex-col gap-4 overflow-y-auto flex-1 custom-scrollbar pr-2 min-h-0">
                                        {tickets.map((t) => (
                                            <div key={t.id} className="p-4 rounded-xl bg-bg-tertiary border border-border-default hover:bg-bg-primary transition-all flex flex-col gap-3 relative">
                                                <div className="flex items-center justify-between">
                                                    <div className="flex items-center gap-2">
                                                        <span className="text-xs font-mono bg-accent-softer text-accent-text px-2 py-0.5 rounded font-semibold">{t.id}</span>
                                                        <h4 className="text-sm font-semibold text-text-primary truncate max-w-xs">{t.subject}</h4>
                                                    </div>
                                                    <div className="flex items-center gap-2">
                                                        <span className={cn(
                                                            "text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded",
                                                            t.priority === "Urgent" ? "bg-red-500/10 text-red-500 border border-red-500/20" :
                                                                t.priority === "High" ? "bg-amber-500/10 text-amber-500 border border-amber-500/20" :
                                                                    t.priority === "Medium" ? "bg-blue-500/10 text-blue-500 border border-blue-500/20" :
                                                                        "bg-bg-secondary text-text-secondary border border-border-default"
                                                        )}>
                                                            {t.priority}
                                                        </span>
                                                        <span className={cn(
                                                            "text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded",
                                                            t.status === "Resolved" ? "bg-green-500/10 text-green-400 border border-green-500/20" :
                                                                t.status === "In Progress" ? "bg-yellow-500/10 text-yellow-400 border border-yellow-500/20" :
                                                                    "bg-accent-soft text-accent-text border border-accent-line"
                                                        )}>
                                                            {t.status}
                                                        </span>
                                                    </div>
                                                </div>

                                                <p className="text-xs text-text-secondary opacity-90 leading-relaxed font-sans">{t.description}</p>

                                                <div className="flex items-center justify-between border-t border-border-default pt-3 mt-1 text-[11px] text-text-secondary opacity-70">
                                                    <div className="flex items-center gap-1">
                                                        <Clock size={12} />
                                                        <span>Filed by {t.user} on {new Date(t.createdAt).toLocaleString()}</span>
                                                    </div>
                                                    <div className="flex items-center gap-2">
                                                        {t.status !== "In Progress" && t.status !== "Resolved" && (
                                                            <button
                                                                onClick={() => handleUpdateTicketStatus(t.id, "In Progress")}
                                                                className="px-2 py-1 bg-yellow-500/10 text-yellow-400 hover:bg-yellow-500/20 rounded font-semibold transition-colors"
                                                            >
                                                                Investigate
                                                            </button>
                                                        )}
                                                        {t.status !== "Resolved" && (
                                                            <button
                                                                onClick={() => handleUpdateTicketStatus(t.id, "Resolved")}
                                                                className="px-2 py-1 bg-green-500/10 text-green-400 hover:bg-green-500/20 rounded font-semibold transition-colors"
                                                            >
                                                                Mark Resolved
                                                            </button>
                                                        )}
                                                        <button
                                                            onClick={() => handleDeleteTicket(t.id)}
                                                            className="p-1 hover:bg-red-500/10 text-text-secondary hover:text-red-400 rounded transition-colors"
                                                            title="Delete Ticket"
                                                        >
                                                            <Trash2 size={13} />
                                                        </button>
                                                    </div>
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                        )}

                        {/* TAB 3: FAQ Canned Layer (Integrated UI) */}
                        {activeTab === 'faq' && (
                            <div className="bg-card-background border border-border-default rounded-2xl p-6 shadow-xl flex-1 flex flex-col min-h-[400px]">
                                <div className="border-b border-border-default pb-4 mb-4">
                                    <h3 className="font-medium text-text-primary flex items-center gap-2">
                                        <HelpCircle size={18} className="text-accent-text" />
                                        FAQ Canned Responses Cache
                                    </h3>
                                    <p className="text-xs text-text-secondary mt-1">Configure instantaneous, rule-based canned responses for high-criticality questions to bypass LLM RAG pipelines.</p>
                                </div>

                                <div className="flex flex-col gap-4 mb-6">
                                    <div className="grid grid-cols-2 gap-4">
                                        <div>
                                            <label className="block text-[11px] text-text-secondary mb-1">Matching Keyword/Phrase</label>
                                            <input
                                                type="text"
                                                placeholder="e.g. fire emergency, evac protocol"
                                                value={newKeyword}
                                                onChange={(e) => setNewKeyword(e.target.value)}
                                                className="w-full text-xs p-2.5 bg-input-background border border-border-default rounded-lg focus:outline-none text-text-primary focus:border-accent animate-none font-sans"
                                            />
                                        </div>
                                        <div>
                                            <label className="block text-[11px] text-text-secondary mb-1">Cache Status</label>
                                            <select
                                                value={newIsActive ? "Active" : "Bypass"}
                                                onChange={(e) => setNewIsActive(e.target.value === "Active")}
                                                className="w-full text-xs p-2.5 bg-input-background border border-border-default rounded-lg focus:outline-none text-text-primary focus:border-accent font-sans"
                                            >
                                                <option value="Active">Active / Low Latency Router</option>
                                                <option value="Bypass">Bypass / Draft Mode</option>
                                            </select>
                                        </div>
                                    </div>
                                    <div>
                                        <label className="block text-[11px] text-text-secondary mb-1">Canned Output Response</label>
                                        <textarea
                                            rows={3}
                                            placeholder="Paste deterministic message text to display..."
                                            value={newResponse}
                                            onChange={(e) => setNewResponse(e.target.value)}
                                            className="w-full text-xs p-2.5 bg-input-background border border-border-default rounded-lg focus:outline-none text-text-primary focus:border-accent resize-none font-sans"
                                        ></textarea>
                                    </div>
                                    <div className="flex justify-end">
                                        <button
                                            onClick={handleAddFaq}
                                            className="px-4 py-2 bg-accent text-accent-ink rounded-lg text-xs font-semibold hover:bg-accent-strong transition-colors cursor-pointer"
                                        >
                                            Add Rule
                                        </button>
                                    </div>
                                </div>

                                <div className="flex flex-col gap-3">
                                    <div className="text-xs font-semibold text-text-secondary mb-1 flex items-center gap-1">Active Rules ({faqs.length})</div>
                                    {faqs.length === 0 ? (
                                        <div className="text-center py-6 text-text-secondary text-xs">No active rules. Add one above.</div>
                                    ) : (
                                        <div className="flex flex-col gap-3 overflow-y-auto max-h-[300px] pr-2 custom-scrollbar">
                                            {faqs.map((faq) => (
                                                <div key={faq.id} className="p-3 bg-bg-tertiary border border-border-default rounded-lg flex items-center justify-between text-xs hover:bg-bg-primary transition-colors">
                                                    <div className="space-y-1 overflow-hidden mr-4">
                                                        <div className="font-semibold text-accent-strong truncate">"{faq.keyword}"</div>
                                                        <div className="text-text-secondary whitespace-pre-wrap">{faq.response}</div>
                                                    </div>
                                                    <div className="flex items-center gap-3 shrink-0">
                                                        <span className={cn(
                                                            "text-[10px] px-1.5 py-0.5 rounded border uppercase tracking-wider font-bold",
                                                            faq.is_active ? "bg-green-500/10 text-green-400 border-green-500/20" : "bg-bg-secondary text-text-secondary border-border-default"
                                                        )}>
                                                            {faq.is_active ? "Cached" : "Bypassed"}
                                                        </span>
                                                        <button
                                                            onClick={() => setFaqToDelete(faq.id)}
                                                            className="p-1 hover:bg-red-500/10 text-text-secondary hover:text-red-400 rounded transition-colors"
                                                            title="Delete Rule"
                                                        >
                                                            <Trash2 size={13} />
                                                        </button>
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            </div>
                        )}

                        {/* TAB 4: Analytics & Gap Analysis (Integrated UI) */}
                        {activeTab === 'analytics' && (
                            <div className="bg-card-background border border-border-default rounded-2xl p-6 shadow-xl flex-1 flex flex-col min-h-[400px]">
                                <div className="border-b border-border-default pb-4 mb-4">
                                    <h3 className="font-medium text-text-primary flex items-center gap-2">
                                        <BarChart2 size={18} className="text-accent-text" />
                                        Knowledge Gap Analytics
                                    </h3>
                                    <p className="text-xs text-text-secondary mt-1">Discover what support agents are asking that the knowledge base cannot currently answer.</p>
                                </div>

                                <div className="grid grid-cols-3 gap-4 mb-6">
                                    <div className="p-4 bg-bg-tertiary rounded-xl border border-border-default flex flex-col">
                                        <span className="text-text-secondary text-xs font-medium">Failed Retrievals</span>
                                        <span className="text-2xl font-bold text-red-400 mt-1">{analyticsData.failed_rate}</span>
                                        <span className="text-[10px] text-text-secondary opacity-70 mt-1">LLM Fallback Search Rate</span>
                                    </div>
                                    <div className="p-4 bg-bg-tertiary rounded-xl border border-border-default flex flex-col">
                                        <span className="text-text-secondary text-xs font-medium">Total Failed Queries</span>
                                        <span className="text-2xl font-bold text-amber-400 mt-1">{analyticsData.total_failed}</span>
                                        <span className="text-[10px] text-text-secondary opacity-70 mt-1">Total recorded gaps</span>
                                    </div>
                                    <div className="p-4 bg-bg-tertiary rounded-xl border border-border-default flex flex-col">
                                        <span className="text-text-secondary text-xs font-medium">Answer Satisfaction</span>
                                        <span className="text-2xl font-bold text-emerald-400 mt-1">
                                            {feedbackData?.satisfaction_rate ?? "–"}
                                        </span>
                                        <span className="text-[10px] text-text-secondary opacity-70 mt-1">
                                            {feedbackData ? `${feedbackData.total} rating${feedbackData.total === 1 ? "" : "s"} from agents` : "No ratings yet"}
                                        </span>
                                    </div>
                                </div>

                                {/* Answer quality — sourced from real thumbs up/down, not localStorage */}
                                <div className="mb-6 p-4 bg-white/5 rounded-xl border border-white/5">
                                    <div className="flex items-center justify-between mb-3">
                                        <span className="text-xs font-semibold text-gray-400">Answer Quality Feedback</span>
                                        {feedbackData?.avg_confidence !== null && feedbackData?.avg_confidence !== undefined && (
                                            <span className="text-[10px] text-gray-500">
                                                Mean retrieval confidence: {Math.round(feedbackData.avg_confidence * 100)}%
                                            </span>
                                        )}
                                    </div>

                                    <div className="flex items-center gap-6 mb-3">
                                        <span className="flex items-center gap-1.5 text-sm text-emerald-400 font-semibold">
                                            <ThumbsUp size={14} /> {feedbackData?.helpful ?? 0}
                                        </span>
                                        <span className="flex items-center gap-1.5 text-sm text-red-400 font-semibold">
                                            <ThumbsDown size={14} /> {feedbackData?.not_helpful ?? 0}
                                        </span>
                                    </div>

                                    {feedbackData && feedbackData.recent_negative.length > 0 && (
                                        <div className="space-y-2 max-h-[180px] overflow-y-auto custom-scrollbar pr-1 border-t border-white/5 pt-3">
                                            <div className="text-[10px] uppercase tracking-wider text-gray-500 font-semibold">Recently flagged answers</div>
                                            {feedbackData.recent_negative.map((n) => (
                                                <div key={n.message_id} className="p-2.5 bg-red-500/5 border border-red-500/10 rounded-lg text-xs">
                                                    <p className="text-gray-300 line-clamp-2 leading-relaxed">{n.answer_preview}</p>
                                                    <div className="flex items-center gap-2 mt-1 text-[10px] text-gray-500">
                                                        <span>{n.source_type ?? "unknown source"}</span>
                                                        {n.confidence !== null && <span>· {Math.round(n.confidence * 100)}% confidence</span>}
                                                        {n.created_at && <span>· {new Date(n.created_at).toLocaleString()}</span>}
                                                    </div>
                                                    {n.comment && <p className="text-[11px] text-amber-300/80 mt-1 italic">"{n.comment}"</p>}
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>

                                <div className="space-y-4">
                                    <div className="text-xs font-semibold text-text-secondary flex items-center gap-1">Top Unanswered Queries ({analyticsData.gaps.length})</div>
                                    {analyticsData.gaps.length === 0 ? (
                                        <div className="text-center py-8 text-text-secondary text-xs">No failed retrievals recorded yet.</div>
                                    ) : (
                                        <div className="space-y-2 max-h-[300px] overflow-y-auto custom-scrollbar pr-1">
                                            {analyticsData.gaps.map((gap, index) => (
                                                <div key={index} className="p-3 bg-red-500/5 border border-red-500/10 rounded-lg flex-col sm:flex-row flex sm:items-center justify-between text-xs hover:bg-red-500/10 transition-colors gap-2">
                                                    <div className="flex flex-col gap-0.5 overflow-hidden">
                                                        <span className="font-semibold text-text-primary truncate">"{gap.query_text}"</span>
                                                        <span className="text-[10px] text-text-secondary opacity-80">Last match attempt score: {gap.highest_score.toFixed(4)} • {new Date(gap.created_at).toLocaleString()}</span>
                                                    </div>
                                                    <span className="text-[10px] text-red-400 bg-red-400/10 px-2 py-0.5 rounded font-bold flex-shrink-0 self-start sm:self-center">
                                                        Unindexed ({gap.failure_count} {gap.failure_count === 1 ? 'request' : 'requests'})
                                                    </span>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            </div>
                        )}
                        {/* TAB 5: Activity Logs */}
                        {activeTab === 'activity' && (
                            <div className="bg-card-background border border-border-default rounded-2xl p-6 shadow-xl flex-1 flex flex-col min-h-[400px]">
                                <div className="border-b border-border-default pb-4 mb-4 flex justify-between items-center">
                                    <div>
                                        <h3 className="font-medium text-text-primary flex items-center gap-2">
                                            <Activity size={18} className="text-accent-text" />
                                            Admin Activity Logs
                                        </h3>
                                        <p className="text-xs text-text-secondary mt-1">Audit trail of actions performed by support personnel and admins.</p>
                                    </div>
                                    <button
                                        onClick={fetchActivityLogs}
                                        className="text-xs bg-button-secondary border border-border-default rounded-lg px-2.5 py-1 text-text-secondary hover:bg-bg-tertiary hover:text-text-primary transition-all flex items-center gap-1 font-medium cursor-pointer"
                                        title="Refresh Logs"
                                    >
                                        <RotateCcw size={12} />
                                        Refresh
                                    </button>
                                </div>

                                {activityLogs.length === 0 ? (
                                    <div className="text-center py-12 text-text-secondary text-sm">No activity logs recorded.</div>
                                ) : (
                                    <div className="overflow-x-auto flex-1 custom-scrollbar pr-2 min-h-0">
                                        <table className="w-full text-left border-collapse text-xs">
                                            <thead>
                                                <tr className="border-b border-border-default text-text-secondary font-semibold">
                                                    <th className="py-3 px-4">Timestamp</th>
                                                    <th className="py-3 px-4">User</th>
                                                    <th className="py-3 px-4">Action</th>
                                                    <th className="py-3 px-4">Target Item / Query</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {activityLogs.map((log, index) => (
                                                    <tr key={index} className="border-b border-border-default hover:bg-bg-tertiary text-text-secondary transition-colors">
                                                        <td className="py-3 px-4 whitespace-nowrap text-text-secondary opacity-75 font-medium font-sans">
                                                            {new Date(log.timestamp).toLocaleString()}
                                                        </td>
                                                        <td className="py-3 px-4 font-semibold text-text-primary">
                                                            {log.username}
                                                        </td>
                                                        <td className="py-3 px-4">
                                                            <span className={cn(
                                                                "px-2 py-0.5 rounded-[4px] font-bold text-[9px] uppercase tracking-wider",
                                                                log.action === "Login" ? "bg-green-500/10 text-green-400 border border-green-500/15" :
                                                                    log.action === "Logout" ? "bg-bg-secondary text-text-secondary border border-border-default" :
                                                                        log.action === "Upload" ? "bg-blue-500/10 text-blue-400 border border-blue-500/15" :
                                                                            log.action === "Delete" ? "bg-red-500/10 text-red-400 border border-red-500/15" :
                                                                                log.action === "Re-index" ? "bg-yellow-500/10 text-yellow-400 border border-yellow-500/15" :
                                                                                    log.action === "FAQ Added" ? "bg-accent-soft text-accent-text border border-accent/15" :
                                                                                        log.action === "FAQ Deleted" ? "bg-pink-500/10 text-pink-400 border border-pink-500/15" :
                                                                                            "bg-amber-500/10 text-amber-400 border border-amber-500/15"
                                                            )}>
                                                                {log.action}
                                                            </span>
                                                        </td>
                                                        <td className="py-3 px-4 truncate max-w-xs font-mono font-medium" title={log.target || ""}>
                                                            {log.target || "—"}
                                                        </td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    </div>
                                )}
                            </div>
                        )}

                    </div>

                    {/* Quick Stats / Info sidebar */}
                    <div className="flex flex-col gap-6">
                        <div className="bg-card-background border border-border-default rounded-2xl p-6 shadow-xl">
                            <h3 className="font-medium text-text-primary flex items-center gap-2 mb-4">
                                <Database size={18} className="text-blue-400" />
                                Database Status
                            </h3>
                            <div className="space-y-4">
                                <div className="flex justify-between items-center text-sm">
                                    <span className="text-text-secondary">Vector Store</span>
                                    <span className={cn(
                                        "flex items-center gap-1.5 font-medium",
                                        systemStatus.vectorStore === "Online" ? "text-green-400" :
                                            systemStatus.vectorStore === "Offline" ? "text-red-400" : "text-yellow-400"
                                    )}>
                                        <span className={cn(
                                            "w-2 h-2 rounded-full inline-block animate-pulse",
                                            systemStatus.vectorStore === "Online" ? "bg-green-500" :
                                                systemStatus.vectorStore === "Offline" ? "bg-red-500" : "bg-yellow-500"
                                        )}></span>
                                        {systemStatus.vectorStore}
                                    </span>
                                </div>
                                <div className="flex justify-between items-center text-sm">
                                    <span className="text-text-secondary">Embedding Model</span>
                                    <span className="text-text-primary">Active (Ada-002)</span>
                                </div>
                                <div className="flex justify-between items-center text-sm">
                                    <span className="text-text-secondary">SQLite Base</span>
                                    <span className={cn(
                                        "flex items-center gap-1.5 font-medium",
                                        systemStatus.sqLite === "Online" ? "text-green-400" :
                                            systemStatus.sqLite === "Offline" ? "text-red-400" : "text-yellow-400"
                                    )}>
                                        <span className={cn(
                                            "w-2 h-2 rounded-full inline-block animate-pulse",
                                            systemStatus.sqLite === "Online" ? "bg-green-500" :
                                                systemStatus.sqLite === "Offline" ? "bg-red-500" : "bg-yellow-500"
                                        )}></span>
                                        {systemStatus.sqLite}
                                    </span>
                                </div>
                            </div>
                        </div>

                        <div className="bg-card-background border border-border-default rounded-2xl p-6 shadow-xl">
                            <h3 className="font-medium text-text-primary flex items-center gap-2 mb-4">
                                <Settings size={18} className="text-accent-text font-bold" />
                                Advanced Settings
                            </h3>
                            <p className="text-sm text-text-secondary leading-relaxed mb-4 font-sans">
                                Chunking size, retrieval thresholds, system prompts, and RAG toggles can be managed dynamically.
                            </p>
                            <button
                                onClick={() => setIsSettingsOpen(true)}
                                className="w-full py-2.5 bg-accent hover:bg-accent-strong text-xs text-accent-ink font-semibold rounded-lg transition-colors cursor-pointer shadow-md"
                            >
                                Manage Settings
                            </button>
                        </div>
                    </div>
                </div>
            </div>

            {/* Custom Deletion Confirmation Modal for FAQ rules */}
            {faqToDelete !== null && (
                <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[100] flex items-center justify-center p-4 animate-in fade-in duration-300">
                    <div className="bg-card-background border border-border-default w-full max-w-sm rounded-2xl overflow-hidden shadow-md relative font-sans">
                        <div className="absolute top-0 left-0 w-full h-1 bg-red-500"></div>
                        <div className="p-6 text-center">
                            <div className="w-12 h-12 bg-red-500/10 text-red-500 rounded-full flex items-center justify-center mx-auto mb-4 shadow-inner">
                                <Trash2 size={20} />
                            </div>
                            <h3 className="text-base font-semibold text-text-primary mb-2 font-sans">Delete FAQ Rule?</h3>
                            <p className="text-xs text-text-secondary mb-6 leading-relaxed font-sans">
                                Are you sure you want to delete this FAQ rule? This will remove the instant cached response mapping.
                            </p>
                            <div className="flex gap-3 justify-center">
                                <button
                                    onClick={() => setFaqToDelete(null)}
                                    className="px-4 py-2 bg-button-secondary hover:bg-bg-tertiary border border-border-default rounded-xl text-xs font-medium text-text-secondary transition-colors focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none outline-none cursor-pointer font-sans"
                                >
                                    Cancel
                                </button>
                                <button
                                    onClick={async () => {
                                        const id = faqToDelete;
                                        setFaqToDelete(null);
                                        await confirmDeleteFaq(id);
                                    }}
                                    className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-xl text-xs font-semibold transition-colors focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:outline-none outline-none cursor-pointer font-sans"
                                >
                                    Delete
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* Custom Deletion Confirmation Modal for indexed documents */}
            {fileToDelete !== null && (
                <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[100] flex items-center justify-center p-4 animate-in fade-in duration-300">
                    <div className="bg-card-background border border-border-default w-full max-w-xs rounded-2xl overflow-hidden shadow-md relative font-sans">
                        <div className="absolute top-0 left-0 w-full h-1 bg-red-500"></div>
                        <div className="p-6 text-center">
                            <div className="w-12 h-12 bg-red-500/10 text-red-500 rounded-full flex items-center justify-center mx-auto mb-4 shadow-inner">
                                <Trash2 size={20} />
                            </div>
                            <h3 className="text-base font-semibold text-text-primary mb-2 font-sans">Delete Document?</h3>
                            <p className="text-xs text-text-secondary mb-6 leading-relaxed break-all px-2 font-sans" title={fileToDelete}>
                                Are you sure you want to delete "{fileToDelete}"? This cannot be undone.
                            </p>
                            <div className="flex gap-3 justify-center">
                                <button
                                    onClick={() => setFileToDelete(null)}
                                    className="px-4 py-2 bg-button-secondary hover:bg-bg-tertiary border border-border-default rounded-xl text-xs font-medium text-text-secondary transition-colors focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none outline-none cursor-pointer font-sans"
                                >
                                    Cancel
                                </button>
                                <button
                                    onClick={async () => {
                                        const fname = fileToDelete;
                                        setFileToDelete(null);
                                        await confirmDeleteFile(fname);
                                    }}
                                    className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-xl text-xs font-semibold transition-colors focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:outline-none outline-none cursor-pointer font-sans"
                                >
                                    Delete
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* Settings Drawer */}
            {isSettingsOpen && (
                <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[100] flex justify-end animate-in fade-in duration-300">
                    <div
                        className="bg-card-background border-l border-border-default w-full max-w-xl h-full flex flex-col shadow-md relative animate-in slide-in-from-right duration-300 font-sans"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="absolute top-0 left-0 w-1 h-full bg-gradient-to-b from-accent via-blue-500 to-cyan-400"></div>

                        <div className="p-6 border-b border-border-default flex items-center justify-between">
                            <h3 className="text-lg font-semibold text-text-primary flex items-center gap-2 font-sans">
                                <Settings className="text-accent-text font-bold" size={20} />
                                Manage RAG System Settings
                            </h3>
                            <button
                                onClick={() => setIsSettingsOpen(false)}
                                className="p-1 hover:bg-bg-tertiary rounded-xl text-text-secondary hover:text-text-primary transition-all focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none outline-none cursor-pointer"
                            >
                                <X size={18} />
                            </button>
                        </div>

                        <div className="flex-1 overflow-y-auto custom-scrollbar p-6 space-y-6">
                            {/* RAG Parameters */}
                            <div className="space-y-4">
                                <h4 className="text-sm font-semibold text-accent-strong uppercase tracking-wider font-sans">RAG Chunking & Retrieval</h4>

                                <div className="grid grid-cols-2 gap-4">
                                    <div>
                                        <label className="block text-xs font-semibold text-text-secondary mb-1 font-sans">Chunk Size (chars)</label>
                                        <input
                                            type="number"
                                            value={chunkSize}
                                            onChange={(e) => setChunkSize(parseInt(e.target.value) || 0)}
                                            className="w-full p-2.5 bg-input-background border border-border-default rounded-xl text-text-primary text-sm focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none outline-none font-sans font-medium"
                                        />
                                    </div>
                                    <div>
                                        <label className="block text-xs font-semibold text-text-secondary mb-1 font-sans">Chunk Overlap (chars)</label>
                                        <input
                                            type="number"
                                            value={chunkOverlap}
                                            onChange={(e) => setChunkOverlap(parseInt(e.target.value) || 0)}
                                            className="w-full p-2.5 bg-input-background border border-border-default rounded-xl text-text-primary text-sm focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none outline-none font-sans font-medium"
                                        />
                                    </div>
                                </div>

                                <div className="grid grid-cols-2 gap-4">
                                    <div>
                                        <label className="block text-xs font-semibold text-text-secondary mb-1 font-sans">LLM Temperature</label>
                                        <input
                                            type="number"
                                            step="0.1"
                                            min="0"
                                            max="2"
                                            value={temperature}
                                            onChange={(e) => setTemperature(parseFloat(e.target.value) || 0)}
                                            className="w-full p-2.5 bg-input-background border border-border-default rounded-xl text-text-primary text-sm focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none outline-none font-sans font-medium"
                                        />
                                    </div>
                                    <div>
                                        <label className="block text-xs font-semibold text-text-secondary mb-1 font-sans">Top-K Retrieval</label>
                                        <input
                                            type="number"
                                            value={topK}
                                            onChange={(e) => setTopK(parseInt(e.target.value) || 0)}
                                            className="w-full p-2.5 bg-input-background border border-border-default rounded-xl text-text-primary text-sm focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none outline-none font-sans font-medium"
                                        />
                                    </div>
                                </div>

                                <div className="grid grid-cols-2 gap-4">
                                    <div>
                                        <label className="block text-xs font-semibold text-text-secondary mb-1 font-sans">Similarity Threshold</label>
                                        <input
                                            type="number"
                                            step="0.01"
                                            min="0"
                                            max="1"
                                            value={similarityThreshold}
                                            onChange={(e) => setSimilarityThreshold(parseFloat(e.target.value) || 0)}
                                            className="w-full p-2.5 bg-input-background border border-border-default rounded-xl text-text-primary text-sm focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none outline-none font-sans font-medium"
                                        />
                                    </div>
                                    <div>
                                        <label className="block text-xs font-semibold text-text-secondary mb-1 font-sans">Max Context Chunks</label>
                                        <input
                                            type="number"
                                            value={maxContextChunks}
                                            onChange={(e) => setMaxContextChunks(parseInt(e.target.value) || 0)}
                                            className="w-full p-2.5 bg-input-background border border-border-default rounded-xl text-text-primary text-sm focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none outline-none font-sans font-medium"
                                        />
                                    </div>
                                </div>
                            </div>

                            {/* Feature Toggles */}
                            <div className="space-y-3.5 pt-2">
                                <h4 className="text-sm font-semibold text-accent-strong uppercase tracking-wider font-sans">Feature Toggles</h4>

                                <div className="flex items-center justify-between p-3 bg-bg-tertiary border border-border-default rounded-xl">
                                    <div>
                                        <p className="text-sm font-medium text-text-primary">Enable FAQ Router</p>
                                        <p className="text-xs text-text-secondary">Route questions directly to canned answers if keyword matched</p>
                                    </div>
                                    <input
                                        type="checkbox"
                                        checked={enableFaqRouter}
                                        onChange={(e) => setEnableFaqRouter(e.target.checked)}
                                        className="w-4 h-4 accent-[var(--accent)] cursor-pointer focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none outline-none"
                                    />
                                </div>

                                <div className="flex items-center justify-between p-3 bg-bg-tertiary border border-border-default rounded-xl">
                                    <div>
                                        <p className="text-sm font-medium text-text-primary">Enable Web Search Fallback</p>
                                        <p className="text-xs text-text-secondary">Search Exa web if no relevant document context exists</p>
                                    </div>
                                    <input
                                        type="checkbox"
                                        checked={enableWebSearch}
                                        onChange={(e) => setEnableWebSearch(e.target.checked)}
                                        className="w-4 h-4 accent-[var(--accent)] cursor-pointer focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none outline-none"
                                    />
                                </div>

                                <div className="flex items-center justify-between p-3 bg-bg-tertiary border border-border-default rounded-xl">
                                    <div>
                                        <p className="text-sm font-medium text-text-primary">Log Failed Retrievals</p>
                                        <p className="text-xs text-text-secondary">Record gaps when user searches have low similarity scores</p>
                                    </div>
                                    <input
                                        type="checkbox"
                                        checked={enableFailedLogging}
                                        onChange={(e) => setEnableFailedLogging(e.target.checked)}
                                        className="w-4 h-4 accent-[var(--accent)] cursor-pointer focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none outline-none"
                                    />
                                </div>
                            </div>

                            {/* System Prompt Editor */}
                            <div className="space-y-2 pt-2">
                                <h4 className="text-sm font-semibold text-accent-strong uppercase tracking-wider font-sans">System Prompt Editor</h4>
                                <p className="text-xs text-text-secondary leading-relaxed font-sans">
                                    Customize Kairo's RAG instructions. Make sure to keep the required placeholders <code className="text-accent-strong font-semibold">{`{context}`}</code> and <code className="text-accent-strong font-semibold">{`{question}`}</code>.
                                </p>
                                <textarea
                                    rows={10}
                                    value={systemPrompt}
                                    onChange={(e) => setSystemPrompt(e.target.value)}
                                    className="w-full p-3 bg-input-background border border-border-default rounded-xl text-text-primary text-xs font-mono leading-relaxed focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none outline-none resize-none custom-scrollbar"
                                />
                            </div>
                        </div>

                        <div className="p-6 border-t border-border-default flex gap-3 justify-end shrink-0">
                            <button
                                onClick={handleResetSettings}
                                className="px-4 py-2 bg-button-secondary hover:bg-bg-tertiary border border-border-default rounded-xl text-xs font-medium text-text-secondary transition-colors cursor-pointer focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none outline-none font-sans"
                            >
                                Reset to Default
                            </button>
                            <button
                                onClick={() => setIsSettingsOpen(false)}
                                className="px-4 py-2 bg-button-secondary hover:bg-bg-tertiary border border-border-default rounded-xl text-xs font-medium text-text-secondary transition-colors cursor-pointer focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none outline-none font-sans"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={handleSaveSettings}
                                className="px-4 py-2 bg-accent hover:bg-accent-strong text-accent-ink rounded-xl text-xs font-semibold transition-colors cursor-pointer font-sans focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none outline-none"
                            >
                                Save Changes
                            </button>
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
                        {toast.type === 'success' ? <CheckCircle2 size={16} className="text-green-400" /> :
                            toast.type === 'error' ? <AlertCircle size={16} className="text-red-400" /> :
                                <Loader2 size={16} className="animate-spin text-accent-text" />}
                        <span className="text-xs font-semibold">{toast.message}</span>
                        <button onClick={() => setToast(null)} className="hover:bg-button-secondary p-1 rounded-lg transition-colors text-text-secondary hover:text-text-primary focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none outline-none cursor-pointer">
                            <X size={12} />
                        </button>
                    </div>
                </div>
            )}
        </main>
    );
}
