"""
graph_builder.py
================
Extraction and Entity Resolution Engine for Kairo Knowledge Graph.

Uses OpenRouter LLM structured JSON output to extract Compliance entities
and relationships from text chunks, applies string normalization and entity
resolution (merging variants like 'ISO 27001', 'ISO-27001', 'ISO/IEC 27001'),
and attaches full provenance metadata.
"""

import json
import re
import logging
from typing import List, Dict, Any, Tuple, Union, Optional
from uuid import uuid4

from langchain_core.prompts import ChatPromptTemplate
from langchain_core.output_parsers import StrOutputParser

from graph_models import (
    Entity, Relationship, EntityType, RelationshipType,
    ProvenanceInfo, ExtractionResult
)
from rag_pipeline import llm

logger = logging.getLogger(__name__)


# =========================================================
# ENTITY RESOLUTION ENGINE
# =========================================================

class EntityResolver:
    """Canonicalizes entity names and merges duplicate entity variants."""

    def __init__(self):
        # Maps normalized string key -> canonical Entity UUID
        self.name_to_id: Dict[str, str] = {}
        # Maps entity UUID -> canonical Entity object
        self.entities_by_id: Dict[str, Entity] = {}

    @staticmethod
    def normalize_name(name: str) -> str:
        """Normalize string by lowercasing, stripping punctuation, and removing excess whitespace."""
        if not name:
            return ""
        # Convert to lower case
        s = name.lower().strip()
        # Normalize common variations e.g., ISO/IEC -> iso, remove dashes
        s = re.sub(r'[\-/_\.:]', ' ', s)
        # Collapse multiple spaces
        s = re.sub(r'\s+', ' ', s)
        return s.strip()

    def resolve_entity(
        self,
        candidate_name: str,
        entity_type: EntityType,
        aliases: Optional[List[str]] = None,
        provenance: Optional[ProvenanceInfo] = None
    ) -> Entity:
        """Lookup or create a canonical entity, merging aliases and provenance."""
        aliases = aliases or []
        norm_candidate = self.normalize_name(candidate_name)

        # Check if candidate name or any alias matches an existing entity
        matched_id = self.name_to_id.get(norm_candidate)
        if not matched_id:
            for alias in aliases:
                norm_alias = self.normalize_name(alias)
                if norm_alias in self.name_to_id:
                    matched_id = self.name_to_id[norm_alias]
                    break

        if matched_id and matched_id in self.entities_by_id:
            # Merge into existing entity
            entity = self.entities_by_id[matched_id]
            # Add candidate_name to aliases if it's different from canonical_name
            if candidate_name != entity.canonical_name and candidate_name not in entity.aliases:
                entity.aliases.append(candidate_name)
            for alias in aliases:
                if alias != entity.canonical_name and alias not in entity.aliases:
                    entity.aliases.append(alias)
            if provenance:
                entity.provenance.append(provenance)
            # Update lookup table for all new aliases
            self.name_to_id[norm_candidate] = entity.id
            for alias in aliases:
                self.name_to_id[self.normalize_name(alias)] = entity.id
            return entity

        # Create new canonical entity
        new_entity = Entity(
            id=str(uuid4()),
            canonical_name=candidate_name,
            aliases=[a for a in aliases if a != candidate_name],
            entity_type=entity_type,
            provenance=[provenance] if provenance else []
        )
        self.entities_by_id[new_entity.id] = new_entity
        self.name_to_id[norm_candidate] = new_entity.id
        for alias in aliases:
            self.name_to_id[self.normalize_name(alias)] = new_entity.id

        return new_entity


# =========================================================
# GRAPH EXTRACTION ENGINE
# =========================================================

