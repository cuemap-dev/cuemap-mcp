# CueMap MCP Server

The [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server for CueMap, allowing AI coding assistants (like Claude Desktop, Cursor, Windsurf, and Antigravity) to instantly recall codebase context using the CueMap engine.

## Zero-Config Deployment

The CueMap MCP Server is designed to work completely out-of-the-box. When started, it automatically manages a high-performance Rust instance of the CueMap Server in the background.

You do **not** need to install or run the CueMap CLI manually. The correct pre-compiled binary for your operating system is automatically downloaded via optional NPM dependencies.

## Installation

```bash
# Global installation makes the `cuemap-mcp` command available
npm install -g cuemap-mcp
```

*(Note: Ensure your package manager is configured to download `optionalDependencies` so the local Rust binary is included).*

## Configuration (Environment Variables)

By default, the embedded engine runs on port `8080`. You can customize the server behavior by passing the following environment variables in your MCP configuration:

- `CUEMAP_PORT`: Override the port the embedded engine binds to (default: `8080`).
- `CUEMAP_CONFIG_PATH`: Absolute path to a custom `server_config.toml` to configure advanced Engine tuning, background jobs, and RAG search parameters.
- `CUEMAP_URL`: If you prefer to bypass the embedded engine and connect to a remotely hosted or separately running CueMap server, specify its URL here (e.g. `http://localhost:8080`).

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

- **`cuemap_init`**: Autonomously initializes a CueMap project for a given local repository path. This triggers the Self-Learning Agent to instantly ingest the codebase so `cuemap_recall` can be used.
  - `path` (string): Absolute path to the local repository.
  - `projectName` (string, optional): The ID of the project to create. Defaults to the folder name of the path.

- **`cuemap_add`**: Stores one natural-language memory in an explicit project. The project is created automatically if it does not exist.
  - `content` (string): Memory content to store.
  - `project` (string): Project ID that will own the memory.
  - `cues` (string[], optional): Explicit cues/tags to associate with the memory.
  - `metadata` (object, optional): JSON metadata to store with the memory.
  - `source_key` (string, optional): Stable source key for deterministic upsert/deduplication.
  - `cuepacks` (string[], optional): CuePack names to apply during deterministic cue extraction.
  - `disable_temporal_chunking` (boolean, optional): Disable temporal chunking for this memory.
  - `async_ingest` (boolean, optional): Process ingestion in the background and return immediately.

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
  - `cuepacks` (string[], optional): Cuepack names to apply during query-intent expansion.
  - `parent_fusion` (`off` | `auto` | `force`, optional): Chunk-parent fusion mode.
  - `ordered_reconstruction` (`off` | `auto` | `force`, optional): Ordered session reconstruction mode.
  - `evidence_coverage` (`off` | `auto` | `force`, optional): Multi-evidence coverage mode.
  - `disable_cuebridge_artifacts` (boolean, optional): Disable CueBridge artifact expansion.
  - `cuebridge_gap_limit` (number, optional): Maximum CueBridge gap expansions.

## License

MIT - See the [LICENSE](LICENSE) file for more details.
