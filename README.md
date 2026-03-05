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

- **`cuemap_recall`**: Recalls context about a codebase from your CueMap integrated brain. Uses natural language and semantic search to find relevant information.
  - `query` (string): The natural language query to search for.
  - `limit` (number, optional): Maximum results to return (default: 10).
  - `projects` (string[], optional): List of project IDs to scope the search to. Multiple enables cross-project queries.
  - `cues` (string[], optional): Specific cue tags to filter the search.
  - `depth` (number, optional): Depth of multi-hop recall expander (default: 1).
  - `auto_reinforce` (boolean, optional): Automatically reinforce retrieved memories (default: false).
  - `min_intersection` (number, optional): Minimum required cue intersection count (default: 0).
  - `explain` (boolean, optional): Include scoring explanation data in results (default: false).
  - `disable_pattern_completion` (boolean, optional): Skip pattern completion inference.
  - `disable_salience_bias` (boolean, optional): Disable salience scoring bias.
  - `disable_systems_consolidation` (boolean, optional): Skip returning summary/consolidated memories.
  - `disable_alias_expansion` (boolean, optional): Disable lexicon synonym injection during querying.

## License

MIT - See the [LICENSE](LICENSE) file for more details.
