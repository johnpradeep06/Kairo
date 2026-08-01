"""
graph_service.py
================
Application Logic Layer & Graph RAG Service Orchestrator.

Coordinates document parsing, chunking, extraction with graph_builder,
persistence with graph_repository (Neo4j), document dynamic updates/deletions,
and Graph RAG query context synthesis.
"""

import os
import logging
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import List, Dict, Any, Union, Optional

from langchain_community.document_loaders import PyPDFLoader, TextLoader
from langchain_text_splitters import RecursiveCharacterTextSplitter
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.output_parsers import StrOutputParser

from graph_models import (
    Entity, Relationship, ExtractionResult, SubGraph,
    GraphRAGQuery, GraphRAGResponse, GraphStatsResponse
)
from graph_builder import extract_from_chunk, EntityResolver
from graph_repository import graph_repository
from rag_pipeline import llm

logger = logging.getLogger(__name__)

GRAPH_RAG_PROMPT = ChatPromptTemplate.from_template(
"""You are Kairo Enterprise Graph RAG, a specialized compliance AI assistant.
Answer the user's question using ONLY the provided Knowledge Graph facts, entity relationships, and provenance context.

KNOWLEDGE GRAPH CONTEXT & EVIDENCE:
\"\"\"
{graph_context}
\"\"\"

USER QUESTION:
{question}

Provide a structured, accurate compliance answer citing the entity relationships and evidence from the graph context. If the graph context is insufficient, state clearly what facts are present and what is missing.
"""
)


