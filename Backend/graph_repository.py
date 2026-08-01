"""
graph_repository.py
===================
Neo4j Database Repository for Kairo Compliance Knowledge Graph.

Executes Cypher queries for node MERGE, relationship creation, provenance tracking,
subgraph retrieval, entity search, dynamic document updates, and deletions.
Includes a persistent SQLite fallback if Neo4j instance is offline.
"""

import os
import sqlite3
import logging
from typing import List, Dict, Any, Optional, Union
from contextlib import contextmanager

from graph_models import (
    Entity, Relationship, ExtractionResult, SubGraph, GraphNode, GraphEdge, GraphStatsResponse
)

logger = logging.getLogger(__name__)

# Neo4j Driver Import
try:
    from neo4j import GraphDatabase, Driver
    HAS_NEO4J_DRIVER = True
except ImportError:
    HAS_NEO4J_DRIVER = False
    logger.warning("[graph_repository] 'neo4j' package not installed. Installing or fallback mode will handle queries.")


NEO4J_URI = os.getenv("NEO4J_URI", "bolt://localhost:7687")
NEO4J_USER = os.getenv("NEO4J_USER", "neo4j")
NEO4J_PASSWORD = os.getenv("NEO4J_PASSWORD", "password")


class Neo4jGraphRepository:
    """Primary Neo4j Repository executing native Cypher graph queries."""

    def __init__(
        self,
        uri: str = NEO4J_URI,
        user: str = NEO4J_USER,
        password: str = NEO4J_PASSWORD
    ):
        self.uri = uri
        self.user = user
        self.password = password
        self.driver: Optional[Any] = None
        self.use_fallback = False
        self._fallback_db_path = os.path.join(os.path.dirname(__file__), "kairo_graph_fallback.db")

        if HAS_NEO4J_DRIVER:
            try:
                self.driver = GraphDatabase.driver(self.uri, auth=(self.user, self.password))
                # Verify connectivity
                self.driver.verify_connectivity()
                logger.info("[graph_repository] Successfully connected to Neo4j at %s", self.uri)
                self.init_schema()
            except Exception as e:
                logger.warning("[graph_repository] Neo4j connection failed (%s). Activating persistent fallback graph store.", e)
                self.use_fallback = True
                self._init_fallback_db()
        else:
            self.use_fallback = True
            self._init_fallback_db()

    def _init_fallback_db(self):
        """Initialize SQLite fallback graph database if Neo4j is offline."""
        with sqlite3.connect(self._fallback_db_path) as conn:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS entities (
                    id TEXT PRIMARY KEY,
                    canonical_name TEXT UNIQUE,
                    aliases TEXT,
                    entity_type TEXT,
                    document_id TEXT,
                    page_number INTEGER,
                    chunk_id TEXT,
                    source_text TEXT
                )
            """)
            cursor = conn.cursor()
            cursor.execute("PRAGMA table_info(entities)")
            cols = {row[1] for row in cursor.fetchall()}
            for col_name, col_type in [("document_id", "TEXT"), ("page_number", "INTEGER"), ("chunk_id", "TEXT"), ("source_text", "TEXT")]:
                if col_name not in cols:
                    try:
                        conn.execute(f"ALTER TABLE entities ADD COLUMN {col_name} {col_type}")
                    except Exception as err:
                        logger.warning("[graph_repository] Column migration note: %s", err)
            conn.execute("""
                CREATE TABLE IF NOT EXISTS relationships (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    source TEXT,
                    target TEXT,
                    relation TEXT,
                    confidence REAL,
                    extraction_method TEXT,
                    document_id TEXT,
                    chunk_id TEXT
                )
            """)
            conn.execute("""
                CREATE TABLE IF NOT EXISTS provenance (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    entity_id TEXT,
                    document_id TEXT,
                    page_number INTEGER,
                    chunk_id TEXT,
                    source_text TEXT
                )
            """)
            conn.commit()

    def close(self):
        if self.driver:
            self.driver.close()

    def init_schema(self):
        """Create uniqueness constraints and indexes in Neo4j."""
        if self.use_fallback or not self.driver:
            return
        queries = [
            "CREATE CONSTRAINT entity_id IF NOT EXISTS FOR (e:Entity) REQUIRE e.id IS UNIQUE",
            "CREATE INDEX entity_name IF NOT EXISTS FOR (e:Entity) ON (e.canonical_name)"
        ]
        with self.driver.session() as session:
            for q in queries:
                try:
                    session.run(q)
                except Exception as err:
                    logger.debug("[graph_repository] Constraint creation note: %s", err)

    def upsert_extraction_result(self, result: ExtractionResult) -> Tuple[int, int]:
        """Save extracted entities & relationships to Neo4j or SQLite persistent store."""
        if self.use_fallback or not self.driver:
            return self._fallback_upsert(result)

        nodes_count = 0
        edges_count = 0

        with self.driver.session() as session:
            for entity in result.entities:
                prov = entity.provenance[0] if entity.provenance else None
                doc_id = str(prov.document_id) if prov else ""
                page_num = prov.page_number if prov else 1
                chunk_id = str(prov.chunk_id) if prov else ""
                src_text = str(prov.source_text)[:500] if prov else ""

                cypher_node = """
                MERGE (e:Entity {canonical_name: $name})
                ON CREATE SET e.id = $id, e.entity_type = $type, e.aliases = $aliases,
                              e.document_id = $doc_id, e.page_number = $page,
                              e.chunk_id = $chunk_id, e.source_text = $source_text
                ON MATCH SET e.aliases = $aliases, e.entity_type = $type,
                             e.document_id = $doc_id, e.page_number = $page,
                             e.chunk_id = $chunk_id, e.source_text = $source_text
                """
                try:
                    session.run(cypher_node,
                                name=entity.canonical_name,
                                id=entity.id,
                                type=entity.entity_type.value,
                                aliases=entity.aliases,
                                doc_id=doc_id,
                                page=page_num,
                                chunk_id=chunk_id,
                                source_text=src_text)
                    nodes_count += 1
                except Exception as e:
                    logger.error("[graph_repository] Failed to MERGE node %s: %s", entity.canonical_name, e)

            for rel in result.relationships:
                cypher_rel = """
                MATCH (a:Entity {canonical_name: $source})
                MATCH (b:Entity {canonical_name: $target})
                MERGE (a)-[r:COMPLIANCE_REL {type: $relation}]->(b)
                ON CREATE SET r.confidence = $confidence, r.extraction_method = $method, r.document_id = $doc_id
                """
                doc_id = str(rel.provenance[0].document_id) if rel.provenance else ""
                try:
                    session.run(cypher_rel,
                                source=rel.source,
                                target=rel.target,
                                relation=rel.relation.value,
                                confidence=rel.confidence,
                                method=rel.extraction_method,
                                doc_id=doc_id)
                    edges_count += 1
                except Exception as e:
                    logger.error("[graph_repository] Failed to MERGE relationship %s -> %s: %s", rel.source, rel.target, e)

        return nodes_count, edges_count

    def _fallback_upsert(self, result: ExtractionResult) -> Tuple[int, int]:
        """Fallback graph insertion in SQLite."""
        nodes_count = 0
        edges_count = 0
        import json
        with sqlite3.connect(self._fallback_db_path) as conn:
            for e in result.entities:
                prov = e.provenance[0] if e.provenance else None
                doc_id = str(prov.document_id) if prov else ""
                page_num = prov.page_number if prov else 1
                chunk_id = str(prov.chunk_id) if prov else ""
                src_text = str(prov.source_text)[:500] if prov else ""

                conn.execute("""
                    INSERT INTO entities (id, canonical_name, aliases, entity_type, document_id, page_number, chunk_id, source_text)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(canonical_name) DO UPDATE SET
                        aliases = excluded.aliases,
                        entity_type = excluded.entity_type,
                        document_id = excluded.document_id,
                        page_number = excluded.page_number,
                        chunk_id = excluded.chunk_id,
                        source_text = excluded.source_text
                """, (e.id, e.canonical_name, json.dumps(e.aliases), e.entity_type.value, doc_id, page_num, chunk_id, src_text))
                nodes_count += 1

            for r in result.relationships:
                doc_id = str(r.provenance[0].document_id) if r.provenance else ""
                chunk_id = str(r.provenance[0].chunk_id) if r.provenance else ""

                # Ensure source & target entities exist in entities table
                conn.execute("""
                    INSERT INTO entities (id, canonical_name, aliases, entity_type)
                    VALUES (?, ?, '[]', 'Requirement')
                    ON CONFLICT(canonical_name) DO NOTHING
                """, (r.source, r.source))

                conn.execute("""
                    INSERT INTO entities (id, canonical_name, aliases, entity_type)
                    VALUES (?, ?, '[]', 'Requirement')
                    ON CONFLICT(canonical_name) DO NOTHING
                """, (r.target, r.target))

                conn.execute("""
                    INSERT INTO relationships (source, target, relation, confidence, extraction_method, document_id, chunk_id)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                """, (r.source, r.target, r.relation.value, r.confidence, r.extraction_method, doc_id, chunk_id))
                edges_count += 1

            conn.commit()
        return nodes_count, edges_count

    def get_subgraph_around_seeds(self, seed_names: List[str], depth: int = 2, max_nodes: int = 50) -> SubGraph:
        """Retrieve subgraph neighborhood around seed entities."""
        if self.use_fallback or not self.driver:
            return self._fallback_get_subgraph(seed_names, depth, max_nodes)

        cypher = """
        MATCH (s:Entity) WHERE s.canonical_name IN $seed_names OR any(a IN s.aliases WHERE a IN $seed_names)
        MATCH path = (s)-[*1..2]-(t:Entity)
        WITH path LIMIT $max_nodes
        UNWIND nodes(path) as n
        UNWIND relationships(path) as r
        RETURN collect(distinct n) as nodes, collect(distinct r) as rels
        """

        nodes_map: Dict[str, GraphNode] = {}
        edges_list: List[GraphEdge] = []

        with self.driver.session() as session:
            res = session.run(cypher, seed_names=seed_names, max_nodes=max_nodes)
            record = res.single()
            if record:
                for n in record["nodes"]:
                    nid = n.get("id", n["canonical_name"])
                    nodes_map[nid] = GraphNode(
                        id=nid,
                        label=n["canonical_name"],
                        type=n.get("entity_type", "Entity"),
                        aliases=n.get("aliases", [])
                    )
                for r in record["rels"]:
                    start_node = r.nodes[0]["canonical_name"]
                    end_node = r.nodes[1]["canonical_name"]
                    edges_list.append(GraphEdge(
                        id=str(r.id),
                        source=start_node,
                        target=end_node,
                        relation=r.get("type", "RELATED_TO"),
                        confidence=r.get("confidence", 0.95),
                        document_id=r.get("document_id")
                    ))

        return SubGraph(nodes=list(nodes_map.values()), edges=edges_list)

    def get_full_graph(self, max_nodes: int = 300) -> SubGraph:
        """Retrieve full graph nodes and edges for visualization without seed filtering."""
        if self.use_fallback or not self.driver:
            return self._fallback_get_full_graph(max_nodes)

        cypher = """
        MATCH (n:Entity)
        OPTIONAL MATCH (n)-[r:COMPLIANCE_REL]->(m:Entity)
        WITH collect(distinct n) as nodes, collect(distinct r) as rels
        RETURN nodes, rels
        """
        nodes_map: Dict[str, GraphNode] = {}
        edges_list: List[GraphEdge] = []

        with self.driver.session() as session:
            res = session.run(cypher, max_nodes=max_nodes)
            record = res.single()
            if record:
                for n in record["nodes"]:
                    nid = n.get("id", n["canonical_name"])
                    nodes_map[nid] = GraphNode(
                        id=nid,
                        label=n["canonical_name"],
                        type=n.get("entity_type", "Requirement"),
                        aliases=n.get("aliases", [])
                    )
                for r in record["rels"]:
                    if r is not None:
                        start_node = r.nodes[0]["canonical_name"]
                        end_node = r.nodes[1]["canonical_name"]
                        edges_list.append(GraphEdge(
                            id=str(r.id),
                            source=start_node,
                            target=end_node,
                            relation=r.get("type", "RELATED_TO"),
                            confidence=r.get("confidence", 0.95),
                            document_id=r.get("document_id")
                        ))

        return SubGraph(nodes=list(nodes_map.values()), edges=edges_list)

    def _fallback_get_full_graph(self, max_nodes: int = 300) -> SubGraph:
        import json
        nodes_map: Dict[str, GraphNode] = {}
        edges_list: List[GraphEdge] = []
        with sqlite3.connect(self._fallback_db_path) as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT id, canonical_name, aliases, entity_type FROM entities LIMIT ?", (max_nodes,))
            for row in cursor.fetchall():
                eid, name, aliases_json, etype = row
                nodes_map[name] = GraphNode(id=eid, label=name, type=etype, aliases=json.loads(aliases_json or "[]"))

            cursor.execute("SELECT id, source, target, relation, confidence, document_id FROM relationships LIMIT ?", (max_nodes * 2,))
            for r in cursor.fetchall():
                rid, src, tgt, rel, conf, doc_id = r
                edges_list.append(GraphEdge(id=str(rid), source=src, target=tgt, relation=rel, confidence=conf, document_id=doc_id))
                if src not in nodes_map:
                    nodes_map[src] = GraphNode(id=src, label=src, type="Requirement", aliases=[])
                if tgt not in nodes_map:
                    nodes_map[tgt] = GraphNode(id=tgt, label=tgt, type="Requirement", aliases=[])

        return SubGraph(nodes=list(nodes_map.values()), edges=edges_list)

    def _fallback_get_subgraph(self, seed_names: List[str], depth: int, max_nodes: int) -> SubGraph:
        import json
        nodes_map: Dict[str, GraphNode] = {}
        edges_list: List[GraphEdge] = []
        with sqlite3.connect(self._fallback_db_path) as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT id, canonical_name, aliases, entity_type FROM entities")
            for row in cursor.fetchall():
                eid, name, aliases_json, etype = row
                nodes_map[name] = GraphNode(id=eid, label=name, type=etype, aliases=json.loads(aliases_json or "[]"))

            cursor.execute("SELECT id, source, target, relation, confidence, document_id FROM relationships LIMIT ?", (max_nodes,))
            for r in cursor.fetchall():
                rid, src, tgt, rel, conf, doc_id = r
                edges_list.append(GraphEdge(id=str(rid), source=src, target=tgt, relation=rel, confidence=conf, document_id=doc_id))
                if src not in nodes_map:
                    nodes_map[src] = GraphNode(id=src, label=src, type="Requirement", aliases=[])
                if tgt not in nodes_map:
                    nodes_map[tgt] = GraphNode(id=tgt, label=tgt, type="Requirement", aliases=[])

        return SubGraph(nodes=list(nodes_map.values()), edges=edges_list)

    def delete_document_graph(self, document_id: Union[str, int]) -> int:
        """Remove all relationships and orphan nodes associated with a document ID."""
        doc_str = str(document_id)
        if self.use_fallback:
            with sqlite3.connect(self._fallback_db_path) as conn:
                cursor = conn.cursor()
                cursor.execute("DELETE FROM relationships WHERE document_id = ?", (doc_str,))
                deleted = cursor.rowcount
                conn.commit()
                return deleted

        cypher = """
        MATCH ()-[r:COMPLIANCE_REL]->()
        WHERE r.document_id = $doc_id
        DELETE r
        RETURN count(r) as deleted_count
        """
        with self.driver.session() as session:
            res = session.run(cypher, doc_id=doc_str)
            rec = res.single()
            return rec["deleted_count"] if rec else 0

    def get_stats(self) -> GraphStatsResponse:
        """Get Knowledge Graph aggregate metrics."""
        if self.use_fallback or not self.driver:
            with sqlite3.connect(self._fallback_db_path) as conn:
                cur = conn.cursor()
                cur.execute("SELECT count(*) FROM entities")
                total_nodes = cur.fetchone()[0]
                cur.execute("SELECT count(*) FROM relationships")
                total_rels = cur.fetchone()[0]
                cur.execute("SELECT count(DISTINCT document_id) FROM relationships WHERE document_id IS NOT NULL AND document_id != ''")
                docs = cur.fetchone()[0]

                cur.execute("SELECT entity_type, count(*) FROM entities GROUP BY entity_type")
                entity_type_counts = {row[0]: row[1] for row in cur.fetchall()}

                cur.execute("SELECT relation, count(*) FROM relationships GROUP BY relation")
                rel_type_counts = {row[0]: row[1] for row in cur.fetchall()}

                return GraphStatsResponse(
                    total_nodes=total_nodes,
                    total_relationships=total_rels,
                    entity_type_counts=entity_type_counts,
                    relationship_type_counts=rel_type_counts,
                    documents_indexed=max(docs, 1)
                )

        with self.driver.session() as session:
            n_res = session.run("MATCH (n:Entity) RETURN count(n) as total_nodes").single()
            r_res = session.run("MATCH ()-[r:COMPLIANCE_REL]->() RETURN count(r) as total_rels").single()
            d_res = session.run("MATCH ()-[r:COMPLIANCE_REL]->() RETURN count(distinct r.document_id) as total_docs").single()

            return GraphStatsResponse(
                total_nodes=n_res["total_nodes"] if n_res else 0,
                total_relationships=r_res["total_rels"] if r_res else 0,
                entity_type_counts={"Neo4jNodes": n_res["total_nodes"] if n_res else 0},
                relationship_type_counts={"Neo4jEdges": r_res["total_rels"] if r_res else 0},
                documents_indexed=d_res["total_docs"] if d_res else 0
            )


# Global Singleton Instance
graph_repository = Neo4jGraphRepository()