EXTRACTION_PROMPT = ChatPromptTemplate.from_template(
"""You are an expert Compliance & Security Knowledge Graph Architect.
Extract entities and relationships from the provided text chunk using the compliance ontology below.

ENTITIES MUST BE CATEGORIZED AS ONE OF:
- Regulation (e.g. ISO 27001, SOC 2, HIPAA, GDPR, NIS2)
- Policy (e.g. Access Control Policy, Data Retention Policy)
- Requirement (e.g. Password Complexity, Encryption at Rest)
- Control (e.g. Multi-Factor Authentication, Firewall Rule)
- Risk (e.g. Unauthorized Access, Data Leakage)
- Evidence (e.g. Audit Log, Vulnerability Scan Report)
- Department (e.g. IT Security, Legal, HR)
- Employee (e.g. Chief Information Security Officer)
- Vendor (e.g. AWS, Cloudflare, OpenRouter)
- Asset (e.g. Customer Database, Source Code)
- System (e.g. Production Cluster, Auth Gateway)
- Procedure (e.g. Incident Response Plan, Password Reset)
- Audit (e.g. Q3 Penetration Test, Annual ISO Audit)
- Document (e.g. System Security Plan v2.pdf)

RELATIONSHIPS MUST BE ONE OF:
- IMPLEMENTS
- SATISFIES
- MITIGATES
- OWNS
- REFERENCES
- AUDITS
- DEPENDS_ON
- GENERATED_BY
- VIOLATES
- RELATED_TO

OUTPUT STRICT VALID JSON matching this format:
{{
  "entities": [
    {{
      "name": "ISO 27001",
      "aliases": ["ISO-27001", "ISO/IEC 27001"],
      "type": "Regulation"
    }}
  ],
  "relationships": [
    {{
      "source": "Access Control Policy",
      "target": "ISO 27001",
      "relation": "SATISFIES",
      "confidence": 0.98
    }}
  ]
}}

TEXT CHUNK TO EXTRACT FROM:
\"\"\"
{chunk_text}
\"\"\"
CRITICAL: Output ONLY valid raw JSON. Do NOT include reasoning, preambles, or markdown formatting.
"""
)


def _clean_json_response(raw_text: str) -> str:
    """Strip markdown backticks, preambles, or extra text to isolate raw JSON payload."""
    cleaned = raw_text.strip()
    
    # Try finding markdown codeblock
    match = re.search(r'```(?:json)?\s*(\{[\s\S]*?\})\s*```', cleaned, re.IGNORECASE)
    if match:
        cleaned = match.group(1).strip()
    else:
        # Fallback to finding outermost JSON object braces
        match_outer = re.search(r'(\{[\s\S]*\})', cleaned)
        if match_outer:
            cleaned = match_outer.group(1).strip()

    # Clean trailing commas before closing brackets/braces
    cleaned = re.sub(r',\s*([\}\]])', r'\1', cleaned)
    return cleaned


def is_entity_grounded_in_chunk(candidate_name: str, chunk_text: str, entity_type: EntityType) -> bool:
    """Validate that candidate entity text exists explicitly within original chunk source text."""
    if entity_type == EntityType.DOCUMENT:
        return True

    text_lower = chunk_text.lower()
    candidate_lower = candidate_name.lower().strip()

    # Requirement formatted candidates: "Requirement (Chunk X.Y): <phrase>"
    if ":" in candidate_lower and "chunk" in candidate_lower:
        phrase_part = candidate_lower.split(":", 1)[1].strip()
        if phrase_part and phrase_part in text_lower:
            return True

    # Direct exact substring match
    if candidate_lower in text_lower:
        return True

    # Sub-token match for multi-word candidate entities
    words = [w for w in re.findall(r'\b[a-zA-Z0-9_-]{3,}\b', candidate_lower)]
    if len(words) >= 2 and all(w in text_lower for w in words):
        return True

    return False


