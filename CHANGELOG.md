# Changelog

## [0.7.2] - 2026-08-04

### Added

- Updated `cuemap_recall` to expose the Rust engine's `lexical`, `semantic`, and `hybrid` query modes.
- Added optional precomputed `query_embedding` support.
- Added `cuemap_intent_classify` for the Rust engine's local query/memory intent API.
- Added precomputed memory `embedding` and per-chunk raw-content `embeddings` inputs.
- Added intent-aware ingestion completion monitoring with `pending_intents` and `intent_ready` handling.
- Requires the engine capability set used by the v0.7.2 MCP tool surface when attaching to an existing process.
- Updated the release docs for qint8 MiniLM-L3 by default and q4 MiniLM-L3 on edge devices.

### Removed

- Removed CuePack tools and request inputs because CuePacks are no longer part of the v0.7.2 Rust engine.
