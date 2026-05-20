// R1.1 — Pure detection of embedding models.
// Spec: SEMANTIC_ROUTING_FEATURES.md §R1.1.
//
// "Is this GGUF an embedding model?" decided from the filename pattern
// AND/OR header signals (architecture / modality / a pooling-type KV).
// Pure — no I/O. The ParseAll wiring (autoTag `embedding` + sidecar
// `isEmbeddingModel: true`) consumes this; that integration is separate.
//
// A reranker (bge-reranker-*, a cross-encoder served on /v1/rerank, R1.6)
// is NOT an embedding model — explicitly excluded.

import type { HeaderMeta } from '../../../renderer/modelhub/types';

/**
 * Filename markers for the common local embedding families. Matched
 * case-insensitively anywhere in the basename. Kept conservative: these are
 * the families llama.cpp can serve with `--embedding`.
 */
export const EMBEDDING_FILENAME_PATTERNS: RegExp[] = [
  /\bbge[-_]/i, // BAAI bge / bge-m3 / bge-large
  /\bgte[-_]/i, // Alibaba gte
  /(^|[-_])e5[-_]/i, // intfloat e5 / multilingual-e5
  /nomic[-_]?embed/i, // nomic-embed-text
  /jina[-_]?embed/i, // jina-embeddings-v2/v3
  /mxbai[-_]?embed/i, // mixedbread mxbai-embed
  /(snowflake[-_])?arctic[-_]?embed/i, // snowflake-arctic-embed
  /all[-_]minilm/i, // sentence-transformers all-MiniLM
  /\bgist[-_]/i, // GIST embedding
  /sfr[-_]?embed/i, // Salesforce SFR-Embedding
  /\bembedding(s)?\b/i, // generic "...-embedding-..."
];

/** Cross-encoder rerankers are served on /v1/rerank, not /v1/embeddings. */
const RERANKER_PATTERN = /rerank/i;

/** GGUF architectures that are embedding encoders. */
const EMBEDDING_ARCHITECTURES = new Set([
  'bert',
  'nomic-bert',
  'jina-bert',
  'jina-bert-v2',
  'roberta',
  't5encoder',
]);

function nameLooksLikeEmbedding(fileName: string): boolean {
  if (RERANKER_PATTERN.test(fileName)) return false;
  return EMBEDDING_FILENAME_PATTERNS.some((re) => re.test(fileName));
}

function headerLooksLikeEmbedding(header: HeaderMeta | undefined): boolean {
  if (!header) return false;
  if (header.modality === 'embedding') return true;
  const arch = String(header.architecture ?? '').toLowerCase();
  if (EMBEDDING_ARCHITECTURES.has(arch)) return true;
  const raw = header.rawMetadata ?? {};
  // llama.cpp embedding models carry `<arch>.pooling_type` (uint32).
  for (const k of Object.keys(raw)) {
    if (k === 'pooling.type' || k.endsWith('.pooling_type')) return true;
  }
  return false;
}

/**
 * True when the model should be treated as an embedding model. A reranker
 * is never an embedding model even if its name matches a family pattern
 * (the negative guard wins over the filename heuristic).
 */
export function isEmbeddingModel(args: {
  fileName: string;
  header?: HeaderMeta;
}): boolean {
  const { fileName, header } = args;
  if (RERANKER_PATTERN.test(fileName)) return false;
  return nameLooksLikeEmbedding(fileName) || headerLooksLikeEmbedding(header);
}