def extract_from_chunk(
    chunk_text: str,
    document_id: Union[str, int],
    chunk_id: Union[str, int],
    page_number: Optional[int] = None,
    resolver: Optional[EntityResolver] = None
) -> ExtractionResult:
    """Extract entities & relationships from a single chunk, applying entity resolution & provenance."""
    if not chunk_text or not chunk_text.strip():
        return ExtractionResult()

    if resolver is None:
        resolver = EntityResolver()

    provenance = ProvenanceInfo(
        document_id=document_id,
        page_number=page_number,
        chunk_id=chunk_id,
        source_text=chunk_text[:500]  # Store snippet for context
    )

    chain = EXTRACTION_PROMPT | llm | StrOutputParser()

    try:
        raw_output = chain.invoke({"chunk_text": chunk_text})
        cleaned_json = _clean_json_response(raw_output)
        try:
            data = json.loads(cleaned_json)
        except Exception:
            try:
                from json_repair import repair_json
                repaired = repair_json(cleaned_json)
                data = json.loads(repaired)
            except Exception as inner_err:
                logger.warning("[graph_builder] JSON repair failed for chunk %s: %s. Using fallback compliance extraction.", chunk_id, inner_err)
                return fallback_heuristic_extraction(chunk_text, resolver, provenance)
    except Exception as err:
        logger.warning("[graph_builder] LLM Extraction chain failed for chunk %s: %s. Using fallback compliance extraction.", chunk_id, err)
        return fallback_heuristic_extraction(chunk_text, resolver, provenance)

    if isinstance(data, list):
        if len(data) > 0 and isinstance(data[0], dict) and ("entities" in data[0] or "relationships" in data[0]):
            data = data[0]
        else:
            data = {"entities": data, "relationships": []}

    raw_entities = data.get("entities", []) if isinstance(data, dict) else []
    raw_relations = data.get("relationships", []) if isinstance(data, dict) else []

    extracted_entities: List[Entity] = []
    name_to_canonical: Dict[str, str] = {}

    valid_entity_types = {e.value for e in EntityType}
    valid_rel_types = {r.value for r in RelationshipType}

    # Process Entities & Perform Entity Resolution
    for item in raw_entities:
        if isinstance(item, str):
            name = item.strip()
            aliases = []
            etype = EntityType.REQUIREMENT
        elif isinstance(item, dict):
            name = str(item.get("name", item.get("canonical_name", ""))).strip()
            aliases = item.get("aliases", []) if isinstance(item.get("aliases"), list) else []

        if etype_str not in valid_entity_types:
            etype_str = "Document" if "document" in name.lower() else "Requirement"

        etype = EntityType(etype_str)

        resolved_entity = resolver.resolve_entity(
            candidate_name=name,
            entity_type=etype,
            aliases=aliases,
            provenance=provenance
        )
        extracted_entities.append(resolved_entity)
        name_to_canonical[name] = resolved_entity.canonical_name
        for alias in aliases:
            name_to_canonical[alias] = resolved_entity.canonical_name

    # Process Relationships
    extracted_relationships: List[Relationship] = []
    for item in raw_relations:
        if isinstance(item, dict):
            src = item.get("source")
            tgt = item.get("target")
            rel_str = item.get("relation")
            conf = float(item.get("confidence", 0.95))
        elif isinstance(item, (list, tuple)) and len(item) >= 3:
            src, rel_str, tgt = str(item[0]), str(item[1]), str(item[2])
            conf = 0.95
        else:
            continue

        if not src or not tgt or not rel_str:
            continue

        # Map to canonical names if resolved
        src_canonical = name_to_canonical.get(src, src)
        tgt_canonical = name_to_canonical.get(tgt, tgt)

        if rel_str not in valid_rel_types:
            rel_str = "RELATED_TO"

        rel_type = RelationshipType(rel_str)

        relationship = Relationship(
            source=src_canonical,
            target=tgt_canonical,
            relation=rel_type,
            confidence=conf,
            extraction_method="llm_structured_extraction",
            validated=True,
            provenance=[provenance]
        )
        extracted_relationships.append(relationship)

    # If LLM extracted no entities or failed, execute deterministic compliance pattern extraction
    if len(extracted_entities) == 0:
        logger.info("[graph_builder] LLM produced 0 entities for chunk %s. Running fallback compliance extraction...", chunk_id)
        return fallback_heuristic_extraction(chunk_text, resolver, provenance)

    return ExtractionResult(
        entities=list(resolver.entities_by_id.values()),
        relationships=extracted_relationships
    )


COMPLIANCE_PATTERNS = [
    (r'\b(ISO[ -]?27001|ISO/IEC[ -]?27001|SOC[ -]?2|HIPAA|GDPR|PCI[ -]?DSS|NIS2)\b', EntityType.REGULATION),
    (r'\b([A-Za-z0-9_-]+ (?:Policy|Standard|Guideline|Framework))\b', EntityType.POLICY),
    (r'\b([A-Za-z0-9_-]+ (?:Control|Firewall|MFA|Multi-Factor Authentication|Encryption|Access Control))\b', EntityType.CONTROL),
    (r'\b([A-Za-z0-9_-]+ (?:Risk|Threat|Vulnerability|Breach))\b', EntityType.RISK),
    (r'\b([A-Za-z0-9_-]+ (?:System|Cluster|Server|Database|Gateway|API))\b', EntityType.SYSTEM),
    (r'\b([A-Za-z0-9_-]+ (?:Requirement|Mandate|Clause))\b', EntityType.REQUIREMENT),
]