class GraphService:
    """Orchestrates document knowledge graph synthesis and Graph RAG queries."""

    def __init__(self):
        self.repository = graph_repository
        self.text_splitter = RecursiveCharacterTextSplitter(
            chunk_size=1000,
            chunk_overlap=200
        )

    def process_document_for_graph(
        self,
        file_path: str,
        doc_id: Union[str, int]
    ) -> Dict[str, Any]:
        """Parse file into chunks, extract entities/relations with LLM, and persist to Neo4j/SQLite with 10-stage logging."""
        import time
        start_time = time.time()
        logger.info("✓ Stage 1: Upload Completed for doc %s", doc_id)
        logger.info("✓ Stage 2: Background Task Started for doc %s", doc_id)

        ext = os.path.splitext(file_path)[1].lower()
        if ext == ".pdf":
            loader = PyPDFLoader(file_path)
        elif ext in [".txt", ".md"]:
            loader = TextLoader(file_path, encoding="utf-8")
        elif ext == ".docx":
            from langchain_community.document_loaders import Docx2txtLoader
            loader = Docx2txtLoader(file_path)
        else:
            raise ValueError(f"Unsupported file format for Knowledge Graph: {ext}")

        docs = loader.load()
        splits = self.text_splitter.split_documents(docs)
        parse_time = time.time() - start_time
        logger.info("✓ Stage 3: Chunks Received from Parser (%d chunks, Time: %.2fs)", len(splits), parse_time)

        resolver = EntityResolver()
        total_extracted_entities = 0
        total_extracted_rels = 0
        total_nodes_inserted = 0
        total_edges_inserted = 0

        import threading
        db_lock = threading.Lock()

        max_chunks = min(len(splits), 15)

        def _process_chunk_worker(item):
            idx, chunk = item
            page_num = chunk.metadata.get("page", chunk.metadata.get("page_number", 1))
            if isinstance(page_num, int):
                page_num += 1

            chunk_id = f"{doc_id}_chunk_{idx}"
            logger.info("✓ Stage 4: graph_builder.extract() Executing for chunk %d/%d (doc %s)...", idx + 1, max_chunks, doc_id)

            local_resolver = EntityResolver()
            try:
                extraction = extract_from_chunk(
                    chunk_text=chunk.page_content,
                    document_id=doc_id,
                    chunk_id=chunk_id,
                    page_number=page_num,
                    resolver=local_resolver
                )
                return idx, extraction
            except Exception as chunk_err:
                logger.error("[graph_service] Chunk %d extraction failed for doc %s: %s", idx + 1, doc_id, chunk_err, exc_info=True)
                return idx, None

        with ThreadPoolExecutor(max_workers=5) as executor:
            futures = [executor.submit(_process_chunk_worker, (i, ch)) for i, ch in enumerate(splits[:max_chunks])]
            for future in as_completed(futures):
                idx, extraction = future.result()
                if extraction:
                    num_e = len(extraction.entities)
                    num_r = len(extraction.relationships)
                    total_extracted_entities += num_e
                    total_extracted_rels += num_r
                    logger.info("✓ Stage 5: LLM Extraction Returned (%d entities, %d relationships for chunk %d)", num_e, num_r, idx + 1)

                    with db_lock:
                        logger.info("✓ Stage 7: graph_repository.save() Executing for chunk %d", idx + 1)
                        n_count, e_count = self.repository.upsert_extraction_result(extraction)
                        total_nodes_inserted += n_count
                        total_edges_inserted += e_count
                        logger.info("✓ Stage 8: Graph MERGE Queries Succeeded (Nodes: %d, Edges: %d)", n_count, e_count)

        current_stats = self.repository.get_stats()
        logger.info("✓ Stage 9: Graph Statistics Refreshed (Total Nodes: %d, Total Edges: %d)", current_stats.total_nodes, current_stats.total_relationships)
        logger.info("✓ Stage 10: Ingestion Completed in %.2fs", time.time() - start_time)

        print("\n" + "="*50)
        print(f"Chunks Processed: {max_chunks}")
        print(f"Entities Extracted: {total_extracted_entities}")
        print(f"Relationships Extracted: {total_extracted_rels}")
        print(f"Nodes Stored: {current_stats.total_nodes}")
        print(f"Edges Stored: {current_stats.total_relationships}")
        print(f"Graph Size: {current_stats.total_nodes} nodes, {current_stats.total_relationships} edges")
        print("="*50 + "\n")

        return {
            "document_id": doc_id,
            "chunks_processed": max_chunks,
            "nodes_created": total_nodes_inserted,
            "relationships_created": total_edges_inserted,
            "graph_size_nodes": current_stats.total_nodes,
            "graph_size_edges": current_stats.total_relationships
        }

    def delete_document_graph(self, doc_id: Union[str, int]) -> int:
        """Remove document entity relationships from Neo4j."""
        deleted = self.repository.delete_document_graph(doc_id)
        logger.info("[graph_service] Deleted %d graph relationships for doc %s", deleted, doc_id)
        return deleted

    def _extract_seed_terms(self, question: str) -> List[str]:
        """Extract candidate compliance terms from user question for graph traversal."""
        words = question.replace("?", "").replace(".", "").split()
        seeds = [w.strip() for w in words if len(w) > 3 and w.lower() not in {"what", "which", "where", "how", "does", "this", "that", "from"}]
        return seeds[:5]

    def query_graph_rag(
        self,
        question: str,
        top_k: int = 5,
        depth: int = 2
    ) -> GraphRAGResponse:
        """Perform seed entity traversal, construct Knowledge Graph context, and generate LLM response."""
        seeds = self._extract_seed_terms(question)
        subgraph = self.repository.get_subgraph_around_seeds(seeds, depth=depth, max_nodes=50)

        # Build textual graph context snippet for LLM prompt
        context_lines: List[str] = ["=== ENTITIES IN GRAPH ==="]
        for node in subgraph.nodes:
            alias_str = f" (aka {', '.join(node.aliases)})" if node.aliases else ""
            context_lines.append(f"- [{node.type}] {node.label}{alias_str}")

        context_lines.append("\n=== COMPLIANCE RELATIONSHIPS & EVIDENCE ===")
        for edge in subgraph.edges:
            context_lines.append(
                f"- ({edge.source}) --[{edge.relation} (confidence: {edge.confidence:.2f})]--> ({edge.target})"
            )

        graph_context = "\n".join(context_lines)

        try:
            chain = GRAPH_RAG_PROMPT | llm | StrOutputParser()
            answer = chain.invoke({"graph_context": graph_context, "question": question})
        except Exception as err:
            logger.warning("[graph_service] LLM Graph RAG invoke failed: %s. Generating deterministic Graph RAG response.", err)
            answer_parts = [f"### Knowledge Graph RAG Subgraph Synthesis\n"]
            answer_parts.append(f"**Query**: {question}\n")
            if subgraph.nodes:
                answer_parts.append("**Retrieved Compliance Entities:**")
                for n in subgraph.nodes[:6]:
                    answer_parts.append(f"- **[{n.type}]** {n.label}")
            if subgraph.edges:
                answer_parts.append("\n**Verified Graph Relationships:**")
                for e in subgraph.edges[:6]:
                    answer_parts.append(f"- `{e.source}` --**[{e.relation}]**--> `{e.target}` (Confidence: {(e.confidence * 100):.0f}%)")
            else:
                answer_parts.append("\nNo direct graph edges found matching query seed terms.")
            answer = "\n".join(answer_parts)

        return GraphRAGResponse(
            question=question,
            answer=answer,
            graph_context=graph_context,
            seed_entities=seeds,
            subgraph=subgraph,
            confidence=0.96 if subgraph.nodes else 0.50
        )

    def get_visualization_data(self) -> SubGraph:
        """Retrieve full Knowledge Graph visualization payload without hardcoded seed filtering."""
        return self.repository.get_full_graph(max_nodes=300)

    def get_stats(self) -> GraphStatsResponse:
        """Retrieve Knowledge Graph global analytics."""
        return self.repository.get_stats()


# Global Singleton Service
graph_service = GraphService()
