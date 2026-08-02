"use client";

import React, { useEffect, useState, useMemo, useCallback } from "react";
import {
  ReactFlow,
  Controls,
  Background,
  MiniMap,
  useNodesState,
  useEdgesState,
  MarkerType,
  Node,
  Edge,
  Position,
  Handle,
  useReactFlow,
  ReactFlowProvider
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import dagre from "dagre";
import {
  Network as NetworkIcon,
  Share2,
  Database,
  Search,
  Sparkles,
  RefreshCw,
  FileText,
  ShieldCheck,
  CheckCircle2,
  Layers,
  ZoomIn,
  ZoomOut,
  Maximize2,
  Filter,
  Info,
  X,
  ChevronRight,
  Activity,
  Tag,
  Link as LinkIcon,
  AlertCircle,
  Compass,
  FileCode,
  Sliders,
  Crosshair,
  RotateCcw,
  Maximize,
  Focus,
  Zap,
  Globe,
  PlusCircle,
  Download,
  Grid
} from "lucide-react";
import { apiJson } from "../lib/api";

type GraphNodeData = {
  id: string;
  label: string;
  type: string;
  aliases: string[];
  document_count?: number;
  provenanceCount?: number;
  document_id?: string | number;
  page_number?: number;
  chunk_id?: string | number;
  source_text?: string;
  provenance?: Array<{
    document_id: string | number;
    page_number?: number;
    chunk_id: string | number;
    source_text: string;
    confidence?: number;
  }>;
};

type LyzrVerdict = {
  verdict: "SUPPORTED" | "PARTIALLY_SUPPORTED" | "UNSUPPORTED" | "UNPARSED";
  hallucination_risk: number | null;
  unsupported_claims: string[];
  reasoning: string;
  parsed: boolean;
  agent_id?: string;
};

type GraphEdgeData = {
  id: string;
  source: string;
  target: string;
  relation: string;
  confidence: number;
  document_id?: string | number;
  page_number?: number;
  chunk_id?: string | number;
  source_text?: string;
};

type GraphStats = {
  total_nodes: number;
  total_relationships: number;
  entity_type_counts: Record<string, number>;
  relationship_type_counts: Record<string, number>;
  documents_indexed: number;
};

type GraphRAGResponse = {
  question: string;
  answer: string;
  graph_context: string;
  evidence_context?: string;
  seed_entities: string[];
  subgraph: {
    nodes: GraphNodeData[];
    edges: GraphEdgeData[];
  };
  confidence: number;
  // Free-form tracing payload from the backend's 10-stage debug pipeline; its
  // shape varies by query path, so it is consumed defensively at each use.
  debug_info?: Record<string, any> | null;
};

// =========================================================
// NEO4J BLOOM PALETTE & TAXONOMY
// =========================================================
const ENTITY_COLORS: Record<string, { bg: string; border: string; text: string; dot: string }> = {
  Risk: { bg: "from-rose-950/90 to-rose-900/90", border: "#f43f5e", text: "#ffe4e6", dot: "#f43f5e" },
  Control: { bg: "from-emerald-950/90 to-emerald-900/90", border: "#10b981", text: "#d1fae5", dot: "#10b981" },
  Policy: { bg: "from-blue-950/90 to-blue-900/90", border: "#3b82f6", text: "#dbeafe", dot: "#3b82f6" },
  Requirement: { bg: "from-amber-950/90 to-amber-900/90", border: "#f59e0b", text: "#fef3c7", dot: "#f59e0b" },
  Vendor: { bg: "from-orange-950/90 to-orange-900/90", border: "#f97316", text: "#ffedd5", dot: "#f97316" },
  Asset: { bg: "from-indigo-950/90 to-indigo-900/90", border: "#6366f1", text: "#e0e7ff", dot: "#6366f1" },
  Audit: { bg: "from-violet-950/90 to-violet-900/90", border: "#8b5cf6", text: "#ede9fe", dot: "#8b5cf6" },
  System: { bg: "from-teal-950/90 to-teal-900/90", border: "#14b8a6", text: "#ccfbf1", dot: "#14b8a6" },
  Document: { bg: "from-cyan-950/90 to-cyan-900/90", border: "#06b6d4", text: "#cff4fc", dot: "#06b6d4" },
  Regulation: { bg: "from-fuchsia-950/90 to-fuchsia-900/90", border: "#d946ef", text: "#fdf4ff", dot: "#d946ef" },
  Department: { bg: "from-pink-950/90 to-pink-900/90", border: "#ec4899", text: "#fdf2f8", dot: "#ec4899" },
  Employee: { bg: "from-purple-950/90 to-purple-900/90", border: "#a855f7", text: "#faf5ff", dot: "#a855f7" },
  Procedure: { bg: "from-sky-950/90 to-sky-900/90", border: "#0ea5e9", text: "#f0f9ff", dot: "#0ea5e9" },
  Evidence: { bg: "from-lime-950/90 to-lime-900/90", border: "#84cc16", text: "#f7fee7", dot: "#84cc16" },
  Database: { bg: "from-indigo-950/90 to-indigo-900/90", border: "#6366f1", text: "#e0e7ff", dot: "#6366f1" },
  Server: { bg: "from-slate-950/90 to-slate-900/90", border: "#64748b", text: "#f1f5f9", dot: "#64748b" },
  Application: { bg: "from-pink-950/90 to-pink-900/90", border: "#ec4899", text: "#fdf2f8", dot: "#ec4899" },
};

const DEFAULT_COLOR = { bg: "from-gray-950/90 to-gray-900/90", border: "#9ca3af", text: "#f3f4f6", dot: "#9ca3af" };

const RELATION_COLORS: Record<string, string> = {
  IMPLEMENTS: "#10b981",   // emerald
  SATISFIES: "#10b981",    // emerald
  MITIGATES: "#3b82f6",    // blue
  OWNS: "#f59e0b",         // amber
  REFERENCES: "#8b5cf6",   // violet
  AUDITS: "#06b6d4",       // cyan
  DEPENDS_ON: "#f97316",   // orange
  GENERATED_BY: "#ec4899", // pink
  VIOLATES: "#ef4444",     // red
  RELATED_TO: "#9ca3af",   // gray
  GOVERNS: "#3b82f6",      // blue
  PROTECTS: "#10b981",     // emerald
  USES: "#ec4899"          // pink
};

// =========================================================
// CUSTOM SHINY COMPLIANCE NODE
// =========================================================
const CustomBloomNode = ({ data, selected }: { data: any; selected: boolean }) => {
  const type = data.type || "Requirement";
  const label = data.label || data.id;
  const connections = data.degree || 1;
  const isHighlighted = data.isHighlighted;
  const isFaded = data.isFaded;
  const [hovered, setHovered] = useState(false);

  const color = ENTITY_COLORS[type] || DEFAULT_COLOR;

  // Calculate dynamic node width based on text length to prevent clipping
  const labelLen = label.length;
  const width = Math.max(220, Math.min(220 + labelLen * 3.5, 380));

  return (
    <div
      style={{ width: `${width}px` }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className={`relative px-5 py-4 border-2 transition-all duration-300 backdrop-blur-md rounded-2xl shadow-xl flex flex-col items-center justify-center bg-gradient-to-br ${color.bg} ${
        selected
          ? "ring-4 ring-amber-400 border-white scale-105 shadow-amber-500/50 z-30"
          : isHighlighted
          ? "border-purple-400 ring-4 ring-purple-500/30 scale-105 z-20 shadow-purple-500/30"
          : "hover:scale-102 hover:border-white"
      } ${hovered ? "z-40" : ""} ${isFaded ? "opacity-20 grayscale" : "opacity-100"}`}
    >
      {/* HOVER EVIDENCE CARD — surfaces provenance without needing a click,
          so an entity can be traced back to its raw source text inline. */}
      {hovered && !isFaded && (
        <div className="absolute left-1/2 -translate-x-1/2 bottom-[calc(100%+12px)] w-[320px] z-50 pointer-events-none animate-in fade-in duration-150">
          <div className="bg-[#0b0e14] border-2 rounded-xl shadow-2xl overflow-hidden" style={{ borderColor: color.border }}>
            <div className="px-3 py-2 flex items-center justify-between border-b border-white/10" style={{ backgroundColor: `${color.border}22` }}>
              <div className="flex items-center gap-1.5 min-w-0">
                <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: color.dot }} />
                <span className="text-[10px] uppercase tracking-wider font-mono font-bold text-white/95 truncate">{type}</span>
              </div>
              <span className="text-[9px] font-mono font-bold text-white/70 shrink-0">{connections} link{connections === 1 ? "" : "s"}</span>
            </div>

            <div className="px-3 py-2.5 space-y-2">
              <p className="text-[13px] font-bold text-white leading-snug break-words">{label}</p>

              {data.aliases && data.aliases.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {data.aliases.slice(0, 4).map((a: string, i: number) => (
                    <span key={i} className="text-[9px] px-1.5 py-0.5 rounded bg-white/10 text-white/70 font-mono">{a}</span>
                  ))}
                </div>
              )}

              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[9px] font-mono text-white/60 pt-0.5">
                {data.documentId != null && <span>doc #{String(data.documentId)}</span>}
                {data.pageNumber != null && <span>page {String(data.pageNumber)}</span>}
                {data.chunkId != null && <span className="truncate max-w-[130px]">{String(data.chunkId)}</span>}
              </div>

              {data.sourceText && (
                <div className="pt-1.5 border-t border-white/10">
                  <p className="text-[8px] uppercase tracking-wider font-bold text-white/45 mb-1">Source evidence</p>
                  <p className="text-[10px] text-white/75 leading-relaxed line-clamp-4 whitespace-pre-wrap break-words">
                    {data.sourceText.slice(0, 260)}
                    {data.sourceText.length > 260 ? "…" : ""}
                  </p>
                </div>
              )}

              <p className="text-[9px] text-white/40 pt-1 border-t border-white/10">
                Click to inspect &middot; Double-click to expand neighbors
              </p>
            </div>
          </div>
          {/* caret */}
          <div
            className="w-2.5 h-2.5 rotate-45 mx-auto -mt-[6px] border-r-2 border-b-2"
            style={{ backgroundColor: "#0b0e14", borderColor: color.border }}
          />
        </div>
      )}
      <Handle type="target" position={Position.Top} className="!bg-slate-400 !w-3 !h-3" />
      
      <div className="flex items-center justify-between w-full mb-2">
        <div className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-full animate-pulse" style={{ backgroundColor: color.dot }} />
          <span className="text-[10px] uppercase tracking-wider font-mono font-bold text-white/95">{type}</span>
        </div>
        <div className="flex items-center gap-1">
          {connections > 0 && (
            <span className="text-[8px] px-2 py-0.5 rounded-full bg-white/10 text-white/90 font-mono font-bold">
              deg: {connections}
            </span>
          )}
          <span className="text-[8px] px-2 py-0.5 rounded-full bg-black/40 text-white/80 font-mono font-bold">
            srcs: {data.provenanceCount || 1}
          </span>
        </div>
      </div>
      
      <div className="text-sm font-extrabold text-center leading-snug break-words font-sans text-white w-full px-1">
        {label}
      </div>

      {data.aliases && data.aliases.length > 0 && (
        <div className="text-[9px] text-white/60 font-mono mt-2 truncate w-full text-center bg-black/20 rounded px-1.5 py-0.5">
          aka: {data.aliases.slice(0, 2).join(", ")}
        </div>
      )}
      
      <Handle type="source" position={Position.Bottom} className="!bg-slate-400 !w-3 !h-3" />
    </div>
  );
};

