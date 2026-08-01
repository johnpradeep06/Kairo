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
import dataclasses
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
        """Redesigned graph-first retrieval pipeline implementing local entity matching & traversal."""
        # 1. Local Entity Matching
        matched_entities = self.repository.local_match_entities(question)
        seeds = [m["canonical_name"] for m in matched_entities]
        
        subgraph = None
        evidence_context = ""
        citations = []
        is_fallback_vector = False

        if seeds:
            # 2. Graph Traversal (BFS)
            subgraph = self.repository.get_subgraph_around_seeds(seeds, depth=depth, max_nodes=50)
            
            # 3. Vector Retrieval (Chroma chunks for traversed nodes only)
            if subgraph and subgraph.nodes:
                from rag_pipeline import retrieve_context_for_graph_nodes
                evidence_context, citations, _ = retrieve_context_for_graph_nodes(subgraph.nodes)
        
        # If no seeds matched or no vector chunks found, fallback to vector search
        if not evidence_context:
            from rag_pipeline import retrieve_context
            evidence_context, citations, _ = retrieve_context(question)
            is_fallback_vector = True
            if not subgraph:
                subgraph = SubGraph()

        # Compile Graph Facts context text
        context_lines: List[str] = ["=== ENTITIES IN GRAPH ==="]
        for node in subgraph.nodes:
            alias_str = f" (aka {', '.join(node.aliases)})" if node.aliases else ""
            context_lines.append(f"- [{node.type}] {node.label}{alias_str}")

        context_lines.append("\n=== COMPLIANCE RELATIONSHIPS & EVIDENCE ===")
        for edge in subgraph.edges:
            context_lines.append(
                f"- ({edge.source}) --[{edge.relation}]--> ({edge.target}) (Confidence: {edge.confidence:.2f})"
            )
        graph_context = "\n".join(context_lines)

        # 4. Hybrid Prompt Construction
        hybrid_prompt = f"""You are Kairo, a knowledgeable, concise, and professional Enterprise Compliance Copilot.
Answer the User Question using only the provided compliance facts from the Knowledge Graph and Supporting Document Chunks.

=== USER QUESTION ===
{question}

=== COMPLIANCE KNOWLEDGE GRAPH FACTS ===
{graph_context}

=== SUPPORTING DOCUMENT EVIDENCE CHUNKS ===
{evidence_context}

=== INSTRUCTIONS ===
1. Only answer using the Graph Facts and Supporting Document Chunks provided above.
2. Never invent entities, relationships, or facts not mentioned in the contexts.
3. Never use external knowledge or repository files.
4. If the required information does not exist in the contexts, explicitly state: "No supporting evidence found in uploaded documents."
5. Cite the supporting documents using their citation markers, e.g. [1], [2], where appropriate.

Answer:"""

        # 5. Single LLM Call (Inference)
        import time
        start_llm_time = time.time()
        from rag_pipeline import llm
        try:
            from langchain_core.prompts import PromptTemplate
            from langchain_core.output_parsers import StrOutputParser
            chain = PromptTemplate.from_template("{prompt}") | llm | StrOutputParser()
            answer = chain.invoke({"prompt": hybrid_prompt})
        except Exception as err:
            logger.error("[graph_service] Redesigned Graph RAG LLM call failed: %s", err)
            answer = "No supporting evidence found in uploaded documents due to service unavailability."
        llm_latency = round(time.time() - start_llm_time, 2)

        # Compile dynamic confidence score
        num_nodes = len(subgraph.nodes)
        num_edges = len(subgraph.edges)
        seed_coverage = 0.0
        density_factor = 0.0
        avg_rel_confidence = 0.0
        if num_nodes == 0:
            dyn_confidence = 0.0
        else:
            matched_seeds = 0
            nodes_labels_lower = {n.label.lower() for n in subgraph.nodes}
            for s in seeds:
                s_clean = s.lower()
                if any(s_clean in l or l in s_clean for l in nodes_labels_lower):
                    matched_seeds += 1
            seed_coverage = (matched_seeds / len(seeds)) if seeds else 0.0
            subgraph_density = (num_edges / num_nodes) if num_nodes > 0 else 0.0
            density_factor = min(subgraph_density / 2.0, 1.0)
            avg_rel_confidence = sum(e.confidence for e in subgraph.edges) / num_edges if num_edges > 0 else 0.0
            
            if num_edges == 0:
                dyn_confidence = 0.3 * seed_coverage + 0.2
            else:
                dyn_confidence = (0.3 * seed_coverage) + (0.3 * density_factor) + (0.4 * avg_rel_confidence)
            dyn_confidence = max(min(dyn_confidence, 1.0), 0.05)

        # 6. Graph Debug Panel Payload
        import re
        norm_query = question.lower().strip()
        norm_query = re.sub(r'[^\w\s-]', '', norm_query)
        
        matched_aliases = []
        for m in matched_entities:
            if "matched_by" in m and m["matched_by"].startswith("alias:"):
                matched_aliases.append(m["matched_by"].replace("alias: ", ""))

        confidence_breakdown = (
            f"Seed Coverage: {(seed_coverage * 100):.1f}%, "
            f"Density Factor: {(density_factor * 100):.1f}%, "
            f"Avg Rel Conf: {(avg_rel_confidence * 100):.1f}%"
        )

        debug_info = {
            "normalized_query": norm_query,
            "matched_aliases": matched_aliases,
            "canonical_entities": [m["canonical_name"] for m in matched_entities],
            "seed_nodes": seeds,
            "traversal_order": seeds + [n.label for n in subgraph.nodes if n.label not in seeds] if subgraph else [],
            "hop_count": depth,
            "visited_nodes": [n.label for n in subgraph.nodes] if subgraph else [],
            "visited_relationships": [f"{e.source} --[{e.relation}]--> {e.target}" for e in subgraph.edges] if subgraph else [],
            "retrieved_chunk_ids": list(set([n.chunk_id for n in subgraph.nodes if n.chunk_id])) if subgraph else [],
            "retrieved_documents": list(set([n.document_id for n in subgraph.nodes if n.document_id])) if subgraph else [],
            "prompt_length": len(hybrid_prompt),
            "llm_latency": f"{llm_latency:.2f}s",
            "confidence_breakdown": confidence_breakdown,
            "number_of_openrouter_calls": 1,
            "user_query": question,
            "final_llm_request": hybrid_prompt,
            "supporting_chunks": [dataclasses.asdict(c) for c in citations]
        }

        return GraphRAGResponse(
            question=question,
            answer=answer,
            graph_context=graph_context,
            seed_entities=seeds,
            subgraph=subgraph,
            confidence=dyn_confidence,
            debug_info=debug_info
        )

    def get_visualization_data(self) -> SubGraph:
        """Retrieve full Knowledge Graph visualization payload without hardcoded seed filtering."""
        return self.repository.get_full_graph(max_nodes=300)

    def get_stats(self) -> GraphStatsResponse:
        """Retrieve Knowledge Graph global analytics."""
        return self.repository.get_stats()


# Global Singleton Service
graph_service = GraphService()
