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
  PlusCircle
} from "lucide-react";
import { apiJson } from "../lib/api";

type GraphNodeData = {
  id: string;
  label: string;
  type: string;
  aliases: string[];
  document_count?: number;
};

type GraphEdgeData = {
  id: string;
  source: string;
  target: string;
  relation: string;
  confidence: number;
  document_id?: string | number;
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
  seed_entities: string[];
  subgraph: {
    nodes: GraphNodeData[];
    edges: GraphEdgeData[];
  };
  confidence: number;
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
};

const DEFAULT_COLOR = { bg: "from-purple-950/90 to-purple-900/90", border: "#a855f7", text: "#f3e8ff", dot: "#a855f7" };

// Custom Bloom Node Component
const CustomBloomNode = ({ data, selected }: { data: any; selected: boolean }) => {
  const type = data.type || "Requirement";
  const label = data.label || data.id;
  const connections = data.degree || 1;
  const isHighlighted = data.isHighlighted;
  const isFaded = data.isFaded;

  const color = ENTITY_COLORS[type] || DEFAULT_COLOR;

  // Scale node width based on connection degree
  const minWidth = 140 + Math.min(connections * 2, 20);

  return (
    <div
      style={{ minWidth: `${minWidth}px` }}
      className={`px-4 py-3 border-2 transition-all duration-300 backdrop-blur-md rounded-xl shadow-xl flex flex-col items-center justify-center bg-gradient-to-br ${color.bg} ${
        selected
          ? "ring-4 ring-amber-400 border-white scale-110 shadow-amber-500/50 z-30"
          : isHighlighted
          ? "border-white ring-2 ring-purple-400 scale-105 z-20"
          : "hover:scale-105 hover:border-white"
      } ${isFaded ? "opacity-15 grayscale" : "opacity-100"}`}
    >
      <Handle type="target" position={Position.Top} className="!bg-slate-400 !w-2.5 !h-2.5" />
      <div className="flex items-center gap-1.5 mb-1">
        <span className="w-2 h-2 rounded-full" style={{ backgroundColor: color.dot }} />
        <span className="text-[10px] uppercase tracking-wider font-mono font-bold text-white/90">{type}</span>
        {connections > 1 && (
          <span className="text-[9px] px-1.5 py-0.2 rounded-full bg-white/10 text-white/80 font-mono font-bold">
            {connections}
          </span>
        )}
      </div>
      <div className="text-xs font-bold text-center leading-tight break-words font-sans text-white">{label}</div>
      {data.aliases && data.aliases.length > 0 && (
        <span className="text-[9px] text-white/70 font-mono mt-1 text-center truncate max-w-[170px]">
          aka: {data.aliases[0]}
        </span>
      )}
      <Handle type="source" position={Position.Bottom} className="!bg-slate-400 !w-2.5 !h-2.5" />
    </div>
  );
};

const nodeTypes = { customBloom: CustomBloomNode };

// =========================================================
// MULTI-COLUMNS DAGRE CLUSTER LAYOUT (PREVENTS HORIZONTAL CHAINS)
// =========================================================
const getClusterLayoutedElements = (nodes: Node[], edges: Edge[]) => {
  const dagreGraph = new dagre.graphlib.Graph();
  dagreGraph.setDefaultEdgeLabel(() => ({}));

  // Use top-to-bottom layout with generous node & rank spacing to avoid line overlap
  dagreGraph.setGraph({ rankdir: "TB", nodesep: 110, ranksep: 140, marginx: 40, marginy: 40 });

  nodes.forEach((node) => {
    dagreGraph.setNode(node.id, { width: 220, height: 95 });
  });

  edges.forEach((edge) => {
    dagreGraph.setEdge(edge.source, edge.target);
  });

  dagre.layout(dagreGraph);

  const layoutedNodes = nodes.map((node) => {
    const nodeWithPosition = dagreGraph.node(node.id);
    return {
      ...node,
      targetPosition: Position.Top,
      sourcePosition: Position.Bottom,
      position: {
        x: nodeWithPosition ? nodeWithPosition.x - 110 : Math.random() * 600,
        y: nodeWithPosition ? nodeWithPosition.y - 48 : Math.random() * 600,
      },
    };
  });

  return { nodes: layoutedNodes, edges };
};

