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

        # ponytail: free-tier OpenRouter models throttle/empty-reply under
        # concurrent load (observed 4/5 chunks silently failing at workers=5,
        # forcing the low-quality heuristic fallback and graph clutter).
        # Tune via env for paid/higher-limit models.
        graph_workers = int(os.getenv("GRAPH_EXTRACTION_WORKERS", "2"))
        with ThreadPoolExecutor(max_workers=graph_workers) as executor:
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

    def purge_graph(self) -> Dict[str, int]:
        """Drop the entire knowledge graph (see graph_repository.purge_all)."""
        result = self.repository.purge_all()
        logger.info("[graph_service] purged knowledge graph: %s", result)
        return result

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
        """Invokes the unified enterprise_query_service to run Graph-first query routing."""
        res = enterprise_query_service.query(question, force_graph=True, depth=depth)
        return GraphRAGResponse(
            question=res.question,
            answer=res.answer,
            graph_context=res.graph_context,
            seed_entities=res.seed_entities,
            subgraph=res.subgraph,
            confidence=res.confidence,
            debug_info=res.debug_info,
            evidence_context=res.evidence_context,
        )

    def _post_process_subgraph(self, subgraph: SubGraph) -> SubGraph:
        """Deduplicates relationships (merging properties) and maps edge endpoints to node UUIDs."""
        if not subgraph:
            return SubGraph()
            
        # 1. Deduplicate identical relationships (same source, relation, target canonical names)
        grouped_edges = {}
        for edge in subgraph.edges:
            key = (edge.source.strip(), edge.relation.strip(), edge.target.strip())
            if key not in grouped_edges:
                grouped_edges[key] = []
            grouped_edges[key].append(edge)
            
        deduplicated_edges = []
        for key, edges in grouped_edges.items():
            if len(edges) == 1:
                deduplicated_edges.append(edges[0])
                continue
                
            base_edge = edges[0]
            chunk_ids = []
            doc_ids = []
            page_numbers = []
            source_texts = []
            confidences = []
            
            for e in edges:
                if e.chunk_id:
                    for cid in str(e.chunk_id).split(","):
                        cid_clean = cid.strip()
                        if cid_clean and cid_clean not in chunk_ids:
                            chunk_ids.append(cid_clean)
                if e.document_id:
                    for did in str(e.document_id).split(","):
                        did_clean = did.strip()
                        if did_clean and did_clean not in doc_ids:
                            doc_ids.append(did_clean)
                if e.page_number is not None:
                    if e.page_number not in page_numbers:
                        page_numbers.append(e.page_number)
                if e.source_text:
                    st_clean = e.source_text.strip()
                    if st_clean and st_clean not in source_texts:
                        source_texts.append(st_clean)
                confidences.append(e.confidence)
                
            base_edge.chunk_id = ", ".join(chunk_ids) if chunk_ids else None
            base_edge.document_id = ", ".join(doc_ids) if doc_ids else None
            base_edge.page_number = page_numbers[0] if page_numbers else None
            base_edge.source_text = " | ".join(source_texts) if source_texts else None
            base_edge.confidence = max(confidences) if confidences else 0.95
            
            deduplicated_edges.append(base_edge)

        # 2. Build mapping {canonical_entity_name -> node_uuid}
        name_to_uuid = {}
        name_to_uuid_lower = {}
        for node in subgraph.nodes:
            name_to_uuid[node.label] = node.id
            name_to_uuid_lower[node.label.lower().strip()] = node.id
            
        # 3. Map edge sources/targets to UUIDs, inserting placeholders for missing nodes
        from uuid import uuid4
        from graph_models import GraphNode
        for edge in deduplicated_edges:
            src_uuid = name_to_uuid.get(edge.source) or name_to_uuid_lower.get(edge.source.lower().strip())
            tgt_uuid = name_to_uuid.get(edge.target) or name_to_uuid_lower.get(edge.target.lower().strip())
            
            if not src_uuid:
                src_uuid = str(uuid4())
                new_node = GraphNode(id=src_uuid, label=edge.source, type="Requirement")
                subgraph.nodes.append(new_node)
                name_to_uuid[edge.source] = src_uuid
                name_to_uuid_lower[edge.source.lower().strip()] = src_uuid
                
            if not tgt_uuid:
                tgt_uuid = str(uuid4())
                new_node = GraphNode(id=tgt_uuid, label=edge.target, type="Requirement")
                subgraph.nodes.append(new_node)
                name_to_uuid[edge.target] = tgt_uuid
                name_to_uuid_lower[edge.target.lower().strip()] = tgt_uuid
                
            edge.source = src_uuid
            edge.target = tgt_uuid
            
        subgraph.edges = deduplicated_edges
        return subgraph

    def get_visualization_data(self) -> SubGraph:
        """Retrieve full Knowledge Graph visualization payload without hardcoded seed filtering."""
        subgraph = self.repository.get_full_graph(max_nodes=300)
        return self._post_process_subgraph(subgraph)

    def get_stats(self) -> GraphStatsResponse:
        """Retrieve Knowledge Graph global analytics."""
        return self.repository.get_stats()


