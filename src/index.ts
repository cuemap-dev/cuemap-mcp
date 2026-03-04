#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import CueMap from "cuemap";
import { spawn, ChildProcess } from "child_process";
import path from "path";
import os from "os";
import fs from "fs";

let engineProcess: ChildProcess | null = null;
let CUEMAP_URL = process.env.CUEMAP_URL;
let client: CueMap;

const server = new McpServer({
    name: "cuemap-mcp",
    version: "1.0.0",
});

function getCuemapBinaryPath(): string | null {
    if (process.env.CUEMAP_BIN) return process.env.CUEMAP_BIN;

    // Check optional dependencies dynamically
    try {
        const platform = os.platform();
        const arch = os.arch();
        const pkgName = `@cuemap/engine-${platform}-${arch}`;
        const resolved = require.resolve(`${pkgName}/package.json`);
        const binPath = path.join(path.dirname(resolved), "bin", "cuemap");
        if (fs.existsSync(binPath)) return binPath;
    } catch (e) {
        // Ignored
    }

    // Fallback: Check locally built binary (for development)
    const localPath = path.resolve(__dirname, "../../rust_engine/target/release/cuemap");
    if (fs.existsSync(localPath)) return localPath;

    return null;
}

async function startEngine(): Promise<void> {
    if (CUEMAP_URL) {
        console.error(`Using external CueMap engine at ${CUEMAP_URL}`);
        return;
    }

    const binPath = getCuemapBinaryPath();
    if (!binPath) {
        console.error("Could not find cuemap binary. Please install the correct optional dependency, set CUEMAP_BIN, or set CUEMAP_URL to an existing instance.");
        console.error("Falling back to expecting 'cuemap' in PATH.");
    }

    const execPath = binPath || "cuemap";
    const port = process.env.CUEMAP_PORT || "8080";
    CUEMAP_URL = `http://127.0.0.1:${port}`;

    const args = ["start", "--port", port];
    if (process.env.CUEMAP_CONFIG_PATH) {
        args.push("--config", process.env.CUEMAP_CONFIG_PATH);
        console.error(`Using custom config at ${process.env.CUEMAP_CONFIG_PATH}`);
    }

    console.error(`Starting Embedded CueMap Engine on port ${port}...`);
    engineProcess = spawn(execPath, args, {
        stdio: "ignore",
        env: { ...process.env, CUEMAP_PORT: port }
    });

    engineProcess.on("error", (err) => {
        console.error("Failed to start embedded engine:", err);
    });

    engineProcess.on("exit", (code) => {
        console.error(`Embedded engine exited with code ${code}`);
    });

    process.on("SIGINT", () => {
        if (engineProcess) engineProcess.kill("SIGINT");
        process.exit(0);
    });
    process.on("SIGTERM", () => {
        if (engineProcess) engineProcess.kill("SIGTERM");
        process.exit(0);
    });

    // Wait slightly to ensure startup
    await new Promise(resolve => setTimeout(resolve, 2000));
}