const nodeTypes = { customBloom: CustomBloomNode };

// =========================================================
// LAYOUT ALGORITHMS
// =========================================================

// 1. Dynamic Spacing Dagre Layout
const getClusterLayoutedElements = (nodes: Node[], edges: Edge[]) => {
  const dagreGraph = new dagre.graphlib.Graph();
  dagreGraph.setDefaultEdgeLabel(() => ({}));

  const nodeCount = nodes.length;
  const avgDegree = nodeCount > 0 ? (edges.length * 2) / nodeCount : 0;

  // Spacing values adapted dynamically to prevent compressed lines
  let nodeSep = 140; 
  let rankSep = 180;

  if (nodeCount < 10) {
    nodeSep = 260;
    rankSep = 280;
  } else if (nodeCount < 30) {
    nodeSep = 200;
    rankSep = 220;
  } else {
    nodeSep = Math.max(120, 100 + avgDegree * 8);
    rankSep = Math.max(150, 120 + avgDegree * 12);
  }

  dagreGraph.setGraph({
    rankdir: "TB",
    nodesep: nodeSep,
    ranksep: rankSep,
    marginx: 100,
    marginy: 100
  });

  nodes.forEach((node) => {
    const label = String(node.data.label ?? "");
    const nodeWidth = Math.max(220, Math.min(220 + label.length * 4, 380));
    dagreGraph.setNode(node.id, { width: nodeWidth, height: 110 });
  });

  edges.forEach((edge) => {
    dagreGraph.setEdge(edge.source, edge.target);
  });

  dagre.layout(dagreGraph);

  const layoutedNodes = nodes.map((node) => {
    const nodeWithPosition = dagreGraph.node(node.id);
    const label = String(node.data.label ?? "");
    const nodeWidth = Math.max(220, Math.min(220 + label.length * 4, 380));
    return {
      ...node,
      targetPosition: Position.Top,
      sourcePosition: Position.Bottom,
      position: {
        x: nodeWithPosition ? nodeWithPosition.x - nodeWidth / 2 : Math.random() * 600,
        y: nodeWithPosition ? nodeWithPosition.y - 55 : Math.random() * 600,
      },
    };
  });

  return { nodes: layoutedNodes, edges };
};

// 2. Force Directed Physics Layout (Spreads naturally)
const getForceLayoutedElements = (nodes: Node[], edges: Edge[]) => {
  const nodeCount = nodes.length;
  if (nodeCount === 0) return { nodes, edges };

  // forceX/forceY are per-iteration scratch accumulators for the simulation,
  // not part of React Flow's Node contract — declared here so they type-check.
  type SimNode = Node & { forceX?: number; forceY?: number };
  const layoutedNodes: SimNode[] = nodes.map((n) => ({
    ...n,
    position: { ...n.position }
  }));

  const nodeMap = new Map<string, any>();
  layoutedNodes.forEach((n) => nodeMap.set(n.id, n));

  // Arrange in circular layout initially to avoid overlapping starts
  layoutedNodes.forEach((n, idx) => {
    if (n.position.x === 0 && n.position.y === 0) {
      const angle = (idx / nodeCount) * 2 * Math.PI;
      const radius = 180 + Math.sqrt(nodeCount) * 60;
      n.position.x = Math.cos(angle) * radius;
      n.position.y = Math.sin(angle) * radius;
    }
  });

  const width = 1000;
  const height = 800;
  const iterations = 80;
  const k = Math.sqrt((width * height) / nodeCount) * 1.6;

  for (let iter = 0; iter < iterations; iter++) {
    // Repulsive forces
    for (let i = 0; i < nodeCount; i++) {
      const n1 = layoutedNodes[i];
      n1.forceX = n1.forceX || 0;
      n1.forceY = n1.forceY || 0;

      for (let j = 0; j < nodeCount; j++) {
        if (i === j) continue;
        const n2 = layoutedNodes[j];
        const dx = n1.position.x - n2.position.x;
        const dy = n1.position.y - n2.position.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1.0;

        if (dist < 500) {
          const force = (k * k) / dist;
          n1.forceX += (dx / dist) * force;
          n1.forceY += (dy / dist) * force;
        }
      }
    }

    // Attractive forces along edges
    edges.forEach((e) => {
      const n1 = nodeMap.get(e.source);
      const n2 = nodeMap.get(e.target);
      if (!n1 || !n2) return;

      const dx = n2.position.x - n1.position.x;
      const dy = n2.position.y - n1.position.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1.0;

      const force = (dist * dist) / k;
      const fx = (dx / dist) * force * 0.45;
      const fy = (dy / dist) * force * 0.45;

      n1.forceX = (n1.forceX || 0) + fx;
      n1.forceY = (n1.forceY || 0) + fy;
      n2.forceX = (n2.forceX || 0) - fx;
      n2.forceY = (n2.forceY || 0) - fy;
    });

    // Central gravity
    layoutedNodes.forEach((n) => {
      const dist = Math.sqrt(n.position.x * n.position.x + n.position.y * n.position.y) || 1.0;
      n.forceX = (n.forceX || 0) - (n.position.x / dist) * 0.15 * k;
      n.forceY = (n.forceY || 0) - (n.position.y / dist) * 0.15 * k;
    });

    // Update positions with cooling schedule
    const temp = 25 * (1 - iter / iterations);
    layoutedNodes.forEach((n) => {
      const fx = Math.max(-120, Math.min(120, n.forceX || 0));
      const fy = Math.max(-120, Math.min(120, n.forceY || 0));
      const fDist = Math.sqrt(fx * fx + fy * fy) || 1.0;
      const step = Math.min(fDist, temp);
      
      n.position.x += (fx / fDist) * step;
      n.position.y += (fy / fDist) * step;

      n.forceX = 0;
      n.forceY = 0;
    });
  }

  return { nodes: layoutedNodes, edges };
};

