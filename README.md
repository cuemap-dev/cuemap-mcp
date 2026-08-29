<p align="center">
  <img src="https://cuemap.dev/cuemap-logo.PNG" alt="CueMap" width="120">
</p>

<h1 align="center">CueMap MCP Server v0.7.3</h1>

<p align="center">A premium MCP bridge for explainable, repository-aware agent memory.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/cuemap-mcp"><img src="https://img.shields.io/npm/v/cuemap-mcp?logo=npm" alt="npm"></a>
  <a href="https://www.npmjs.com/package/cuemap-mcp"><img src="https://img.shields.io/npm/dm/cuemap-mcp?logo=npm" alt="npm downloads"></a>
  <a href="https://modelcontextprotocol.io/"><img src="https://img.shields.io/badge/MCP-compatible-7c3aed" alt="MCP compatible"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-5e5ce6" alt="License"></a>
</p>

The [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server for CueMap, allowing AI coding assistants (like Claude Desktop, Cursor, Windsurf, and Antigravity) to instantly recall codebase context using the CueMap engine.

## Zero-Config Deployment

The CueMap MCP Server is designed to work completely out-of-the-box. When started, it automatically manages a high-performance Rust instance of the CueMap Server in the background. The v0.7.3 engine bundles qint8 MiniLM-L3 by default and q4 MiniLM-L3 for the edge profile; no model download occurs at runtime.

You do **not** need to install or run the CueMap CLI manually. The correct pre-compiled binary for your operating system is automatically downloaded via optional NPM dependencies. Embedded startup supports Linux x64/ARM64, macOS x64/ARM64, and Windows x64.

## Installation

```bash
# Global installation makes the `cuemap-mcp` command available
npm install -g cuemap-mcp
```

*(Note: Ensure your package manager is configured to download `optionalDependencies` so the local Rust binary is included).*

## Agent Plugin

CueMap also ships a separate [`cuemap-agent-plugin`](https://www.npmjs.com/package/cuemap-agent-plugin) package for Agent Plugins-compatible clients. It bundles the portable `plugin.json` manifest, stdio `mcp.json` configuration, and a repository-memory skill. The plugin launches this MCP server at the matching release version and must be installed or downloaded separately from `cuemap-mcp`.

## Configuration (Environment Variables)

By default, the embedded engine runs on port `8080`. You can customize the server behavior by passing the following environment variables in your MCP configuration:

- `CUEMAP_PORT`: Override the port the embedded engine binds to (default: `8080`).
- `CUEMAP_CONFIG_PATH`: Absolute path to a custom `server_config.toml` to configure advanced Engine tuning, background jobs, and RAG search parameters.
- `CUEMAP_URL`: If you prefer to bypass the embedded engine and connect to a remotely hosted or separately running CueMap server, specify its URL here (e.g. `http://localhost:8080`).
- `CUEMAP_PROJECT`: Override the default project. Without this setting, CueMap derives a stable repository-scoped project from the current Git remote or working directory.
- `CUEMAP_LOG_PATH`: Override the embedded engine log path. It defaults to `~/.cuemap/server.log`, which is the file read by `cuemap logs`.

### Server lifecycle

The MCP server calls `EmbeddedCueMap.start()` as soon as Codex launches the plugin process, before any CueMap tool is invoked. It attaches to a compatible engine already listening at `CUEMAP_URL` or the configured port; otherwise it starts and owns a local engine automatically. `cuemap_init` does not start the server—it previews or applies a confirmed repository scope after the engine is ready. An engine owned by the MCP process is stopped gracefully when that process exits.

## Using with AI Agents

To use this MCP server with your AI assistant, add it to your assistant's MCP configuration file.

### Example Configuration (Claude Desktop)

```json
{
  "mcpServers": {
    "cuemap": {
      "command": "npx",
      "args": [
        "-y",
        "cuemap-mcp"
      ],
      "env": {
        "CUEMAP_PORT": "8080"
      }
    }
  }
}
```

## Available Tools

- **`cuemap_init_preview`**: Performs a read-only repository metadata scan and returns supported top-level folders/root files, counts, the stable repository project ID, and any existing saved scope. Present this preview to the user before ingestion.
  - `path` (string): Absolute path to the repository root.
  - `projectName` (string, optional): Project ID override. Defaults to the stable repository-scoped ID.
  - `includedPaths` (string[], optional): Repository-relative files or folders to preview. Empty means all supported files allowed by ignore rules.
  - `ignoredPatterns` (string[], optional): Additional gitignore-style exclusions.
  - `ignoredExtensions` (string[], optional): Additional excluded extensions.

- **`cuemap_init`**: Applies a user-confirmed repository ingestion scope, starts the initial scan, and keeps watching that scope for new, changed, deleted, newly ignored, or newly unignored supported files. It only reports verified completion after observing ingestion activity, reaching a terminal job phase, and completing intent annotation; an initial `idle` status with `0/0` writes is not considered complete.
  - `path` (string): Absolute path to the repository root.
  - `projectName` (string, optional): Project ID override. Defaults to the stable repository-scoped ID.
  - `includedPaths` (string[], optional): User-approved repository-relative files or folders. Empty means all supported files allowed by ignore rules.
  - `ignoredPatterns` (string[], optional): Additional gitignore-style exclusions.
  - `ignoredExtensions` (string[], optional): Additional excluded extensions.
  - `confirmed` (boolean): Must be true only after explicit user confirmation of the previewed scope.

- **`cuemap_status`**: Returns project-scoped background ingestion progress plus derived monitoring fields. Poll it after `cuemap_init` until `verified_complete` is `true`.
  - `project` (string, optional): Project ID override. Defaults to the stable repository-scoped ID.
  - `active`: Whether the current phase is non-terminal or writes/intent annotations remain pending.
  - `observed_activity`: Whether this MCP process has observed an active phase or positive write/intent counts for the project.
  - `pending_writes`: Remaining writes based on the latest totals.
  - `pending_intents`: Remaining memory intent annotations based on the latest totals.
  - `verified_complete`: True only after activity has been observed, the project reaches `done` or `idle`, no work failed or remains pending, and `intent_ready` is not false.

### Project inspection and memory lifecycle

- **`cuemap_projects`**: List projects and their summary metadata.
- **`cuemap_stats`**: Read repository-project statistics, or global engine statistics with `global: true`.
- **`cuemap_memory_get`**: Read one memory by numeric `memory_id`.
- **`cuemap_memory_reinforce`**: Reinforce one memory, optionally on explicit `cues`.
- **`cuemap_memory_delete`**: Permanently delete one memory. Requires `confirmed: true` after explicit user confirmation.
- **`cuemap_project_export`**: Export a cursor-paginated project page with configurable content, cue, and metadata inclusion.
- **`cuemap_project_artifacts`**: Inspect CueBridge artifact metadata without reloading it.

### Explicit ingestion

- **`cuemap_ingest_url`**: Ingest one URL or recursively crawl it with `depth` and `same_domain_only` controls.
- **`cuemap_ingest_content`**: Ingest supplied text with filename, source-key, metadata, structural-cue, segmentation, and optional one-vector-per-produced-chunk `embeddings`.
- **`cuemap_ingest_file`**: Ingest one user-approved local file path.

These tools are for explicit ingestion requests. Repository initialization continues to use the preview, confirmation, and watcher workflow above.

### Alias and Lexicon administration

- **`cuemap_alias_list`**, **`cuemap_alias_add`**, **`cuemap_alias_merge`**: Inspect and manage manual cue aliases. Merging requires `confirmed: true`.
- **`cuemap_lexicon_inspect`**, **`cuemap_lexicon_graph`**, **`cuemap_lexicon_wire`**, **`cuemap_lexicon_delete`**: Inspect and administer Lexicon relationships. Deletion requires `confirmed: true`.
- **`cuemap_add`**: Stores one natural-language memory. The project is created automatically if it does not exist.
  - `content` (string): Memory content to store.
  - `project` (string, optional): Project ID that will own the memory. Defaults to the current repository-scoped project.
  - `cues` (string[], optional): Explicit cues/tags to associate with the memory.
  - `metadata` (object, optional): JSON metadata to store with the memory.
  - `source_key` (string, optional): Stable source key for deterministic upsert/deduplication.
  - `event_time` (number, optional): Original event timestamp as Unix seconds. Defaults to ingestion time.
  - `embedding` (number[], optional): Precomputed memory embedding.
  - `disable_temporal_chunking` (boolean, optional): Disable temporal chunking for this memory.
  - `async_ingest` (boolean, optional): Process ingestion in the background and return immediately.

- **`cuemap_intent_classify`**: Classifies text with the engine's local intent model. Accepts `target: "query"` or `"memory"` and returns relative intent scores, recall/memory eligibility, confidence weight, and model/taxonomy versions. Scores are ranking signals, not calibrated probabilities.

- **`cuemap_recall`**: Recalls context about a codebase from your CueMap integrated brain. Uses natural language and semantic search to find relevant information.
  - `query` (string): The natural language query to search for.
  - `limit` (number, optional): Maximum results to return (default: 10).
  - `projects` (string[], optional): List of project IDs to scope the search to. Multiple enables cross-project queries.
  - `cues` (string[], optional): Specific cue tags to filter the search.
  - `query_time` (string, optional): Timestamp or natural-language time anchor for v0.7 temporal query intent.
  - `depth` (number, optional): Depth of multi-hop recall expander (default: 1).
  - `expansion_depth` (number, optional): Alias/cue expansion depth (default: 1).
  - `auto_reinforce` (boolean, optional): Automatically reinforce retrieved memories (default: false).
  - `min_intersection` (number, optional): Minimum required cue intersection count (default: 0).
  - `explain` (boolean, optional): Include scoring explanation data in results (default: false).
  - `trace_timing` (boolean, optional): Include v0.7 timing diagnostics.
  - `disable_salience_bias` (boolean, optional): Disable salience scoring bias.
  - `disable_alias_expansion` (boolean, optional): Disable lexicon synonym injection during querying (default: true).
  - `parent_fusion` (`off` | `auto` | `force`, optional): Chunk-parent fusion mode.
  - `ordered_reconstruction` (`off` | `auto` | `force`, optional): Ordered session reconstruction mode.
  - `evidence_coverage` (`off` | `auto` | `force`, optional): Multi-evidence coverage mode.
  - `disable_cuebridge_artifacts` (boolean, optional): Disable CueBridge artifact expansion.
  - `cuebridge_gap_limit` (number, optional): Maximum CueBridge gap expansions.
  - `semantic_mode` (`lexical`, `semantic`, or `hybrid`, optional): Choose cue-only recall, vector candidate discovery, or local semantic reranking of lexical candidates. The engine default is `hybrid`.
- `query_embedding` (number[], optional): Supply a precomputed query vector when the calling application owns the embedding provider.

## License

MIT - See the [LICENSE](LICENSE) file for more details.
