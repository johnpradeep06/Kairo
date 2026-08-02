"""
graph_router.py
===============
FastAPI APIRouter for Enterprise Knowledge Graph operations in Kairo.

Exposes REST API endpoints:
- POST /graph/query: Execute Graph RAG questions backed by Neo4j compliance graph
- GET /graph/visualize: Retrieve nodes & edges for graph visualization
- GET /graph/stats: Aggregate metrics on entity types, relationships, and indexed docs
- DELETE /graph/documents/{doc_id}: Purge document graph nodes/edges
- POST /graph/ingest: Trigger Knowledge Graph synthesis for a document
"""

from typing import Dict, Any, Union
from fastapi import APIRouter, HTTPException, status, Depends

from graph_models import GraphRAGQuery, GraphRAGResponse, SubGraph, GraphStatsResponse
from graph_service import graph_service

router = APIRouter(prefix="/graph", tags=["Knowledge Graph"])


@router.post("/query", response_model=GraphRAGResponse)
def query_knowledge_graph(query: GraphRAGQuery) -> GraphRAGResponse:
    """Execute Graph RAG compliance question using Neo4j graph context."""
    try:
        return graph_service.query_graph_rag(
            question=query.question,
            top_k=query.top_k,
            depth=query.depth
        )
    except Exception as err:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Graph RAG query failed: {err}"
        )


@router.get("/visualize", response_model=SubGraph)
def get_graph_visualization() -> SubGraph:
    """Retrieve nodes and edges formatted for D3 / Vis.js network visualization."""
    try:
        return graph_service.get_visualization_data()
    except Exception as err:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to fetch graph visualization data: {err}"
        )


@router.get("/stats", response_model=GraphStatsResponse)
def get_knowledge_graph_stats() -> GraphStatsResponse:
    """Get global Knowledge Graph analytics (node counts, relationship counts, document counts)."""
    try:
        return graph_service.get_stats()
    except Exception as err:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to fetch graph stats: {err}"
        )


@router.delete("/documents/{doc_id}")
def delete_document_graph(doc_id: str) -> Dict[str, Any]:
    """Purge document entities and relationships from Neo4j."""
    try:
        deleted_count = graph_service.delete_document_graph(doc_id)
        return {
            "status": "success",
            "document_id": doc_id,
            "deleted_relationships": deleted_count
        }
    except Exception as err:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to delete document graph: {err}"
        )


@router.post("/purge")
def purge_knowledge_graph() -> Dict[str, Any]:
    """Wipe every entity and relationship from the graph store.

    The graph lives in an external Neo4j instance that outlives the app's own
    storage, so after a redeploy that resets the document table the graph can
    still be full of entities belonging to documents that no longer exist.
    This resets it to empty so the corpus can be re-ingested cleanly.
    """
    try:
        return {"status": "success", **graph_service.purge_graph()}
    except Exception as err:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to purge knowledge graph: {err}"
        )


@router.post("/ingest")
def trigger_graph_ingestion(file_path: str, doc_id: Union[str, int]) -> Dict[str, Any]:
    """Manually trigger Knowledge Graph synthesis for an uploaded file."""
    try:
        return graph_service.process_document_for_graph(file_path=file_path, doc_id=doc_id)
    except Exception as err:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Knowledge Graph ingestion failed: {err}"
        )