def fallback_heuristic_extraction(text: str, resolver: EntityResolver, provenance: ProvenanceInfo) -> ExtractionResult:
    """Fallback extraction to guarantee Knowledge Graph nodes & relationships for every document chunk."""
    found_entities: List[Entity] = []

    # 1. Document Entity
    doc_name = f"Doc_{provenance.document_id}"
    doc_entity = resolver.resolve_entity(
        candidate_name=doc_name,
        entity_type=EntityType.DOCUMENT,
        provenance=provenance
    )
    found_entities.append(doc_entity)

    # 2. Extract Compliance Pattern Entities
    for pattern, etype in COMPLIANCE_PATTERNS:
        matches = re.findall(pattern, text, re.IGNORECASE)
        for m in matches:
            name = m.strip() if isinstance(m, str) else m[0].strip()
            if len(name) >= 3 and not name.isdigit():
                if not is_entity_grounded_in_chunk(name, text, etype):
                    logger.warning("[graph_builder] DISCARDED ungrounded candidate '%s' (not found in chunk source text)", name)
                    continue
                e = resolver.resolve_entity(candidate_name=name, entity_type=etype, provenance=provenance)
                found_entities.append(e)

    # 3. Extract Chunk-Specific Requirement Concept Entities
    chunk_idx_str = str(provenance.chunk_id).split("_")[-1] if provenance.chunk_id else "0"
    lines = [s.strip() for s in text.split("\n") if len(s.strip()) > 8 and not s.startswith("#")]
    if not lines:
        lines = [s.strip() for s in text.split(".") if len(s.strip()) > 8]

    for idx_s, sent in enumerate(lines[:3]):
        clean_sent = re.sub(r'[^a-zA-Z0-9\s-]', '', sent).strip()
        phrase = clean_sent[:45].strip()
        if phrase:
            candidate_title = f"Requirement (Chunk {chunk_idx_str}.{idx_s + 1}): {phrase}"
            req_entity = resolver.resolve_entity(
                candidate_name=candidate_title,
                entity_type=EntityType.REQUIREMENT,
                provenance=provenance
            )
            found_entities.append(req_entity)

    # 4. Build Rich Cross-Entity Domain Relationships
    relationships: List[Relationship] = []
    seen_edges = set()

    def add_rel(src: str, tgt: str, rel_type: RelationshipType):
        if src != tgt and (src, tgt) not in seen_edges:
            seen_edges.add((src, tgt))
            relationships.append(Relationship(
                source=src,
                target=tgt,
                relation=rel_type,
                confidence=0.95,
                provenance=[provenance]
            ))

    # Link Doc to extracted entities
    for e in found_entities:
        if e.id != doc_entity.id:
            add_rel(doc_entity.canonical_name, e.canonical_name, RelationshipType.REFERENCES)

    # Cross-link compliance entity categories within chunk
    controls = [e for e in found_entities if e.entity_type == EntityType.CONTROL]
    risks = [e for e in found_entities if e.entity_type == EntityType.RISK]
    policies = [e for e in found_entities if e.entity_type == EntityType.POLICY]
    regulations = [e for e in found_entities if e.entity_type == EntityType.REGULATION]
    systems = [e for e in found_entities if e.entity_type == EntityType.SYSTEM]
    requirements = [e for e in found_entities if e.entity_type == EntityType.REQUIREMENT]

    for ctrl in controls:
        for rk in risks:
            add_rel(ctrl.canonical_name, rk.canonical_name, RelationshipType.MITIGATES)
        for pol in policies:
            add_rel(ctrl.canonical_name, pol.canonical_name, RelationshipType.SATISFIES)
        for reg in regulations:
            add_rel(ctrl.canonical_name, reg.canonical_name, RelationshipType.SATISFIES)

    for pol in policies:
        for sys in systems:
            add_rel(pol.canonical_name, sys.canonical_name, RelationshipType.GOVERNS)

    for req in requirements:
        for reg in regulations:
            add_rel(req.canonical_name, reg.canonical_name, RelationshipType.SATISFIES)
        for sys in systems:
            add_rel(req.canonical_name, sys.canonical_name, RelationshipType.PROTECTS)

    # Connect adjacent requirement nodes in chunk sequence
    for i in range(len(requirements) - 1):
        add_rel(requirements[i].canonical_name, requirements[i + 1].canonical_name, RelationshipType.RELATED_TO)

    return ExtractionResult(
        entities=list(resolver.entities_by_id.values()),
        relationships=relationships
    )
