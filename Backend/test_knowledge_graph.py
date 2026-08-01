"""
test_knowledge_graph.py
================-------
Automated verification test for Kairo Enterprise Knowledge Graph.
Tests Entity Resolution, Pydantic v2 domain models, Neo4j Graph Repository,
LLM structured extraction, and Graph RAG query context generation.
"""

import sys
import os

sys.path.insert(0, os.path.dirname(__file__))

from graph_models import (
    Entity, Relationship, EntityType, RelationshipType,
    ProvenanceInfo, ExtractionResult, GraphRAGQuery
)
from graph_builder import EntityResolver, extract_from_chunk
from graph_repository import graph_repository
from graph_service import graph_service


def test_entity_resolution():
    print("[TEST 1/5] Testing Entity Resolution (Canonicalization & Aliases)...")
    resolver = EntityResolver()

    prov = ProvenanceInfo(document_id="doc_101", page_number=2, chunk_id="doc_101_chunk_0", source_text="ISO 27001 requirement")

    e1 = resolver.resolve_entity("ISO 27001", EntityType.REGULATION, aliases=["ISO-27001"], provenance=prov)
    e2 = resolver.resolve_entity("ISO-27001", EntityType.REGULATION, aliases=["ISO/IEC 27001"], provenance=prov)
    e3 = resolver.resolve_entity("ISO/IEC 27001", EntityType.REGULATION, provenance=prov)

    assert e1.id == e2.id == e3.id, f"Entity resolution failed! IDs: {e1.id}, {e2.id}, {e3.id}"
    print(f"  ✓ Resolved variant names ('ISO 27001', 'ISO-27001', 'ISO/IEC 27001') to single UUID: {e1.id}")
    print(f"  ✓ Consolidated Aliases: {e1.aliases}")
    print("  ✓ PASS")


def test_domain_models():
    print("\n[TEST 2/5] Testing Pydantic v2 Models & Compliance Ontology...")
    prov = ProvenanceInfo(document_id=1, page_number=5, chunk_id="chunk_42", source_text="Sample policy text")
    
    entity = Entity(
        canonical_name="Access Control Policy",
        aliases=["ACP-01"],
        entity_type=EntityType.POLICY,
        provenance=[prov]
    )

    rel = Relationship(
        source=entity.canonical_name,
        target="ISO 27001",
        relation=RelationshipType.SATISFIES,
        confidence=0.98,
        provenance=[prov]
    )

    result = ExtractionResult(entities=[entity], relationships=[rel])
    assert len(result.entities) == 1
    assert result.relationships[0].relation == RelationshipType.SATISFIES
    print(f"  ✓ Validated Entity '{entity.canonical_name}' of type '{entity.entity_type}'")
    print(f"  ✓ Validated Relationship '{rel.source}' --[{rel.relation}]--> '{rel.target}' with confidence {rel.confidence}")
    print("  ✓ PASS")


def test_repository_upsert_and_subgraph():
    print("\n[TEST 3/5] Testing Graph Repository Upsert & Subgraph Retrieval...")
    prov = ProvenanceInfo(document_id="test_doc_99", page_number=1, chunk_id="chunk_0", source_text="Test source text")
    
    e1 = Entity(canonical_name="Multi-Factor Authentication", entity_type=EntityType.CONTROL, provenance=[prov])
    e2 = Entity(canonical_name="Unauthorized Access Risk", entity_type=EntityType.RISK, provenance=[prov])

    rel = Relationship(
        source=e1.canonical_name,
        target=e2.canonical_name,
        relation=RelationshipType.MITIGATES,
        confidence=0.99,
        provenance=[prov]
    )

    result = ExtractionResult(entities=[e1, e2], relationships=[rel])
    nodes_created, edges_created = graph_repository.upsert_extraction_result(result)
    print(f"  ✓ Upserted {nodes_created} nodes and {edges_created} relationships to Graph Store")

    subgraph = graph_repository.get_subgraph_around_seeds(["Multi-Factor Authentication"], depth=2)
    assert len(subgraph.nodes) > 0, "Subgraph should return retrieved nodes"
    print(f"  ✓ Subgraph retrieved {len(subgraph.nodes)} nodes and {len(subgraph.edges)} edges")
    print("  ✓ PASS")


def test_llm_structured_extraction():
    print("\n[TEST 4/5] Testing LLM Structured Extraction & Provenance Preservation...")
    sample_text = (
        "The Access Control Policy (ACP-2024) implements Multi-Factor Authentication (MFA) "
        "to satisfy ISO 27001 requirements and mitigate Unauthorized Access Risk."
    )
    result = extract_from_chunk(
        chunk_text=sample_text,
        document_id="doc_compliance_001",
        chunk_id="doc_compliance_001_chunk_0",
        page_number=1
    )
    print(f"  ✓ Extracted {len(result.entities)} entities and {len(result.relationships)} relationships from OpenRouter LLM")
    for e in result.entities:
        print(f"    - Node: [{e.entity_type.value}] {e.canonical_name} (Aliases: {e.aliases})")
    for r in result.relationships:
        print(f"    - Edge: ({r.source}) --[{r.relation.value}]--> ({r.target})")
    assert len(result.entities) > 0, "LLM extraction should produce entities"
    print("  ✓ PASS")


def test_graph_service_rag():
    print("\n[TEST 5/5] Testing Graph Service RAG Query & Stats...")
    stats = graph_service.get_stats()
    print(f"  ✓ Knowledge Graph total nodes: {stats.total_nodes}")
    print(f"  ✓ Knowledge Graph total relationships: {stats.total_relationships}")
    
    rag_res = graph_service.query_graph_rag("What controls mitigate Unauthorized Access Risk?")
    print(f"  ✓ Generated Graph RAG Answer Preview:\n{rag_res.answer[:200]}...")
    print("  ✓ PASS")


if __name__ == "__main__":
    print("=========================================================")
    print("RUNNING KAIRO KNOWLEDGE GRAPH SYNTHESIS VERIFICATION")
    print("=========================================================\n")
    test_entity_resolution()
    test_domain_models()
    test_repository_upsert_and_subgraph()
    test_llm_structured_extraction()
    test_graph_service_rag()
    print("\n=========================================================")
    print("ALL KNOWLEDGE GRAPH VERIFICATION TESTS PASSED SUCCESSFULLY!")
    print("=========================================================")
