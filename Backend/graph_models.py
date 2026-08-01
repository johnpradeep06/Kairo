"""
graph_models.py
===============
Enterprise Knowledge Graph Pydantic v2 Models for Kairo Compliance RAG.

Defines the Compliance Ontology (Entity Types & Relationship Types),
Entity with UUID, canonical name, aliases, provenance metadata,
Relationship with confidence, validation status, provenance,
and API schemas for Graph RAG and Neo4j visualizations.
"""

from enum import Enum
from typing import List, Optional, Union, Dict, Any
from uuid import uuid4
from pydantic import BaseModel, Field, ConfigDict


# =========================================================
# COMPLIANCE ONTOLOGY DEFINITIONS
# =========================================================

class EntityType(str, Enum):
    REGULATION = "Regulation"
    POLICY = "Policy"
    REQUIREMENT = "Requirement"
    CONTROL = "Control"
    RISK = "Risk"
    EVIDENCE = "Evidence"
    DEPARTMENT = "Department"
    EMPLOYEE = "Employee"
    VENDOR = "Vendor"
    ASSET = "Asset"
    SYSTEM = "System"
    PROCEDURE = "Procedure"
    AUDIT = "Audit"
    DOCUMENT = "Document"


class RelationshipType(str, Enum):
    IMPLEMENTS = "IMPLEMENTS"
    SATISFIES = "SATISFIES"
    MITIGATES = "MITIGATES"
    OWNS = "OWNS"
    REFERENCES = "REFERENCES"
    AUDITS = "AUDITS"
    DEPENDS_ON = "DEPENDS_ON"
    GENERATED_BY = "GENERATED_BY"
    VIOLATES = "VIOLATES"
    RELATED_TO = "RELATED_TO"
    GOVERNS = "GOVERNS"
    PROTECTS = "PROTECTS"


# =========================================================
# CORE DOMAIN MODELS WITH PROVENANCE
# =========================================================

class ProvenanceInfo(BaseModel):
    """Preserves origin details of extracted entities and relationships."""
    document_id: Union[str, int] = Field(..., description="Unique ID of the parent document")
    page_number: Optional[int] = Field(None, description="1-indexed page number of source text")
    chunk_id: Union[str, int] = Field(..., description="Unique chunk ID or index in vector store")
    source_text: str = Field(..., description="Raw text snippet originating the entity/relation")

    model_config = ConfigDict(extra="ignore")


class Entity(BaseModel):
    """Compliance Knowledge Graph Node."""
    id: str = Field(default_factory=lambda: str(uuid4()), description="Unique Entity UUID")
    canonical_name: str = Field(..., description="Canonical standard display name")
    aliases: List[str] = Field(default_factory=list, description="Alternative names/variants for entity resolution")
    entity_type: EntityType = Field(..., description="Ontology category of entity")
    provenance: List[ProvenanceInfo] = Field(default_factory=list, description="Traceability provenance records")

    model_config = ConfigDict(extra="ignore")


class Relationship(BaseModel):
    """Compliance Knowledge Graph Edge."""
    source: str = Field(..., description="Source entity canonical name or UUID")
    target: str = Field(..., description="Target entity canonical name or UUID")
    relation: RelationshipType = Field(..., description="Ontology relationship type")
    confidence: float = Field(default=0.95, ge=0.0, le=1.0, description="Extraction confidence score")
    extraction_method: str = Field(default="llm_structured_extraction", description="Method used to extract relationship")
    validated: bool = Field(default=True, description="Validation state of relationship")
    provenance: List[ProvenanceInfo] = Field(default_factory=list, description="Traceability provenance records")

    model_config = ConfigDict(extra="ignore")


class ExtractionResult(BaseModel):
    """Output structure from LLM structured extraction."""
    entities: List[Entity] = Field(default_factory=list)
    relationships: List[Relationship] = Field(default_factory=list)

    model_config = ConfigDict(extra="ignore")


# =========================================================
# API & GRAPH RAG PAYLOAD MODELS
# =========================================================

class GraphNode(BaseModel):
    id: str
    label: str
    type: str
    aliases: List[str] = Field(default_factory=list)
    document_count: int = 1


class GraphEdge(BaseModel):
    id: str
    source: str
    target: str
    relation: str
    confidence: float
    document_id: Optional[Union[str, int]] = None


class SubGraph(BaseModel):
    nodes: List[GraphNode] = Field(default_factory=list)
    edges: List[GraphEdge] = Field(default_factory=list)


class GraphRAGQuery(BaseModel):
    question: str = Field(..., description="User compliance question")
    top_k: int = Field(default=5, ge=1, le=20, description="Max seed entities to match")
    depth: int = Field(default=2, ge=1, le=4, description="Subgraph traversal depth")


class GraphRAGResponse(BaseModel):
    question: str
    answer: str
    graph_context: str
    seed_entities: List[str]
    subgraph: SubGraph
    confidence: float


class GraphStatsResponse(BaseModel):
    total_nodes: int
    total_relationships: int
    entity_type_counts: Dict[str, int]
    relationship_type_counts: Dict[str, int]
    documents_indexed: int