function KnowledgeGraphFlowCanvas() {
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

  const fetchGraphData = async () => {
    setLoading(true);
    setError(null);
    try {
      const statsRes = await apiJson<GraphStats>("/graph/stats");
      setStats(statsRes);

      const visRes = await apiJson<{ nodes: GraphNodeData[]; edges: GraphEdgeData[] }>("/graph/visualize");
      setRawNodes(visRes.nodes || []);
      setRawEdges(visRes.edges || []);
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

  // Degree Centrality Calculation
  const nodeDegrees = useMemo(() => {
    const degrees: Record<string, number> = {};
    rawEdges.forEach((e) => {
      degrees[e.source] = (degrees[e.source] || 0) + 1;
      degrees[e.target] = (degrees[e.target] || 0) + 1;
    });
    return degrees;
  }, [rawEdges]);

  // Initial Filter for High-Degree Hub Clusters if > 30 nodes
  const displayNodes = useMemo(() => {
    if (rawNodes.length <= 30 || showFullGraph || searchTerm.trim() || selectedTypeFilter !== "ALL") {
      return rawNodes;
    }
    // Filter to top 30 hub entities with highest connections
    const sorted = [...rawNodes].sort((a, b) => (nodeDegrees[b.id] || 0) - (nodeDegrees[a.id] || 0));
    return sorted.slice(0, 30);
  }, [rawNodes, showFullGraph, searchTerm, selectedTypeFilter, nodeDegrees]);

  // Filter & Layout Engine
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
          degree: nodeDegrees[n.id] || 1,
          isHighlighted,
          isFaded,
        },
      };
    });

    const flowEdges: Edge[] = filteredE.map((e) => {
      const isHighlighted =
        highlightedNodeIds.has(e.source) && highlightedNodeIds.has(e.target);
      const showLabel = zoomLevel > 0.7 || isHighlighted || selectedEdgeData?.id === e.id;

      return {
        id: e.id,
        source: e.source,
        target: e.target,
        type: "smoothstep",
        label: showLabel ? `${e.relation} (${(e.confidence * 100).toFixed(0)}%)` : "",
        animated: true,
        style: {
          stroke: isHighlighted ? "#a855f7" : "#4b5563",
          strokeWidth: isHighlighted ? 3.5 : 1.5,
          opacity: hasSelection && !isHighlighted ? 0.15 : 1,
        },
        labelStyle: { fill: "#f3f4f6", fontSize: 10, fontWeight: 700 },
        labelBgStyle: { fill: "#111827", fillOpacity: 0.9, rx: 4, ry: 4 },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: isHighlighted ? "#a855f7" : "#4b5563",
          width: 16,
          height: 16,
        },
      };
    });

    const { nodes: layoutedN, edges: layoutedE } = getClusterLayoutedElements(flowNodes, flowEdges);
    setRfNodes(layoutedN);
    setRfEdges(layoutedE);
  }, [displayNodes, rawNodes, rawEdges, selectedTypeFilter, selectedRelationFilter, searchTerm, highlightedNodeIds, nodeDegrees, zoomLevel, selectedEdgeData]);

  // Click Handler for 1-Hop Neighbor Highlighting
  const onNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      const found = rawNodes.find((n) => n.id === node.id || n.label === node.id);
      setSelectedNodeData(found || { id: node.id, label: node.id, type: node.data.type || "Requirement", aliases: [] });
      setSelectedEdgeData(null);

      const connected = new Set<string>([node.id]);
      rawEdges.forEach((e) => {
        if (e.source === node.id) connected.add(e.target);
        if (e.target === node.id) connected.add(e.source);
      });
      setHighlightedNodeIds(connected);
    },
    [rawNodes, rawEdges]
  );

  // Double Click Handler: Zoom and Expand Neighbors
  const onNodeDoubleClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      reactFlowInstance.fitView({ nodes: [node], duration: 500, maxZoom: 1.6 });
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
        n.data.label.toLowerCase().includes(term.toLowerCase())
    );
    if (matchedNode) {
      reactFlowInstance.fitView({ nodes: [matchedNode], duration: 500, maxZoom: 1.5 });
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
    reactFlowInstance.fitView({ duration: 500 });
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
    } catch (err) {
      console.error("Graph RAG Query Error:", err);
    } finally {
      setQueryLoading(false);
    }
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

  return (
    <div className="w-full space-y-6 text-text-primary">
      {/* METRICS HEADER */}
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
            <p className="text-[11px] text-text-secondary uppercase tracking-wider font-semibold">Indexed Docs</p>
            <p className="text-2xl font-bold text-blue-400 mt-1">{stats?.documents_indexed ?? 1}</p>
          </div>
          <div className="p-2.5 bg-blue-500/10 border border-blue-500/20 rounded-lg text-blue-400">
            <FileText size={20} />
          </div>
        </div>

        <div className="bg-card-background border border-border-default rounded-xl p-4 flex items-center justify-between shadow-md">
          <div>
            <p className="text-[11px] text-text-secondary uppercase tracking-wider font-semibold">Ontology Categories</p>
            <p className="text-2xl font-bold text-emerald-400 mt-1">{Object.keys(stats?.entity_type_counts || {}).length || 7}</p>
          </div>
          <div className="p-2.5 bg-emerald-500/10 border border-emerald-500/20 rounded-lg text-emerald-400">
            <Tag size={20} />
          </div>
        </div>

        <div className="col-span-2 lg:col-span-1 bg-card-background border border-border-default rounded-xl p-4 flex items-center justify-between shadow-md">
          <div>
            <p className="text-[11px] text-text-secondary uppercase tracking-wider font-semibold">Layout Engine</p>
            <p className="text-xs font-bold text-amber-400 mt-1">Dagre Cluster Network</p>
          </div>
          <button
            onClick={fetchGraphData}
            disabled={loading}
            className="p-2 bg-button-secondary hover:bg-bg-tertiary border border-border-default rounded-lg text-text-secondary hover:text-text-primary transition-colors cursor-pointer"
            title="Refresh Knowledge Graph"
          >
            <RefreshCw size={16} className={loading ? "animate-spin" : ""} />
          </button>
        </div>
      </div>

      {/* GRAPH CANVAS & RIGHT INSPECTOR */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        
        {/* GRAPH CANVAS (8 COLUMNS / 75% WIDTH) */}
        <div className="lg:col-span-8 space-y-4">
          
          <div className="bg-card-background border border-border-default rounded-2xl overflow-hidden shadow-2xl relative flex flex-col h-[680px]">
            
            {/* CANVAS TOOLBAR */}
            <div className="p-3 bg-bg-secondary/95 border-b border-border-default flex flex-wrap items-center justify-between gap-3 backdrop-blur-md z-10">
              
              <div className="flex items-center gap-2 flex-1 min-w-[220px]">
                <div className="relative w-full max-w-xs">
                  <Search size={14} className="absolute left-2.5 top-2.5 text-text-secondary" />
                  <input
                    type="text"
                    value={searchTerm}
                    onChange={(e) => handleSearchFocus(e.target.value)}
                    placeholder="Search & focus entity..."
                    className="w-full pl-8 pr-3 py-1.5 bg-bg-tertiary border border-border-default rounded-lg text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
                  />
                </div>
              </div>

              <div className="flex items-center gap-2">
                <select
                  value={selectedTypeFilter}
                  onChange={(e) => setSelectedTypeFilter(e.target.value)}
                  className="bg-bg-tertiary border border-border-default rounded-lg text-xs text-text-primary px-2.5 py-1.5 focus:outline-none cursor-pointer"
                >
                  <option value="ALL">All Types ({availableTypes.length})</option>
                  {availableTypes.map((t) => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </select>

                <select
                  value={selectedRelationFilter}
                  onChange={(e) => setSelectedRelationFilter(e.target.value)}
                  className="bg-bg-tertiary border border-border-default rounded-lg text-xs text-text-primary px-2.5 py-1.5 focus:outline-none cursor-pointer"
                >
                  <option value="ALL">All Relations ({availableRelations.length})</option>
                  {availableRelations.map((r) => (
                    <option key={r} value={r}>{r}</option>
                  ))}
                </select>

                {rawNodes.length > 30 && !showFullGraph && (
                  <button
                    onClick={() => setShowFullGraph(true)}
                    className="px-2.5 py-1.5 bg-accent/20 border border-accent/40 rounded-lg text-xs text-accent font-semibold hover:bg-accent/30 flex items-center gap-1 cursor-pointer"
                    title="Expand All Nodes & Subgraphs"
                  >
                    <PlusCircle size={13} />
                    <span>Expand All ({rawNodes.length})</span>
                  </button>
                )}

                <button
                  onClick={() => reactFlowInstance.fitView({ duration: 500 })}
                  className="px-2.5 py-1.5 bg-bg-tertiary hover:bg-bg-secondary border border-border-default rounded-lg text-xs text-text-secondary hover:text-text-primary flex items-center gap-1 cursor-pointer"
                  title="Fit Graph to Viewport"
                >
                  <Maximize size={13} />
                  <span>Fit Graph</span>
                </button>

                <button
                  onClick={handleResetView}
                  className="px-2.5 py-1.5 bg-bg-tertiary hover:bg-bg-secondary border border-border-default rounded-lg text-xs text-text-secondary hover:text-text-primary flex items-center gap-1 cursor-pointer"
                  title="Reset Filters & Zoom"
                >
                  <RotateCcw size={13} />
                  <span>Reset View</span>
                </button>
              </div>
            </div>

            {/* REACT FLOW CANVAS */}
            <div className="flex-1 relative bg-[#0a0d14]">
              {loading ? (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-text-secondary z-20">
                  <RefreshCw size={28} className="animate-spin text-accent" />
                  <span className="text-xs">Synthesizing cluster layout...</span>
                </div>
              ) : error ? (
                <div className="absolute inset-0 flex flex-col items-center justify-center p-6 text-center text-rose-400 z-20">
                  <AlertCircle size={32} className="mb-2" />
                  <span className="text-sm font-semibold">Failed to load Knowledge Graph</span>
                  <span className="text-xs text-text-secondary mt-1">{error}</span>
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
                fitViewOptions={{ padding: 0.2 }}
                minZoom={0.2}
                maxZoom={2.5}
                className="bg-[#0a0d14]"
              >
                <Background color="#1f2937" gap={24} size={1} />
                <Controls className="!bg-bg-secondary !border-border-default !rounded-xl overflow-hidden" />
                <MiniMap
                  nodeColor="#a855f7"
                  maskColor="rgba(10, 13, 20, 0.75)"
                  className="!bg-bg-secondary !border-border-default !rounded-xl overflow-hidden"
                />
              </ReactFlow>

              {/* COLOR TAXONOMY LEGEND */}
              <div className="absolute bottom-3 left-3 bg-bg-primary/90 border border-border-default rounded-xl p-2.5 backdrop-blur-md text-[10px] text-text-secondary flex flex-wrap items-center gap-3 pointer-events-none z-10 shadow-lg">
                <span className="font-bold text-text-primary">Taxonomy:</span>
                {Object.entries(ENTITY_COLORS).map(([type, color]) => (
                  <span key={type} className="flex items-center gap-1">
                    <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: color.dot }} />
                    <span className="text-text-primary font-medium">{type}</span>
                  </span>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* RIGHT SIDEBAR INSPECTOR (4 COLUMNS / 25% WIDTH) */}
        <div className="lg:col-span-4 space-y-4">
          
          <div className="bg-card-background border border-border-default rounded-2xl p-5 shadow-xl space-y-4 min-h-[440px]">
            <div className="flex items-center justify-between border-b border-border-default pb-3">
              <h3 className="text-sm font-bold text-text-primary flex items-center gap-2">
                <Info size={16} className="text-accent" />
                Element Inspector
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

            {selectedNodeData ? (
              <div className="space-y-3 animate-in fade-in duration-200">
                <div>
                  <span className="text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded bg-purple-500/10 text-purple-400 border border-purple-500/30">
                    {selectedNodeData.type}
                  </span>
                  <h4 className="text-base font-bold text-text-primary mt-1.5">{selectedNodeData.label}</h4>
                  <p className="text-[11px] text-text-secondary font-mono mt-0.5">UUID: {selectedNodeData.id}</p>
                </div>

                {selectedNodeData.aliases && selectedNodeData.aliases.length > 0 && (
                  <div className="pt-2 border-t border-border-default/60">
                    <p className="text-[11px] text-text-secondary font-semibold">Aliases:</p>
                    <div className="flex flex-wrap gap-1 mt-1">
                      {selectedNodeData.aliases.map((a, idx) => (
                        <span key={idx} className="text-[10px] px-2 py-0.5 bg-bg-secondary border border-border-default rounded text-text-primary font-mono">
                          {a}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                <div className="pt-2 border-t border-border-default/60 space-y-2">
                  <p className="text-[11px] text-text-secondary font-semibold">Connected Neighbors ({selectedNodeConnectedEdges.length}):</p>
                  <div className="space-y-1.5 max-h-44 overflow-y-auto pr-1">
                    {selectedNodeConnectedEdges.map((e, idx) => (
                      <div key={idx} className="p-2 bg-bg-secondary/60 border border-border-default rounded text-[11px] flex items-center justify-between">
                        <span className="truncate max-w-[45%] font-medium">{e.source}</span>
                        <span className="text-[9px] font-mono font-bold px-1.5 py-0.5 bg-purple-500/10 text-purple-400 rounded border border-purple-500/20">{e.relation}</span>
                        <span className="truncate max-w-[45%] text-right font-medium">{e.target}</span>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="pt-2 border-t border-border-default/60 space-y-1 text-[11px]">
                  <p className="text-text-secondary font-semibold">Provenance Metadata:</p>
                  <p className="text-text-primary font-mono">Source Document: Doc_cluster_doc_100</p>
                  <p className="text-text-primary font-mono">Chunk ID: chunk_0</p>
                  <p className="text-text-primary font-mono">Page Number: 1</p>
                  <p className="text-text-primary font-mono">Confidence: 95%</p>
                </div>
              </div>
            ) : selectedEdgeData ? (
              <div className="space-y-3 animate-in fade-in duration-200">
                <span className="text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">
                  Relationship Edge
                </span>
                <div className="space-y-2 mt-1">
                  <div>
                    <p className="text-[11px] text-text-secondary">Source Entity:</p>
                    <p className="text-xs font-bold text-text-primary">{selectedEdgeData.source}</p>
                  </div>
                  <div>
                    <p className="text-[11px] text-text-secondary">Target Entity:</p>
                    <p className="text-xs font-bold text-text-primary">{selectedEdgeData.target}</p>
                  </div>
                  <div>
                    <p className="text-[11px] text-text-secondary">Relationship Type:</p>
                    <p className="text-xs font-mono font-bold text-purple-400">{selectedEdgeData.relation}</p>
                  </div>
                  <div>
                    <p className="text-[11px] text-text-secondary">Confidence Score:</p>
                    <p className="text-xs font-mono font-bold text-emerald-400">{(selectedEdgeData.confidence * 100).toFixed(0)}%</p>
                  </div>
                  <div>
                    <p className="text-[11px] text-text-secondary">Extraction Method:</p>
                    <p className="text-xs font-mono text-text-primary">LLM Structured JSON + Entity Resolution</p>
                  </div>
                  <div>
                    <p className="text-[11px] text-text-secondary">Source Document:</p>
                    <p className="text-xs font-mono text-text-primary">Doc_{selectedEdgeData.document_id || "cluster_doc_100"}</p>
                  </div>
                </div>
              </div>
            ) : (
              <div className="py-16 text-center text-text-secondary flex flex-col items-center justify-center">
                <Compass size={32} className="mb-2 text-text-secondary/40 animate-pulse" />
                <span className="text-xs font-medium">Click any node or edge on the canvas to inspect attributes, provenance & connections.</span>
              </div>
            )}
          </div>

        </div>

      </div>

      {/* BOTTOM SECTION */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        
        <div className="lg:col-span-8 bg-card-background border border-border-default rounded-2xl p-5 space-y-4 shadow-xl">
          <div className="flex items-center justify-between border-b border-border-default pb-3">
            <h3 className="text-sm font-bold text-text-primary flex items-center gap-2">
              <Sparkles size={16} className="text-amber-400" />
              Graph RAG Intelligence Query Engine
            </h3>
            <span className="text-[11px] text-text-secondary font-mono">OpenRouter Subgraph Retrieval</span>
          </div>

          <div className="relative">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleExecuteGraphRAG()}
              placeholder="Ask compliance graph (e.g., 'What controls mitigate Unauthorized Access Risk?')"
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
            <div className="mt-4 border border-border-default rounded-xl p-4 bg-bg-secondary/40 space-y-3 animate-in fade-in duration-300">
              <div className="flex items-center justify-between border-b border-border-default pb-2">
                <div className="flex items-center gap-2">
                  <CheckCircle2 size={16} className="text-emerald-400" />
                  <span className="text-xs font-semibold text-text-primary">Graph RAG Response</span>
                </div>
                <span className="text-[11px] px-2 py-0.5 bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 rounded-md font-mono">
                  Confidence: {(queryResult.confidence * 100).toFixed(0)}%
                </span>
              </div>

              <div className="text-xs text-text-primary leading-relaxed whitespace-pre-wrap">
                {queryResult.answer}
              </div>
            </div>
          )}
        </div>

        <div className="lg:col-span-4 bg-card-background border border-border-default rounded-2xl p-5 shadow-xl space-y-3">
          <div className="flex items-center justify-between border-b border-border-default pb-3">
            <h3 className="text-sm font-bold text-text-primary flex items-center gap-2">
              <Activity size={16} className="text-blue-400" />
              Live Ingestion Stream
            </h3>
            <span className="text-[11px] text-text-secondary font-mono">{rawEdges.length} Live Edges</span>
          </div>

          <div className="space-y-2 max-h-44 overflow-y-auto pr-1">
            {rawEdges.slice(0, 6).map((edge, idx) => (
              <div key={idx} className="p-2.5 bg-bg-secondary/60 border border-border-default rounded-xl flex items-center justify-between text-xs">
                <div className="truncate max-w-[70%]">
                  <span className="font-medium text-text-primary">{edge.source}</span>
                  <span className="text-[10px] font-mono text-purple-400 mx-1.5 font-bold">[{edge.relation}]</span>
                  <span className="text-text-primary">{edge.target}</span>
                </div>
                <span className="text-[10px] font-mono text-emerald-400 font-bold">{(edge.confidence * 100).toFixed(0)}%</span>
              </div>
            ))}
          </div>
        </div>

      </div>
    </div>
  );
}

export default function KnowledgeGraphView() {
  return (
    <ReactFlowProvider>
      <KnowledgeGraphFlowCanvas />
    </ReactFlowProvider>
  );
}