async function main() {
    await startEngine();

    client = new CueMap({ url: CUEMAP_URL });

    server.registerTool(
        "cuemap_init",
        {
            description: "Initialize a CueMap project for a given local repository path. This triggers the Self-Learning Agent to ingest the codebase. Call this if the user hasn't set up the project yet or if cuemap_recall returns empty.",
            inputSchema: z.object({
                path: z.string().describe("Absolute path to the local repository."),
                projectName: z.string().optional().describe("The ID of the project to create. Defaults to the folder name of the path.")
            })
        },
        async (args) => {
            try {
                const pName = args.projectName || path.basename(args.path);

                const projects = await client.listProjects();
                if (!projects.includes(pName)) {
                    await client.createProject(pName);
                }

                await client.setProjectWatchDir(pName, args.path);
                console.error(`Started ingestion for project ${pName} at ${args.path}`);

                // Polling for job completion
                let isComplete = false;
                let checks = 0;
                while (!isComplete && checks < 60) {
                    const status = await client.jobsStatus(pName);
                    if (status.phase === "idle") {
                        isComplete = true;
                        break;
                    }
                    checks++;
                    await new Promise(r => setTimeout(r, 1000));
                }

                if (isComplete) {
                    return {
                        content: [{ type: "text" as const, text: `Successfully initialized and ingested project ${pName}. You can now use cuemap_recall.` }]
                    };
                } else {
                    return {
                        content: [{ type: "text" as const, text: `Project ${pName} initialized, but ingestion is still actively running in the background. Partial results may be returned by cuemap_recall.` }]
                    };
                }
            } catch (error: any) {
                console.error("Error initializing CueMap project", error);
                return {
                    content: [{ type: "text" as const, text: `Error initializing project: ${error?.message || "Unknown error"}` }],
                    isError: true,
                };
            }
        }
    );

    server.registerTool(
        "cuemap_recall",
        {
            description: "Recall context about a codebase from a CueMap integerated brain. Uses natural language and semantic search to find relevant information.",
            inputSchema: z.object({
                query: z.string().describe("The natural language query to search the codebase memory for."),
                limit: z.number().optional().describe("Optional limit on the number of results to return. Default is 10."),
                projects: z.array(z.string()).optional().describe("Optional list of project IDs to scope the search to. Provide multiple for cross-project recall. If not provided, searches the default project."),
                cues: z.array(z.string()).optional().describe("Optional list of specific cues/tags to filter the search."),
                depth: z.number().optional().describe("Depth of multi-hop recall. Default is 1."),
                auto_reinforce: z.boolean().optional().describe("Automatically reinforce retrieved memories. Default is false."),
                min_intersection: z.number().optional().describe("Minimum intersection count for retrieval. Default is 0."),
                explain: z.boolean().optional().describe("Include explain component for debug information in results. Default is false."),
                disable_pattern_completion: z.boolean().optional().describe("Disable pattern completion inference. Default is false."),
                disable_salience_bias: z.boolean().optional().describe("Disable salience bias scoring. Default is false."),
                disable_systems_consolidation: z.boolean().optional().describe("Disable systems consolidation (exclude summaries). Default is false."),
                disable_alias_expansion: z.boolean().optional().describe("Disable alias expansion during querying. Default is false."),
            }),
        },
        async (args) => {
            try {
                const {
                    query, limit = 10, projects, cues,
                    depth = 1, auto_reinforce = false, min_intersection,
                    explain = false, disable_pattern_completion = false,
                    disable_salience_bias = false, disable_systems_consolidation = false,
                    disable_alias_expansion = false
                } = args;

                const results = await client.recall(
                    query,
                    cues,
                    projects,
                    limit,
                    depth,
                    auto_reinforce,
                    min_intersection,
                    explain,
                    disable_pattern_completion,
                    disable_salience_bias,
                    disable_systems_consolidation,
                    disable_alias_expansion
                );

                let items: any[] = [];

                if (results.results && Array.isArray(results.results)) {
                    if (results.results.length > 0 && results.results[0].project_id) {
                        results.results.forEach((projectRes: any) => {
                            if (projectRes.results && Array.isArray(projectRes.results)) {
                                items = items.concat(projectRes.results.map((r: any) => ({ ...r, project_id: projectRes.project_id })));
                            }
                        });
                    } else {
                        items = results.results;
                    }
                }

                if (!items || items.length === 0) {
                    return {
                        content: [
                            {
                                type: "text" as const,
                                text: "No results found for the query in CueMap.",
                            },
                        ],
                    };
                }

                let formattedText = `CueMap found ${items.length} relevant results:\n\n`;
                items.forEach((r: any, i: number) => {
                    const scoreStr = r.score !== undefined ? ` (Score: ${Number(r.score).toFixed(2)})` : '';
                    formattedText += `### Result ${i + 1}${scoreStr}\n`;
                    const projectId = r.project_id || (projects && projects.length === 1 ? projects[0] : null);
                    if (projectId) formattedText += `*Project: ${projectId}*\n`;
                    if (r.timestamp) {
                        const date = new Date(r.timestamp);
                        formattedText += `*Timestamp: ${date.toISOString()}*\n`;
                    } else if (r.created_at) {
                        const date = new Date(r.created_at * 1000);
                        formattedText += `*Timestamp: ${date.toISOString()}*\n`;
                    }

                    formattedText += `${r.content}\n\n`;
                });

                return {
                    content: [
                        {
                            type: "text" as const,
                            text: formattedText,
                        },
                    ],
                };
            } catch (error: any) {
                console.error("Error calling CueMap engine", error);
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: `Error executing cuemap_recall tool: ${error?.message || "Unknown error"}`,
                        },
                    ],
                    isError: true,
                };
            }
        }
    );

    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("CueMap MCP server running on stdio");
}

main().catch((error) => {
    console.error("Server error:", error);
    process.exit(1);
});