# Global Singleton Service
graph_service = GraphService()


# =========================================================
# UNIFIED ENTERPRISE QUERY SERVICE
# =========================================================

@dataclasses.dataclass
class EnterpriseQueryResult:
    question: str
    answer: str
    graph_context: str
    seed_entities: List[str]
    subgraph: SubGraph
    citations: List[Any]
    confidence: float
    source_type: str
    debug_info: Dict[str, Any]
    # Raw retrieved text the answer was actually grounded in. Distinct from
    # graph_context, which is only populated on the graph-traversal path — a
    # vector-path answer has real evidence but an empty graph_context.
    evidence_context: str = ""

    def to_dict(self) -> dict:
        return {
            "answer": self.answer,
            "citations": [dataclasses.asdict(c) for c in self.citations],
            "confidence": round(self.confidence, 3),
            "source_type": self.source_type,
            "debug_info": self.debug_info
        }

class EnterpriseQueryService:
    def __init__(self, repository):
        self.repository = repository

    def query(self, question: str, force_graph: bool = False, history: list = None, depth: int = 2) -> EnterpriseQueryResult:
        import re
        import time
        from graph_models import SubGraph
        from rag_pipeline import wants_web_search, format_history, exa_search_fallback, clean_answer, _cited_indices
        
        # 1. Query normalization
        norm_query = question.lower().strip()
        norm_query = re.sub(r'[^\w\s-]', '', norm_query)
        norm_query = re.sub(r'[\U00010000-\U0010ffff]', '', norm_query) # Strip emojis from query

        # 2. Intent classification
        intent = "vector"
        explicit_web = wants_web_search(question)
        is_latest = any(word in norm_query.split() for word in ["current", "latest", "today", "now", "recent", "newest"])
        
        graph_keywords = [
            "who owns", "which controls", "what risks", "which regulations", 
            "connected to", "related to", "relationship", "how is", 
            "depend on", "dependency", "mitigate", "protect", "affect", "apply to"
        ]
        has_graph_keyword = any(kw in norm_query for kw in graph_keywords)
        matched_entities = self.repository.local_match_entities(question)
        seeds = [m["canonical_name"] for m in matched_entities]

        if explicit_web or is_latest:
            intent = "web"
        elif force_graph or has_graph_keyword or len(matched_entities) > 0:
            intent = "graph"
        else:
            vector_keywords = ["summarize", "summary", "explain", "explanation", "what information", "tell me about", "document"]
            if any(vk in norm_query for vk in vector_keywords):
                intent = "vector"

        # 3. Context retrieval
        subgraph = SubGraph()
        graph_context = ""
        evidence_context = ""
        citations = []
        source_type = "none"

        if intent == "web":
            try:
                answer, citations = exa_search_fallback(question)
                answer = re.sub(r'[\U00010000-\U0010ffff]', '', answer) # Strip emojis from web answer
                return EnterpriseQueryResult(
                    question=question,
                    answer=answer,
                    graph_context="",
                    seed_entities=[],
                    subgraph=subgraph,
                    citations=citations,
                    confidence=0.35 if citations else 0.2,
                    source_type="web",
                    debug_info={
                        "normalized_query": norm_query,
                        "matched_aliases": [],
                        "canonical_entities": [],
                        "seed_nodes": [],
                        "traversal_order": [],
                        "hop_count": 0,
                        "visited_nodes": [],
                        "visited_relationships": [],
                        "retrieved_chunk_ids": [],
                        "retrieved_documents": [],
                        "prompt_length": 0,
                        "llm_latency": "0.00s",
                        "confidence_breakdown": "Web search",
                        "number_of_openrouter_calls": 1
                    }
                )
            except Exception as e:
                logger.error("Web search fallback failed: %s", e)
                evidence_context = ""

        elif intent == "graph":
            if seeds:
                subgraph = self.repository.get_subgraph_around_seeds(seeds, depth=depth, max_nodes=50)
                from graph_service import graph_service
                subgraph = graph_service._post_process_subgraph(subgraph)
                
                if subgraph and subgraph.nodes:
                    from rag_pipeline import retrieve_context_for_graph_nodes
                    evidence_context, citations, _ = retrieve_context_for_graph_nodes(subgraph.nodes)
                    source_type = "hybrid"

                    # Compile Graph Facts context text using canonical names for the LLM
                    context_lines = ["=== ENTITIES IN GRAPH ==="]
                    for node in subgraph.nodes:
                        alias_str = f" (aka {', '.join(node.aliases)})" if node.aliases else ""
                        context_lines.append(f"- [{node.type}] {node.label}{alias_str}")
                    context_lines.append("\n=== COMPLIANCE RELATIONSHIPS & EVIDENCE ===")
                    
                    uuid_to_label = {node.id: node.label for node in subgraph.nodes}
                    for edge in subgraph.edges:
                        src_label = uuid_to_label.get(edge.source, edge.source)
                        tgt_label = uuid_to_label.get(edge.target, edge.target)
                        context_lines.append(
                            f"- ({src_label}) --[{edge.relation}]--> ({tgt_label}) (Confidence: {edge.confidence:.2f})"
                        )
                    graph_context = "\n".join(context_lines)

        # Fallback to vector search if graph returned no evidence
        if (intent == "vector" or (intent == "graph" and not evidence_context)) and not evidence_context:
            from rag_pipeline import retrieve_context
            evidence_context, citations, highest_score = retrieve_context(question)
            source_type = "documents"

        # 4. Check if we have any evidence
        if not evidence_context:
            return EnterpriseQueryResult(
                question=question,
                answer="I could not find sufficient evidence in the uploaded enterprise knowledge base. Would you like me to search external sources?",
                graph_context="",
                seed_entities=[],
                subgraph=SubGraph(),
                citations=[],
                confidence=0.0,
                source_type="none",
                debug_info={
                    "normalized_query": norm_query,
                    "matched_aliases": [],
                    "canonical_entities": [],
                    "seed_nodes": [],
                    "traversal_order": [],
                    "hop_count": 0,
                    "visited_nodes": [],
                    "visited_relationships": [],
                    "retrieved_chunk_ids": [],
                    "retrieved_documents": [],
                    "prompt_length": 0,
                    "llm_latency": "0.00s",
                    "confidence_breakdown": "No enterprise evidence found",
                    "number_of_openrouter_calls": 0
                }
            )

        # 5. Merge retrieved evidence and run LLM
        context_str = ""
        if graph_context:
            context_str += f"{graph_context}\n\n"
        if evidence_context:
            context_str += f"=== SUPPORTING DOCUMENT EVIDENCE CHUNKS ===\n{evidence_context}"

        hybrid_prompt = f"""You are Kairo, a knowledgeable, concise, and professional Enterprise Compliance Copilot.
Answer the User Question using only the provided compliance facts from the Knowledge Graph and Supporting Document Chunks.

=== USER QUESTION ===
{question}

=== COMPLIANCE FACTS & SUPPORTING EVIDENCE ===
{context_str}

=== INSTRUCTIONS ===
1. Only answer using the Compliance Facts and Supporting Document Chunks provided above.
2. Never invent entities, relationships, or facts not mentioned in the contexts.
3. Never use external knowledge or repository files.
4. If the required information does not exist in the contexts, explicitly state: "No supporting evidence found in uploaded documents."
5. Cite the supporting documents using their citation markers, e.g. [1], [2], where appropriate.
6. Absolutely do NOT use any emojis in your response.

Answer:"""

        start_llm_time = time.time()
        from rag_pipeline import llm
        try:
            from langchain_core.prompts import PromptTemplate
            from langchain_core.output_parsers import StrOutputParser
            chain = PromptTemplate.from_template("{prompt}") | llm | StrOutputParser()
            answer = chain.invoke({"prompt": hybrid_prompt})
        except Exception as err:
            logger.error("[enterprise_query_service] LLM call failed: %s", err)
            answer = "I could not find sufficient evidence in the uploaded enterprise knowledge base. Would you like me to search external sources?"
        llm_latency = round(time.time() - start_llm_time, 2)

        # 6. Hallucination audit / refuse handling
        answer = clean_answer(answer)
        answer = re.sub(r'[\U00010000-\U0010ffff]', '', answer) # Strip emojis

        # Grounding gate: strip statements not supported by the graph facts or
        # supporting evidence chunks before returning. Fail-open.
        from rag_pipeline import _FALLBACK_TRIGGERS, assess_grounding
        answer, graph_grounding_report = assess_grounding(answer, context_str, strip=True)

        answer_lower = answer.lower()
        refused = any(trigger in answer_lower for trigger in _FALLBACK_TRIGGERS) or "no supporting evidence" in answer_lower

        if refused:
            return EnterpriseQueryResult(
                question=question,
                answer="I could not find sufficient evidence in the uploaded enterprise knowledge base. Would you like me to search external sources?",
                graph_context="",
                seed_entities=[],
                subgraph=SubGraph(),
                citations=[],
                confidence=0.0,
                source_type="none",
                debug_info={
                    "normalized_query": norm_query,
                    "matched_aliases": [],
                    "canonical_entities": [],
                    "seed_nodes": [],
                    "traversal_order": [],
                    "hop_count": 0,
                    "visited_nodes": [],
                    "visited_relationships": [],
                    "retrieved_chunk_ids": [],
                    "retrieved_documents": [],
                    "prompt_length": len(hybrid_prompt),
                    "llm_latency": f"{llm_latency:.2f}s",
                    "confidence_breakdown": "LLM refused to answer",
                    "number_of_openrouter_calls": 1
                }
            )

        # 7. Citations & confidence
        used_indices = _cited_indices(answer)
        final_citations = [c for c in citations if c.index in used_indices]

        # The model does not reliably emit [n] markers even when it answered
        # purely from the retrieved context. Discarding the citations in that
        # case zeroed the confidence score AND left the verifier with no
        # evidence, so a correct, fully grounded answer scored 0% and audited
        # as 100% hallucinated. Fall back to the retrieved set instead.
        if not final_citations and citations:
            final_citations = list(citations)

        # Calculate confidence
        num_nodes = len(subgraph.nodes) if subgraph else 0
        num_edges = len(subgraph.edges) if subgraph else 0
        seed_coverage = 0.0
        density_factor = 0.0
        avg_rel_confidence = 0.0
        if num_nodes > 0:
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
            confidence = max(min(dyn_confidence, 1.0), 0.05)
        else:
            from rag_pipeline import _confidence_from
            highest_score = max([c.score for c in final_citations]) if final_citations else 0.0
            confidence = _confidence_from(highest_score, final_citations)

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
            "supporting_chunks": [dataclasses.asdict(c) for c in final_citations],
            "grounding": graph_grounding_report,
        }

        return EnterpriseQueryResult(
            question=question,
            answer=answer,
            graph_context=graph_context,
            seed_entities=seeds,
            subgraph=subgraph,
            citations=final_citations,
            confidence=confidence,
            source_type=source_type,
            debug_info=debug_info,
            evidence_context=evidence_context or "",
        )

enterprise_query_service = EnterpriseQueryService(graph_repository)