// =========================================================
// MAIN INTERACTIVE CANVAS
// =========================================================
function KnowledgeGraphFlowCanvas({ onGoToUpload }: { onGoToUpload?: () => void }) {
  const reactFlowInstance = useReactFlow();

  const [stats, setStats] = useState<GraphStats | null>(null);
  const [rawNodes, setRawNodes] = useState<GraphNodeData[]>([]);
  const [rawEdges, setRawEdges] = useState<GraphEdgeData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Focus & Filter States
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedTypeFilter, setSelectedTypeFilter] = useState<string>("ALL");
  const [selectedRelationFilter, setSelectedRelationFilter] = useState<string>("ALL");
  const [showFullGraph, setShowFullGraph] = useState(false);
  const [zoomLevel, setZoomLevel] = useState(1.0);
  const [layoutMode, setLayoutMode] = useState<"dagre" | "force">("force");
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showDebugPanel, setShowDebugPanel] = useState(false);

  // Inspector & Path Highlighting
  const [selectedNodeData, setSelectedNodeData] = useState<GraphNodeData | null>(null);
  const [selectedEdgeData, setSelectedEdgeData] = useState<GraphEdgeData | null>(null);
  const [highlightedNodeIds, setHighlightedNodeIds] = useState<Set<string>>(new Set());

  // React Flow State
  const [rfNodes, setRfNodes, onNodesChange] = useNodesState<Node>([]);
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState<Edge>([]);

  // Query Engine State
  const [query, setQuery] = useState("");
  const [queryLoading, setQueryLoading] = useState(false);
  const [queryResult, setQueryResult] = useState<GraphRAGResponse | null>(null);

  // Lyzr Studio independent verifier
  const [lyzrStatus, setLyzrStatus] = useState<{ configured: boolean; missing: string[] } | null>(null);
  const [lyzrVerdict, setLyzrVerdict] = useState<LyzrVerdict | null>(null);
  const [lyzrLoading, setLyzrLoading] = useState(false);
  const [lyzrError, setLyzrError] = useState<string | null>(null);

  useEffect(() => {
    apiJson<{ configured: boolean; missing: string[] }>("/lyzr/status")
      .then(setLyzrStatus)
      .catch(() => setLyzrStatus({ configured: false, missing: ["unreachable"] }));
  }, []);

  const runLyzrVerification = async () => {
    if (!queryResult) return;
    setLyzrLoading(true);
    setLyzrError(null);
    setLyzrVerdict(null);
    try {
      const res = await apiJson<LyzrVerdict>("/lyzr/verify", {
        method: "POST",
        body: JSON.stringify({
          question: queryResult.question,
          answer: queryResult.answer,
          // graph_context is only populated on the graph-traversal path; a
          // vector-path answer carries its evidence in evidence_context. Sending
          // the empty one made the verifier audit against nothing and return
          // 100% hallucination risk for a correct answer.
          graph_context: queryResult.graph_context || queryResult.evidence_context || "",
        }),
      });
      setLyzrVerdict(res);
    } catch (err: any) {
      setLyzrError(err?.message || "Lyzr verification failed.");
    } finally {
      setLyzrLoading(false);
    }
  };

  const fetchGraphData = async () => {
    setLoading(true);
    setError(null);
    try {
      const statsRes = await apiJson<GraphStats>("/graph/stats");
      setStats(statsRes);

      const visRes = await apiJson<{ nodes: GraphNodeData[]; edges: GraphEdgeData[] }>("/graph/visualize");
      setRawNodes(visRes.nodes || []);
      setRawEdges(visRes.edges || []);
      
      // Auto-set optimal layout mode based on density
      if (visRes.nodes && visRes.nodes.length > 80) {
        setLayoutMode("dagre");
      } else {
        setLayoutMode("force");
      }
    } catch (err: any) {
      console.error("Failed to load Knowledge Graph:", err);
      setError(err?.message || "Could not connect to Knowledge Graph service.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchGraphData();
  }, []);

  // Connected Components Count (DFS search)
  const connectedComponentsCount = useMemo(() => {
    const nodeIds = rawNodes.map((n) => n.id);
    const adj: Record<string, string[]> = {};
    nodeIds.forEach((id) => (adj[id] = []));
    rawEdges.forEach((e) => {
      if (adj[e.source] && adj[e.target]) {
        adj[e.source].push(e.target);
        adj[e.target].push(e.source);
      }
    });

    const visited = new Set<string>();
    let count = 0;

    nodeIds.forEach((id) => {
      if (!visited.has(id)) {
        count++;
        const queue = [id];
        visited.add(id);
        while (queue.length > 0) {
          const curr = queue.shift()!;
          const neighbors = adj[curr] || [];
          neighbors.forEach((n) => {
            if (!visited.has(n)) {
              visited.add(n);
              queue.push(n);
            }
          });
        }
      }
    });
    return count;
  }, [rawNodes, rawEdges]);

  // Average degree & Graph density Calculations
  const metrics = useMemo(() => {
    const totalN = rawNodes.length;
    const totalE = rawEdges.length;
    const avgDeg = totalN > 0 ? (totalE * 2) / totalN : 0;
    const density = totalN > 1 ? (totalE * 2) / (totalN * (totalN - 1)) : 0;
    return { avgDeg, density };
  }, [rawNodes, rawEdges]);

  // Degree Centrality Calculation
  const nodeDegrees = useMemo(() => {
    const degrees: Record<string, number> = {};
    rawEdges.forEach((e) => {
      degrees[e.source] = (degrees[e.source] || 0) + 1;
      degrees[e.target] = (degrees[e.target] || 0) + 1;
    });
    return degrees;
  }, [rawEdges]);

  // Filter for clusters to keep initial rendering readable
  const displayNodes = useMemo(() => {
    if (rawNodes.length <= 40 || showFullGraph || searchTerm.trim() || selectedTypeFilter !== "ALL") {
      return rawNodes;
    }
    const sorted = [...rawNodes].sort((a, b) => (nodeDegrees[b.id] || 0) - (nodeDegrees[a.id] || 0));
    return sorted.slice(0, 40);
  }, [rawNodes, showFullGraph, searchTerm, selectedTypeFilter, nodeDegrees]);

  // Filter & Layout Rendering Loop
  useEffect(() => {
    if (rawNodes.length === 0 && rawEdges.length === 0) return;

    let filteredN = displayNodes;
    if (selectedTypeFilter !== "ALL") {
      filteredN = filteredN.filter((n) => n.type === selectedTypeFilter);
    }
    if (searchTerm.trim()) {
      const term = searchTerm.toLowerCase();
      filteredN = filteredN.filter(
        (n) =>
          n.label.toLowerCase().includes(term) ||
          n.type.toLowerCase().includes(term) ||
          n.aliases.some((a) => a.toLowerCase().includes(term))
      );
    }

    const validIds = new Set(filteredN.map((n) => n.id));
    let filteredE = rawEdges.filter((e) => validIds.has(e.source) && validIds.has(e.target));

    if (selectedRelationFilter !== "ALL") {
      filteredE = filteredE.filter((e) => e.relation === selectedRelationFilter);
    }

    const hasSelection = highlightedNodeIds.size > 0;

    const flowNodes: Node[] = filteredN.map((n) => {
      const isHighlighted = highlightedNodeIds.has(n.id);
      const isFaded = hasSelection && !isHighlighted;

      return {
        id: n.id,
        type: "customBloom",
        position: { x: 0, y: 0 },
        data: {
          id: n.id,
          label: n.label,
          type: n.type,
          aliases: n.aliases,
          degree: nodeDegrees[n.id] || 0,
          provenanceCount: n.provenance?.length || 1,
          // Provenance carried onto the node so the hover card can surface
          // source evidence without a round-trip (citation traceability).
          documentId: n.document_id,
          pageNumber: n.page_number,
          chunkId: n.chunk_id,
          sourceText: n.source_text || n.provenance?.[0]?.source_text,
          documentCount: n.document_count,
          isHighlighted,
          isFaded,
        },
      };
    });

    const flowEdges: Edge[] = filteredE.map((e) => {
      const isHighlighted =
        highlightedNodeIds.has(e.source) && highlightedNodeIds.has(e.target);
      const showLabel = isHighlighted || selectedEdgeData?.id === e.id || rawNodes.length < 35;
      const strokeColor = RELATION_COLORS[e.relation] || "#9ca3af";

      return {
        id: e.id,
        source: e.source,
        target: e.target,
        type: "bezier",
        label: showLabel ? `${e.relation} (${(e.confidence * 100).toFixed(0)}%)` : "",
        animated: isHighlighted || e.relation === "IMPLEMENTS" || e.relation === "SATISFIES",
        style: {
          stroke: isHighlighted ? "#f59e0b" : strokeColor,
          strokeWidth: isHighlighted ? 4.0 : 2.0,
          opacity: hasSelection && !isHighlighted ? 0.15 : 1,
        },
        labelStyle: { fill: "#f3f4f6", fontSize: 9, fontWeight: 700 },
        labelBgStyle: { fill: "#0f172a", fillOpacity: 0.95, rx: 4, ry: 4 },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: isHighlighted ? "#f59e0b" : "#ffffff",
          width: 18,
          height: 18,
        },
      };
    });

    const { nodes: layoutedN, edges: layoutedE } =
      layoutMode === "force"
        ? getForceLayoutedElements(flowNodes, flowEdges)
        : getClusterLayoutedElements(flowNodes, flowEdges);

    setRfNodes(layoutedN);
    setRfEdges(layoutedE);

  }, [displayNodes, rawNodes, rawEdges, selectedTypeFilter, selectedRelationFilter, searchTerm, highlightedNodeIds, nodeDegrees, selectedEdgeData, layoutMode]);

  // Trigger fitView ONLY when layout mode, filters, fullscreen, or nodes change (not on zoom or click selection)
  useEffect(() => {
    if (rawNodes.length > 0) {
      setTimeout(() => {
        reactFlowInstance.fitView({ padding: 0.22, duration: 600 });
      }, 150);
    }
  }, [layoutMode, selectedTypeFilter, selectedRelationFilter, searchTerm, isFullscreen, showFullGraph]);

  // Click Handler for Node Traversal path and neighbors
  const onNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      const found = rawNodes.find((n) => n.id === node.id || n.label === node.id);
      setSelectedNodeData(found || { id: node.id, label: node.id, type: String(node.data.type ?? "Requirement"), aliases: [] });
      setSelectedEdgeData(null);

      const connected = new Set<string>([node.id]);
      rawEdges.forEach((e) => {
        if (e.source === node.id || e.source === found?.label) connected.add(e.target);
        if (e.target === node.id || e.target === found?.label) connected.add(e.source);
      });
      setHighlightedNodeIds(connected);
      
      // Smooth focus
      reactFlowInstance.fitView({ nodes: [{ id: node.id }], duration: 600, maxZoom: 1.1 });
    },
    [rawNodes, rawEdges, reactFlowInstance]
  );

  const onNodeDoubleClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      reactFlowInstance.fitView({ nodes: [node], duration: 500, maxZoom: 1.4 });
    },
    [reactFlowInstance]
  );

  const onEdgeClick = useCallback(
    (_: React.MouseEvent, edge: Edge) => {
      const found = rawEdges.find((e) => e.id === edge.id);
      if (found) {
        setSelectedEdgeData(found);
        setSelectedNodeData(null);
      }
    },
    [rawEdges]
  );

  const handleSearchFocus = (term: string) => {
    setSearchTerm(term);
    if (!term.trim()) return;
    const matchedNode = rfNodes.find(
      (n) =>
        n.id.toLowerCase().includes(term.toLowerCase()) ||
        String(n.data.label ?? "").toLowerCase().includes(term.toLowerCase())
    );
    if (matchedNode) {
      reactFlowInstance.fitView({ nodes: [matchedNode], duration: 600, maxZoom: 1.3 });
      setSelectedNodeData(rawNodes.find((n) => n.id === matchedNode.id) || null);
    }
  };

  const handleResetView = () => {
    setSearchTerm("");
    setSelectedTypeFilter("ALL");
    setSelectedRelationFilter("ALL");
    setShowFullGraph(false);
    setSelectedNodeData(null);
    setSelectedEdgeData(null);
    setHighlightedNodeIds(new Set());
    reactFlowInstance.fitView({ padding: 0.2, duration: 600 });
  };

  const handleExecuteGraphRAG = async (searchQuestion?: string) => {
    const textToQuery = searchQuestion || query;
    if (!textToQuery.trim()) return;

    setQueryLoading(true);
    setQueryResult(null);
    try {
      const res = await apiJson<GraphRAGResponse>("/graph/query", {
        method: "POST",
        body: JSON.stringify({ question: textToQuery, top_k: 5, depth: 2 }),
      });
      setQueryResult(res);

      if (res && res.subgraph && res.subgraph.nodes.length > 0) {
        const subgraphNodeIds = new Set(res.subgraph.nodes.map((n) => n.id));
        setHighlightedNodeIds(subgraphNodeIds);
        
        const seedNode = res.subgraph.nodes.find(n => res.seed_entities.some(s => s.toLowerCase() === n.label.toLowerCase()));
        if (seedNode) {
          setSelectedNodeData(seedNode);
          setSelectedEdgeData(null);
        }

        setTimeout(() => {
          reactFlowInstance.fitView({
            nodes: res.subgraph.nodes.map((n) => ({ id: n.id })),
            duration: 800,
            padding: 0.35,
          });
        }, 150);
      }
    } catch (err) {
      console.error("Graph RAG Query Error:", err);
    } finally {
      setQueryLoading(false);
    }
  };

  const handleExportJSON = () => {
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify({ nodes: rawNodes, edges: rawEdges }, null, 2));
    const downloadAnchor = document.createElement("a");
    downloadAnchor.setAttribute("href", dataStr);
    downloadAnchor.setAttribute("download", "kairo_knowledge_graph.json");
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
  };

  const handleExportSVG = () => {
    const svgElement = document.querySelector(".react-flow__renderer") as HTMLElement;
    if (!svgElement) return;
    const svgString = new XMLSerializer().serializeToString(svgElement);
    const dataStr = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svgString);
    const downloadAnchor = document.createElement("a");
    downloadAnchor.setAttribute("href", dataStr);
    downloadAnchor.setAttribute("download", "kairo_knowledge_graph.svg");
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
  };

  const availableTypes = useMemo(() => Array.from(new Set(rawNodes.map((n) => n.type))), [rawNodes]);
  const availableRelations = useMemo(() => Array.from(new Set(rawEdges.map((e) => e.relation))), [rawEdges]);

  const selectedNodeConnectedEdges = useMemo(() => {
    if (!selectedNodeData) return [];
    return rawEdges.filter(
      (e) =>
        e.source === selectedNodeData.id ||
        e.target === selectedNodeData.id ||
        e.source === selectedNodeData.label ||
        e.target === selectedNodeData.label
    );
  }, [selectedNodeData, rawEdges]);

  const selectedNodeConnectedDocs = useMemo(() => {
    if (!selectedNodeData) return [];
    const docIds = new Set<string>();
    
    // Inspect node provenance metadata
    if (selectedNodeData.provenance) {
      selectedNodeData.provenance.forEach((p: any) => {
        if (p.document_id) docIds.add(String(p.document_id));
      });
    }

    // Inspect incident edges provenance metadata
    rawEdges.forEach((e) => {
      if ((e.source === selectedNodeData.id || e.target === selectedNodeData.id || e.source === selectedNodeData.label || e.target === selectedNodeData.label) && e.document_id) {
        docIds.add(String(e.document_id));
      }
    });

    return Array.from(docIds);
  }, [selectedNodeData, rawEdges]);

  return (
    <div className="w-full space-y-6 text-text-primary">
      <style>{`
        .react-flow__controls button {
          background-color: #ffffff !important;
          border-bottom: 1px solid #e2e8f0 !important;
        }
        .react-flow__controls button svg {
          fill: #000000 !important;
          color: #000000 !important;
        }
        .react-flow__controls button:hover {
          background-color: #f1f5f9 !important;
        }
      `}</style>
      
      {/* OVERHAULED METRICS DASHBOARD */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        <div className="bg-card-background border border-border-default rounded-xl p-4 flex items-center justify-between shadow-md">
          <div>
            <p className="text-[11px] text-text-secondary uppercase tracking-wider font-semibold">Nodes (Entities)</p>
            <p className="text-2xl font-bold text-text-primary mt-1">{stats?.total_nodes ?? rawNodes.length}</p>
          </div>
          <div className="p-2.5 bg-accent/10 border border-accent/20 rounded-lg text-accent">
            <Layers size={20} />
          </div>
        </div>

        <div className="bg-card-background border border-border-default rounded-xl p-4 flex items-center justify-between shadow-md">
          <div>
            <p className="text-[11px] text-text-secondary uppercase tracking-wider font-semibold">Relationships (Edges)</p>
            <p className="text-2xl font-bold text-purple-400 mt-1">{stats?.total_relationships ?? rawEdges.length}</p>
          </div>
          <div className="p-2.5 bg-purple-500/10 border border-purple-500/20 rounded-lg text-purple-400">
            <Share2 size={20} />
          </div>
        </div>

        <div className="bg-card-background border border-border-default rounded-xl p-4 flex items-center justify-between shadow-md">
          <div>
            <p className="text-[11px] text-text-secondary uppercase tracking-wider font-semibold">Average Degree</p>
            <p className="text-2xl font-bold text-blue-400 mt-1">{metrics.avgDeg.toFixed(2)}</p>
          </div>
          <div className="p-2.5 bg-blue-500/10 border border-blue-500/20 rounded-lg text-blue-400">
            <Sliders size={20} />
          </div>
        </div>

        <div className="bg-card-background border border-border-default rounded-xl p-4 flex items-center justify-between shadow-md">
          <div>
            <p className="text-[11px] text-text-secondary uppercase tracking-wider font-semibold">Connected Clusters</p>
            <p className="text-2xl font-bold text-emerald-400 mt-1">{connectedComponentsCount}</p>
          </div>
          <div className="p-2.5 bg-emerald-500/10 border border-emerald-500/20 rounded-lg text-emerald-400">
            <Tag size={20} />
          </div>
        </div>

        <div className="col-span-2 lg:col-span-1 bg-card-background border border-border-default rounded-xl p-4 flex items-center justify-between shadow-md">
          <div>
            <p className="text-[11px] text-text-secondary uppercase tracking-wider font-semibold">Graph Density</p>
            <p className="text-sm font-bold text-amber-400 mt-2">{(metrics.density * 100).toFixed(2)}%</p>
          </div>
          <div className="p-2.5 bg-amber-500/10 border border-amber-500/20 rounded-lg text-amber-400">
            <Activity size={20} />
          </div>
        </div>
      </div>

      {/* CANVAS & INSPECTOR WINDOW */}
      <div className={isFullscreen 
        ? "fixed inset-0 z-50 bg-[#090b11] p-6 flex flex-col lg:grid lg:grid-cols-12 gap-6 w-screen h-screen overflow-hidden animate-in fade-in duration-200" 
        : "grid grid-cols-1 lg:grid-cols-12 gap-6 items-start"}
      >
        
        {/* ReactFlow Canvas container */}
        <div className={isFullscreen ? "lg:col-span-8 h-full flex flex-col" : "lg:col-span-8 space-y-4"}>
          
          <div className={isFullscreen 
            ? "bg-card-background border border-border-default rounded-2xl overflow-hidden shadow-2xl relative flex flex-col h-full lg:h-[calc(100vh-80px)]" 
            : "bg-card-background border border-border-default rounded-2xl overflow-hidden shadow-2xl relative flex flex-col h-[700px]"}
          >
            
            {/* COMPACT ACTIVE TOOLBAR */}
            <div className="p-3 bg-bg-secondary/95 border-b border-border-default flex flex-wrap items-center justify-between gap-3 backdrop-blur-md z-10">
              
              <div className="flex items-center gap-2 flex-1 min-w-[200px]">
                <div className="relative w-full max-w-xs">
                  <Search size={14} className="absolute left-2.5 top-2.5 text-text-secondary" />
                  <input
                    type="text"
                    value={searchTerm}
                    onChange={(e) => handleSearchFocus(e.target.value)}
                    placeholder="Search entity..."
                    className="w-full pl-8 pr-3 py-1.5 bg-bg-tertiary border border-border-default rounded-lg text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
                  />
                </div>
              </div>

              <div className="flex items-center gap-2 flex-wrap">
                {/* Layout Mode Selector */}
                <button
                  onClick={() => setLayoutMode(layoutMode === "force" ? "dagre" : "force")}
                  className="px-2.5 py-1.5 bg-bg-tertiary hover:bg-bg-secondary border border-border-default rounded-lg text-xs text-text-primary flex items-center gap-1.5 cursor-pointer transition-colors"
                  title="Switch Layout Physics"
                >
                  <Grid size={13} className="text-accent" />
                  <span>{layoutMode === "force" ? "Physics Layout" : "Tree Layout"}</span>
                </button>

                <select
                  value={selectedTypeFilter}
                  onChange={(e) => setSelectedTypeFilter(e.target.value)}
                  className="bg-bg-tertiary border border-border-default rounded-lg text-xs text-text-primary px-2.5 py-1.5 focus:outline-none cursor-pointer"
                >
                  <option value="ALL">All Types</option>
                  {availableTypes.map((t) => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </select>

                <select
                  value={selectedRelationFilter}
                  onChange={(e) => setSelectedRelationFilter(e.target.value)}
                  className="bg-bg-tertiary border border-border-default rounded-lg text-xs text-text-primary px-2.5 py-1.5 focus:outline-none cursor-pointer"
                >
                  <option value="ALL">All Relations</option>
                  {availableRelations.map((r) => (
                    <option key={r} value={r}>{r}</option>
                  ))}
                </select>

                {rawNodes.length > 40 && !showFullGraph && (
                  <button
                    onClick={() => setShowFullGraph(true)}
                    className="px-2.5 py-1.5 bg-accent/20 border border-accent/40 rounded-lg text-xs text-accent font-semibold hover:bg-accent/30 flex items-center gap-1 cursor-pointer"
                    title="Expand all nodes"
                  >
                    <PlusCircle size={13} />
                    <span>All ({rawNodes.length})</span>
                  </button>
                )}

                <button
                  onClick={() => reactFlowInstance.fitView({ padding: 0.22, duration: 600 })}
                  className="p-1.5 bg-bg-tertiary hover:bg-bg-secondary border border-border-default rounded-lg text-text-secondary hover:text-text-primary cursor-pointer"
                  title="Center & Fit View"
                >
                  <Maximize size={14} />
                </button>

                <button
                  onClick={() => {
                    setIsFullscreen(!isFullscreen);
                    setTimeout(() => reactFlowInstance.fitView({ padding: 0.22, duration: 600 }), 150);
                  }}
                  className="p-1.5 bg-bg-tertiary hover:bg-bg-secondary border border-border-default rounded-lg text-text-secondary hover:text-text-primary cursor-pointer"
                  title={isFullscreen ? "Exit Fullscreen" : "Fullscreen Dialog Box"}
                >
                  <Maximize2 size={14} className={isFullscreen ? "text-accent animate-pulse" : ""} />
                </button>

                <button
                  onClick={handleResetView}
                  className="p-1.5 bg-bg-tertiary hover:bg-bg-secondary border border-border-default rounded-lg text-text-secondary hover:text-text-primary cursor-pointer"
                  title="Reset Filters"
                >
                  <RotateCcw size={14} />
                </button>

                {/* Exporters */}
                <button
                  onClick={handleExportSVG}
                  className="p-1.5 bg-bg-tertiary hover:bg-bg-secondary border border-border-default rounded-lg text-text-secondary hover:text-text-primary cursor-pointer"
                  title="Export Graph as SVG"
                >
                  <Download size={14} />
                </button>
                
                <button
                  onClick={handleExportJSON}
                  className="p-1.5 bg-bg-tertiary hover:bg-bg-secondary border border-border-default rounded-lg text-text-secondary hover:text-text-primary cursor-pointer"
                  title="Export JSON Data"
                >
                  <FileCode size={14} />
                </button>
              </div>
            </div>

            {/* FLOW RENDERING CANVAS */}
            <div className="flex-1 relative bg-[#090b11]">
              {loading ? (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-text-secondary bg-[#090b11]/80 z-20">
                  <RefreshCw size={28} className="animate-spin text-accent" />
                  <span className="text-xs">Generating layout model...</span>
                </div>
              ) : error ? (
                <div className="absolute inset-0 flex flex-col items-center justify-center p-6 text-center text-rose-400 z-20">
                  <AlertCircle size={32} className="mb-2" />
                  <span className="text-sm font-semibold">Failed to load Knowledge Graph</span>
                  <span className="text-xs text-text-secondary mt-1">{error}</span>
                </div>
              ) : rawNodes.length === 0 ? (
                <div className="absolute inset-0 z-20 flex items-center justify-center p-6 bg-[#090b11] overflow-y-auto">
                  <div className="max-w-lg w-full text-center py-6">
                    <div className="relative mx-auto w-fit mb-5">
                      <div className="absolute inset-0 bg-accent/20 blur-2xl rounded-full" />
                      <div className="relative p-4 bg-bg-secondary border border-border-default rounded-2xl">
                        <NetworkIcon size={34} className="text-accent" />
                      </div>
                    </div>

                    <h3 className="text-lg font-bold text-text-primary">Knowledge Graph is empty</h3>
                    <p className="text-xs text-text-secondary mt-2 leading-relaxed max-w-sm mx-auto">
                      Upload a compliance document and Kairo parses it, extracts the
                      entity&ndash;relationship web, and synthesizes a fully traceable graph
                      you can query with zero-hallucination Graph RAG.
                    </p>

                    <div className="flex items-center justify-center gap-1.5 mt-6 flex-wrap">
                      {[
                        { icon: FileText, label: "Parse" },
                        { icon: Sparkles, label: "Extract Entities" },
                        { icon: Share2, label: "Build Graph" },
                        { icon: ShieldCheck, label: "Graph RAG" },
                      ].map((s, i, arr) => (
                        <React.Fragment key={s.label}>
                          <div className="flex items-center gap-1.5 px-2.5 py-1.5 bg-bg-secondary border border-border-default rounded-lg">
                            <s.icon size={12} className="text-accent" />
                            <span className="text-[10px] font-semibold text-text-primary">{s.label}</span>
                          </div>
                          {i < arr.length - 1 && <ChevronRight size={12} className="text-text-secondary/50" />}
                        </React.Fragment>
                      ))}
                    </div>

                    <div className="mt-6">
                      <p className="text-[10px] uppercase tracking-wider font-bold text-text-secondary mb-2.5">
                        Compliance entities Kairo detects
                      </p>
                      <div className="flex flex-wrap items-center justify-center gap-1.5">
                        {Object.entries(ENTITY_COLORS).map(([type, c]) => (
                          <span
                            key={type}
                            className="flex items-center gap-1.5 px-2 py-1 bg-bg-secondary border border-border-default rounded-md"
                          >
                            <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: c.dot }} />
                            <span className="text-[10px] text-text-secondary font-medium">{type}</span>
                          </span>
                        ))}
                      </div>
                    </div>

                    {onGoToUpload && (
                      <button
                        onClick={onGoToUpload}
                        className="mt-7 px-5 py-2.5 bg-accent text-white rounded-xl text-xs font-bold inline-flex items-center gap-2 hover:opacity-90 transition-opacity cursor-pointer shadow-lg shadow-accent/20"
                      >
                        <PlusCircle size={14} />
                        Upload a compliance document
                      </button>
                    )}
                  </div>
                </div>
              ) : null}

              <ReactFlow
                nodes={rfNodes}
                edges={rfEdges}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                onNodeClick={onNodeClick}
                onNodeDoubleClick={onNodeDoubleClick}
                onEdgeClick={onEdgeClick}
                onMove={(_, viewport) => setZoomLevel(viewport.zoom)}
                nodeTypes={nodeTypes}
                fitView
                fitViewOptions={{ padding: 0.22, includeHiddenNodes: false }}
                minZoom={0.15}
                maxZoom={2.0}
                className="bg-[#090b11]"
              >
                <Background color="#1e293b" gap={26} size={1} />
                <Controls className="!bg-bg-secondary !border-border-default !rounded-xl overflow-hidden" />
                <MiniMap
                  nodeColor={(node) => {
                    const type = String(node.data?.type ?? "");
                    const color = ENTITY_COLORS[type];
                    return color ? color.dot : "#8b5cf6";
                  }}
                  maskColor="rgba(9, 11, 17, 0.85)"
                  className="!bg-bg-secondary !border-border-default !rounded-xl overflow-hidden"
                />
              </ReactFlow>

              {/* DYNAMIC COLOR PALETTE LEGEND */}
              {rawNodes.length > 0 && (
              <div className="absolute bottom-3 left-3 bg-bg-primary/95 border border-border-default rounded-xl p-3 backdrop-blur-md text-[10px] text-text-secondary flex flex-wrap items-center gap-4 max-w-[90%] pointer-events-none z-10 shadow-lg">
                <span className="font-bold text-text-primary uppercase tracking-wider">Legend:</span>
                {Object.entries(ENTITY_COLORS).map(([type, color]) => {
                  const nodeCount = rawNodes.filter(n => n.type === type).length;
                  if (nodeCount === 0) return null;
                  return (
                    <span key={type} className="flex items-center gap-1.5">
                      <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: color.dot }} />
                      <span className="text-text-primary font-medium">{type} ({nodeCount})</span>
                    </span>
                  );
                })}
              </div>
              )}
            </div>
          </div>
        </div>

        {/* DETAILS INSPECTOR SIDEBAR */}
        <div className={isFullscreen ? "lg:col-span-4 h-full" : "lg:col-span-4 space-y-4"}>
          
          <div className={isFullscreen 
            ? "bg-card-background border border-border-default rounded-2xl p-5 shadow-xl space-y-4 h-full lg:h-[calc(100vh-80px)] overflow-y-auto" 
            : "bg-card-background border border-border-default rounded-2xl p-5 shadow-xl space-y-4 min-h-[500px]"}
          >
            <div className="flex items-center justify-between border-b border-border-default pb-3">
              <h3 className="text-sm font-bold text-text-primary flex items-center gap-2">
                <Info size={16} className="text-accent" />
                Compliance Node Inspector
              </h3>
              {(selectedNodeData || selectedEdgeData) && (
                <button
                  onClick={() => {
                    setSelectedNodeData(null);
                    setSelectedEdgeData(null);
                    setHighlightedNodeIds(new Set());
                  }}
                  className="text-text-secondary hover:text-text-primary"
                >
                  <X size={14} />
                </button>
              )}
            </div>

            {/* Traversal path display */}
            {queryResult?.debug_info?.traversed_relationships && queryResult.debug_info.traversed_relationships.length > 0 && (
              <div className="bg-purple-950/20 border border-purple-500/20 rounded-xl p-3 text-[10px] text-purple-300 mb-4 animate-in fade-in duration-300">
                <span className="font-bold text-white uppercase tracking-wider text-[9px] block mb-1">
                  Active Query Traversal Path:
                </span>
                <div className="space-y-1 font-mono leading-normal max-h-28 overflow-y-auto pr-1">
                  {queryResult.debug_info.traversed_relationships.map((p: string, idx: number) => (
                    <div key={idx} className="flex items-start gap-1">
                      <span className="text-purple-400 select-none">→</span>
                      <span>{p}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {selectedNodeData ? (
              <div className="space-y-4 animate-in fade-in duration-200">
                <div>
                  <span className="text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded bg-purple-500/10 text-purple-400 border border-purple-500/30">
                    {selectedNodeData.type}
                  </span>
                  <h4 className="text-base font-bold text-text-primary mt-1.5 leading-snug">{selectedNodeData.label}</h4>
                  <p className="text-[10px] text-text-secondary font-mono mt-0.5">ID: {selectedNodeData.id}</p>
                </div>

                {selectedNodeData.aliases && selectedNodeData.aliases.length > 0 && (
                  <div className="pt-3 border-t border-border-default/60">
                    <p className="text-[11px] text-text-secondary font-semibold">Entity Aliases:</p>
                    <div className="flex flex-wrap gap-1 mt-1.5">
                      {selectedNodeData.aliases.map((a, idx) => (
                        <span key={idx} className="text-[10px] px-2 py-0.5 bg-bg-secondary border border-border-default rounded text-text-primary font-mono">
                          {a}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {/* Traversed Neighbors List */}
                <div className="pt-3 border-t border-border-default/60 space-y-2">
                  <p className="text-[11px] text-text-secondary font-semibold">Connected Relationships ({selectedNodeConnectedEdges.length}):</p>
                  <div className="space-y-1.5 max-h-40 overflow-y-auto pr-1">
                    {selectedNodeConnectedEdges.map((e, idx) => {
                      const isIncoming = e.target === selectedNodeData.id || e.target === selectedNodeData.label;
                      const partner = isIncoming ? e.source : e.target;
                      return (
                        <div key={idx} className="p-2 bg-bg-secondary/60 border border-border-default rounded-lg text-[10px] flex items-center justify-between gap-2">
                          <span className="truncate font-semibold max-w-[45%] text-text-primary">{partner}</span>
                          <span className="text-[8px] font-mono font-bold px-1.5 py-0.2 bg-purple-500/10 text-purple-400 rounded border border-purple-500/20">
                            {isIncoming ? "IN: " : "OUT: "}{e.relation}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Connective Documents Provenance */}
                <div className="pt-3 border-t border-border-default/60 space-y-2">
                  <p className="text-[11px] text-text-secondary font-semibold">Connected Documents ({selectedNodeConnectedDocs.length}):</p>
                  <div className="space-y-1.5 max-h-36 overflow-y-auto pr-1">
                    {selectedNodeConnectedDocs.map((doc, idx) => (
                      <div key={idx} className="p-2 bg-bg-secondary/60 border border-border-default rounded-lg text-[10px] flex items-center gap-1.5">
                        <FileText size={12} className="text-accent" />
                        <span className="font-mono text-text-primary truncate">{doc}</span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Raw Ingestion Snippet */}
                {selectedNodeData.provenance && selectedNodeData.provenance.length > 0 && (
                  <div className="pt-3 border-t border-border-default/60 space-y-1 text-[10px]">
                    <p className="text-text-secondary font-semibold">Provenance Details:</p>
                    <div className="bg-bg-secondary border border-border-default rounded-lg p-2.5 font-mono text-[9px] text-text-secondary leading-normal whitespace-pre-wrap max-h-32 overflow-y-auto">
                      {selectedNodeData.provenance[0].source_text}
                    </div>
                  </div>
                )}
              </div>
            ) : selectedEdgeData ? (
              <div className="space-y-4 animate-in fade-in duration-200">
                <span className="text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">
                  Compliance Edge Details
                </span>
                <div className="space-y-3 mt-2">
                  <div>
                    <p className="text-[10px] text-text-secondary">Source Entity:</p>
                    <p className="text-xs font-bold text-text-primary mt-0.5">{selectedEdgeData.source}</p>
                  </div>
                  <div>
                    <p className="text-[10px] text-text-secondary">Target Entity:</p>
                    <p className="text-xs font-bold text-text-primary mt-0.5">{selectedEdgeData.target}</p>
                  </div>
                  <div>
                    <p className="text-[10px] text-text-secondary">Relationship Action:</p>
                    <p className="text-xs font-mono font-bold text-purple-400 mt-0.5">{selectedEdgeData.relation}</p>
                  </div>
                  <div>
                    <p className="text-[10px] text-text-secondary">Extraction Confidence Score:</p>
                    <p className="text-xs font-mono font-bold text-emerald-400 mt-0.5">{(selectedEdgeData.confidence * 100).toFixed(0)}%</p>
                  </div>
                  {selectedEdgeData.document_id && (
                    <div>
                      <p className="text-[10px] text-text-secondary">Source Document:</p>
                      <p className="text-xs font-mono text-text-primary mt-0.5">{selectedEdgeData.document_id}</p>
                    </div>
                  )}
                  {selectedEdgeData.page_number !== undefined && selectedEdgeData.page_number !== null && (
                    <div>
                      <p className="text-[10px] text-text-secondary">Source Page:</p>
                      <p className="text-xs font-mono text-text-primary mt-0.5">Page {selectedEdgeData.page_number}</p>
                    </div>
                  )}
                  {selectedEdgeData.chunk_id && (
                    <div>
                      <p className="text-[10px] text-text-secondary">Source Chunk ID:</p>
                      <p className="text-xs font-mono text-text-primary mt-0.5">{selectedEdgeData.chunk_id}</p>
                    </div>
                  )}
                  {selectedEdgeData.source_text && (
                    <div className="pt-2 border-t border-border-default/60">
                      <p className="text-[10px] text-text-secondary font-semibold">Provenance Source Text:</p>
                      <div className="bg-[#0b0e14] border border-border-default rounded-lg p-2.5 font-mono text-[9px] text-text-secondary leading-normal whitespace-pre-wrap max-h-24 overflow-y-auto">
                        {selectedEdgeData.source_text}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="py-20 text-center text-text-secondary flex flex-col items-center justify-center">
                <Compass size={36} className="mb-3 text-text-secondary/35 animate-pulse" />
                <span className="text-xs font-medium max-w-[220px] leading-normal">Click any node or edge on the canvas to inspect attributes, provenance records, and neighbors.</span>
              </div>
            )}
          </div>

        </div>

      </div>

      {/* RAG QUERY PANEL */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        
        <div className="lg:col-span-8 bg-card-background border border-border-default rounded-2xl p-5 space-y-4 shadow-xl">
          <div className="flex items-center justify-between border-b border-border-default pb-3">
            <h3 className="text-sm font-bold text-text-primary flex items-center gap-2">
              <Sparkles size={16} className="text-amber-400" />
              Graph RAG Query Interface
            </h3>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowDebugPanel(!showDebugPanel)}
                className={`text-[10px] px-2.5 py-1 rounded border transition-colors cursor-pointer font-mono font-bold ${
                  showDebugPanel 
                    ? "bg-accent/20 border-accent text-accent" 
                    : "bg-bg-tertiary border-border-default text-text-secondary hover:text-text-primary"
                }`}
              >
                Debug Panel: {showDebugPanel ? "ON" : "OFF"}
              </button>
              <span className="text-[11px] text-text-secondary font-mono">10-stage compliance tracing</span>
            </div>
          </div>

          <div className="relative">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleExecuteGraphRAG()}
              placeholder="Ask compliance graph (e.g., 'Which controls affect PayrollPro?')"
              className="w-full pl-4 pr-28 py-3 bg-bg-secondary border border-border-default rounded-xl text-xs text-text-primary focus:outline-none focus:ring-2 focus:ring-accent"
            />
            <button
              onClick={() => handleExecuteGraphRAG()}
              disabled={queryLoading || !query.trim()}
              className="absolute right-2 top-2 bottom-2 px-4 bg-accent text-white hover:opacity-90 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-all cursor-pointer disabled:opacity-50"
            >
              {queryLoading ? <RefreshCw size={14} className="animate-spin" /> : <Search size={14} />}
              Query Graph
            </button>
          </div>

          {queryResult && (
            <div className="space-y-4">
              <div className="border border-border-default rounded-xl p-4 bg-bg-secondary/40 space-y-3 animate-in fade-in duration-300">
                <div className="flex items-center justify-between border-b border-border-default pb-2">
                  <div className="flex items-center gap-2">
                    <CheckCircle2 size={16} className="text-emerald-400" />
                    <span className="text-xs font-semibold text-text-primary">Graph RAG Response</span>
                  </div>
                  <div className="flex items-center gap-1.5 flex-wrap justify-end">
                    {/* Only rendered once the Lyzr agent has actually returned a
                        verdict, so the badge is evidence the audit ran — not
                        decoration that shows up regardless. */}
                    {lyzrVerdict && (
                      <span
                        className={`text-[10px] px-2 py-0.5 rounded-md font-mono font-bold border flex items-center gap-1 ${
                          lyzrVerdict.verdict === "SUPPORTED"
                            ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/30"
                            : lyzrVerdict.verdict === "UNSUPPORTED"
                            ? "bg-rose-500/10 text-rose-400 border-rose-500/30"
                            : "bg-indigo-500/10 text-indigo-300 border-indigo-500/30"
                        }`}
                        title={`Independently audited by Lyzr Studio agent ${lyzrVerdict.agent_id || ""}`}
                      >
                        <ShieldCheck size={10} />
                        Lyzr Verified
                      </span>
                    )}
                    <span className="text-[11px] px-2 py-0.5 bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 rounded-md font-mono">
                      Confidence: {(queryResult.confidence * 100).toFixed(0)}%
                    </span>
                  </div>
                </div>

                <div className="text-xs text-text-primary leading-relaxed whitespace-pre-wrap">
                  {queryResult.answer}
                </div>

                {queryResult.debug_info?.supporting_chunks && queryResult.debug_info.supporting_chunks.length > 0 && (
                  <div className="mt-3 pt-3 border-t border-border-default/60 space-y-1.5">
                    <p className="text-[10px] text-text-secondary uppercase tracking-wider font-bold">Supporting Citations (Click to Focus Entity):</p>
                    <div className="flex flex-wrap gap-2">
                      {queryResult.debug_info.supporting_chunks.map((c: any, idx: number) => (
                        <button
                          key={idx}
                          onClick={() => {
                            const targetNode = rfNodes.find(n => {
                              const nodeLabel = String(n.data.label ?? "").toLowerCase();
                              return nodeLabel === c.document.toLowerCase().replace(".pdf", "").replace(".txt", "") ||
                                queryResult.debug_info?.matched_entities?.some((me: string) => nodeLabel === me.toLowerCase());
                            });
                            if (targetNode) {
                              reactFlowInstance.fitView({ nodes: [targetNode], duration: 600, maxZoom: 1.3 });
                              const rawN = rawNodes.find(rn => rn.id === targetNode.id);
                              if (rawN) setSelectedNodeData(rawN);
                            }
                          }}
                          className="text-[10px] px-2.5 py-1 bg-bg-tertiary hover:bg-accent/15 border border-border-default rounded-lg text-text-secondary hover:text-accent font-semibold flex items-center gap-1.5 transition-colors cursor-pointer"
                        >
                          <FileText size={11} />
                          <span>[{c.index}] {c.document} (Page {c.page || 1})</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* LYZR STUDIO — INDEPENDENT HALLUCINATION AUDIT */}
              <div className="border border-indigo-500/25 rounded-xl p-4 bg-indigo-950/10 space-y-3">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div className="flex items-center gap-2 min-w-0">
                    <ShieldCheck size={16} className="text-indigo-400 shrink-0" />
                    <div className="min-w-0">
                      <p className="text-xs font-semibold text-text-primary">
                        Independent Verification
                        <span className="ml-1.5 text-[9px] px-1.5 py-0.5 rounded bg-indigo-500/15 text-indigo-300 border border-indigo-500/30 font-mono uppercase tracking-wider">
                          Lyzr Studio
                        </span>
                      </p>
                      <p className="text-[10px] text-text-secondary mt-0.5">
                        A separate agent re-checks this answer against the graph evidence only.
                      </p>
                    </div>
                  </div>

                  <button
                    onClick={runLyzrVerification}
                    disabled={lyzrLoading || !lyzrStatus?.configured}
                    className="px-3 py-1.5 bg-indigo-500 text-white rounded-lg text-[11px] font-bold flex items-center gap-1.5 hover:opacity-90 transition-opacity cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
                  >
                    {lyzrLoading ? <RefreshCw size={12} className="animate-spin" /> : <ShieldCheck size={12} />}
                    {lyzrLoading ? "Auditing…" : "Verify answer"}
                  </button>
                </div>

                {!lyzrStatus?.configured && (
                  <p className="text-[10px] text-amber-400/90 bg-amber-500/10 border border-amber-500/25 rounded-lg px-2.5 py-2 font-mono">
                    Lyzr verifier not configured{lyzrStatus?.missing?.length ? ` — missing ${lyzrStatus.missing.join(", ")}` : ""}. Set LYZR_API_KEY, LYZR_AGENT_ID and LYZR_USER_ID in Kairo/.env, then restart the backend.
                  </p>
                )}

                {lyzrError && (
                  <p className="text-[10px] text-rose-400 bg-rose-500/10 border border-rose-500/25 rounded-lg px-2.5 py-2 font-mono break-words">
                    {lyzrError}
                  </p>
                )}

                {lyzrVerdict && (() => {
                  const tone =
                    lyzrVerdict.verdict === "SUPPORTED"
                      ? { text: "text-emerald-400", bg: "bg-emerald-500/10", border: "border-emerald-500/30", bar: "#10b981" }
                      : lyzrVerdict.verdict === "PARTIALLY_SUPPORTED"
                      ? { text: "text-amber-400", bg: "bg-amber-500/10", border: "border-amber-500/30", bar: "#f59e0b" }
                      : lyzrVerdict.verdict === "UNSUPPORTED"
                      ? { text: "text-rose-400", bg: "bg-rose-500/10", border: "border-rose-500/30", bar: "#f43f5e" }
                      : { text: "text-text-secondary", bg: "bg-white/5", border: "border-border-default", bar: "#9ca3af" };
                  const risk = lyzrVerdict.hallucination_risk;

                  return (
                    <div className="space-y-2.5 animate-in fade-in duration-200">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded border ${tone.text} ${tone.bg} ${tone.border}`}>
                          {lyzrVerdict.verdict.replace(/_/g, " ")}
                        </span>
                        {risk !== null && (
                          <span className="text-[10px] text-text-secondary font-mono">
                            hallucination risk {risk}%
                          </span>
                        )}
                        {!lyzrVerdict.parsed && (
                          <span className="text-[9px] text-amber-400/80 font-mono">(unstructured agent reply)</span>
                        )}
                      </div>

                      {risk !== null && (
                        <div className="h-1.5 w-full bg-white/10 rounded-full overflow-hidden">
                          <div
                            className="h-full rounded-full transition-all duration-500"
                            style={{ width: `${Math.max(risk, 2)}%`, backgroundColor: tone.bar }}
                          />
                        </div>
                      )}

                      {lyzrVerdict.reasoning && (
                        <p className="text-[11px] text-text-primary leading-relaxed">{lyzrVerdict.reasoning}</p>
                      )}

                      {lyzrVerdict.unsupported_claims?.length > 0 && (
                        <div className="space-y-1 pt-1">
                          <p className="text-[9px] uppercase tracking-wider font-bold text-text-secondary">
                            Claims not supported by graph evidence
                          </p>
                          {lyzrVerdict.unsupported_claims.map((c, i) => (
                            <p key={i} className="text-[10px] text-rose-300 bg-rose-500/5 border border-rose-500/20 rounded px-2 py-1 break-words">
                              {c}
                            </p>
                          ))}
                        </div>
                      )}

                      {/* Attribution: names the external service and the exact
                          agent that produced this verdict, so the audit is
                          itself traceable. */}
                      <p className="text-[9px] text-text-secondary/70 font-mono pt-1.5 border-t border-white/10 flex items-center gap-1 flex-wrap">
                        <ShieldCheck size={9} className="text-indigo-400" />
                        Audited by Lyzr Studio
                        {lyzrVerdict.agent_id && <span>&middot; agent {lyzrVerdict.agent_id}</span>}
                      </p>
                    </div>
                  );
                })()}
              </div>

              {showDebugPanel && queryResult.debug_info && (
                <div className="bg-[#0b0e14] border border-accent/20 rounded-xl p-5 space-y-4 font-mono text-[11px] text-text-secondary animate-in slide-in-from-top duration-300">
                  <div className="flex items-center justify-between border-b border-border-default/60 pb-2">
                    <span className="text-accent font-bold uppercase tracking-wider text-xs flex items-center gap-1.5">
                      <Sliders size={13} />
                      14-Stage Enterprise Graph RAG Debug Panel
                    </span>
                    <div className="flex gap-2">
                      <span className="text-[9px] bg-purple-500/10 border border-purple-500/20 px-2 py-0.5 rounded text-purple-400 font-bold">
                        Calls to OpenRouter: {queryResult.debug_info.number_of_openrouter_calls}
                      </span>
                      <span className="text-[9px] bg-amber-500/10 border border-amber-500/20 px-2 py-0.5 rounded text-amber-400 font-bold">
                        Latency: {queryResult.debug_info.llm_latency}
                      </span>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="space-y-3">
                      <div>
                        <p className="text-text-primary font-bold">1. Normalized Query</p>
                        <div className="mt-1 text-white bg-bg-secondary p-2 rounded border border-border-default">
                          "{queryResult.debug_info.normalized_query}"
                        </div>
                      </div>

                      <div>
                        <p className="text-text-primary font-bold">2. Local Matching & Canonical Resolution</p>
                        <div className="mt-1 text-white bg-bg-secondary p-2 rounded border border-border-default space-y-1">
                          <p>Matched Aliases: {queryResult.debug_info.matched_aliases.join(", ") || "(None)"}</p>
                          <p>Canonical Entities: {queryResult.debug_info.canonical_entities.join(", ") || "(None)"}</p>
                          <p>Seed Nodes: {queryResult.debug_info.seed_nodes.join(", ") || "(None)"}</p>
                        </div>
                      </div>

                      <div>
                        <p className="text-text-primary font-bold">3. BFS Traversal Metadata</p>
                        <div className="mt-1 text-white bg-bg-secondary p-2 rounded border border-border-default space-y-1">
                          <p>Hop Count (Depth): {queryResult.debug_info.hop_count}</p>
                          <p>Traversal Order: {queryResult.debug_info.traversal_order.join(" → ") || "(None)"}</p>
                        </div>
                      </div>
                    </div>

                    <div className="space-y-3">
                      <div>
                        <p className="text-text-primary font-bold">4. BFS Visited Subgraph</p>
                        <div className="mt-1 text-white bg-bg-secondary p-2 rounded border border-border-default space-y-1">
                          <p>Visited Nodes ({queryResult.debug_info.visited_nodes.length}): {queryResult.debug_info.visited_nodes.join(", ") || "(None)"}</p>
                          <p>Visited Relationships ({queryResult.debug_info.visited_relationships.length}):</p>
                          <div className="max-h-20 overflow-y-auto pl-2 text-[10px] text-purple-300">
                            {queryResult.debug_info.visited_relationships.map((r: string, idx: number) => (
                              <div key={idx}>- {r}</div>
                            )) || "(None)"}
                          </div>
                        </div>
                      </div>

                      <div>
                        <p className="text-text-primary font-bold">5. Graph-Bound Chunks & Provenance</p>
                        <div className="mt-1 text-white bg-bg-secondary p-2 rounded border border-border-default space-y-1">
                          <p>Retrieved Chunk IDs ({queryResult.debug_info.retrieved_chunk_ids.length}): {queryResult.debug_info.retrieved_chunk_ids.join(", ") || "(None)"}</p>
                          <p>Retrieved Documents ({queryResult.debug_info.retrieved_documents.length}): {queryResult.debug_info.retrieved_documents.join(", ") || "(None)"}</p>
                        </div>
                      </div>

                      <div>
                        <p className="text-text-primary font-bold">6. Confidence Breakdown</p>
                        <div className="mt-1 text-emerald-400 bg-bg-secondary p-2 rounded border border-border-default">
                          {queryResult.debug_info.confidence_breakdown}
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="pt-2 border-t border-border-default/60 grid grid-cols-1 gap-2">
                    <div>
                      <p className="text-text-primary font-bold">7. Hybrid Single LLM Request (Prompt Len: {queryResult.debug_info.prompt_length} chars)</p>
                      <pre className="mt-1 bg-[#07090d] border border-border-default rounded p-3 text-[10px] text-white overflow-x-auto max-h-48 whitespace-pre-wrap leading-normal font-mono">
                        {queryResult.debug_info.final_llm_request}
                      </pre>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* LIVE INGESTION FEED */}
        <div className="lg:col-span-4 bg-card-background border border-border-default rounded-2xl p-5 shadow-xl space-y-3">
          <div className="flex items-center justify-between border-b border-border-default pb-3">
            <h3 className="text-sm font-bold text-text-primary flex items-center gap-2">
              <Activity size={16} className="text-blue-400" />
              Ingested Network Edges
            </h3>
            <span className="text-[11px] text-text-secondary font-mono">{rawEdges.length} Ingested</span>
          </div>

          <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
            {rawEdges.slice(0, 6).map((edge, idx) => (
              <div key={idx} className="p-2.5 bg-bg-secondary/60 border border-border-default rounded-xl flex items-center justify-between text-xs">
                <div className="truncate max-w-[70%]">
                  <span className="font-semibold text-text-primary">{edge.source}</span>
                  <span className="text-[10px] font-mono text-purple-400 mx-1.5 font-bold">[{edge.relation}]</span>
                  <span className="text-text-primary">{edge.target}</span>
                </div>
                <span className="text-[10px] font-mono text-emerald-400 font-bold">{(edge.confidence * 100).toFixed(0)}%</span>
              </div>
            ))}
            {rawEdges.length === 0 && (
              <div className="text-center py-8 text-xs text-text-secondary">
                No edges indexed in compliance graph yet.
              </div>
            )}
          </div>
        </div>

      </div>
    </div>
  );
}

export default function KnowledgeGraphView({ onGoToUpload }: { onGoToUpload?: () => void }) {
  return (
    <ReactFlowProvider>
      <KnowledgeGraphFlowCanvas onGoToUpload={onGoToUpload} />
    </ReactFlowProvider>
  );
}
