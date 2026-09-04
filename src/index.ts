#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import CueMap from "cuemap";
import { EmbeddedCueMap } from "cuemap/embedded";
import { File } from "node:buffer";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import path from "path";
import { createHash } from "crypto";
import { spawnSync } from "child_process";
import { CueMapJobStatus, evaluateJobStatus } from "./job-status.js";

let embeddedEngine: EmbeddedCueMap | null = null;
let CUEMAP_URL = process.env.CUEMAP_URL;
let client: CueMap;
const observedJobActivity = new Map<string, boolean>();

function git(cwd: string, args: string[]): string {
    const result = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 1_500 });
    return result.status === 0 ? result.stdout.trim() : "";
}

function canonicalRemote(remote: string): string {
    return remote
        .replace(/^[^@\s]+@([^:]+):/, "ssh://$1/")
        .replace(/:\/\/[^/@]+@/, "://")
        .replace(/\.git$/, "")
        .replace(/\/+$/, "")
        .toLowerCase();
}

function defaultProjectId(cwd: string): string {
    if (process.env.CUEMAP_PROJECT) return process.env.CUEMAP_PROJECT;
    const root = git(cwd, ["rev-parse", "--show-toplevel"]) || cwd;
    const remote = canonicalRemote(git(root, ["remote", "get-url", "origin"]));
    const identity = remote || root;
    const slug = path.basename(root)
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, "-")
        .replace(/^-+|-+$/g, "") || "workspace";
    const digest = createHash("sha256").update(identity).digest("hex").slice(0, 10);
    return `repo-${slug.slice(0, 40)}-${digest}`.slice(0, 64);
}

const DEFAULT_PROJECT = defaultProjectId(process.cwd());

const server = new McpServer({
    name: "cuemap-mcp",
    version: "0.7.3",
});

async function startEngine(): Promise<void> {
    const configuredPort = process.env.CUEMAP_PORT
        ? Number.parseInt(process.env.CUEMAP_PORT, 10)
        : undefined;
    if (configuredPort !== undefined && (!Number.isInteger(configuredPort) || configuredPort < 1 || configuredPort > 65535)) {
        throw new Error("CUEMAP_PORT must be an integer between 1 and 65535");
    }

    embeddedEngine = await EmbeddedCueMap.start({
        url: CUEMAP_URL,
        binPath: process.env.CUEMAP_BIN,
        port: configuredPort,
        requiredCapabilities: [
            "repository_ingestion_scope_v1",
            "semantic_retrieval_v1",
            "chunk_embeddings_v1",
            "intent_classification_v1",
            "intent_job_status_v1",
            "project_lifecycle_v1",
            "project_packages_v1",
            "project_sync_v1",
        ],
        configPath: process.env.CUEMAP_CONFIG_PATH,
        apiKey: process.env.CUEMAP_API_KEY,
        logger: (message: string) => console.error(message),
    });
    CUEMAP_URL = embeddedEngine.url;
}

async function shutdown(signal: NodeJS.Signals): Promise<void> {
    try {
        await embeddedEngine?.stop();
    } finally {
        process.exit(signal === "SIGINT" ? 130 : 143);
    }
}

function projectClient(project?: string): CueMap {
    return new CueMap({
        url: CUEMAP_URL,
        apiKey: process.env.CUEMAP_API_KEY,
        projectId: project || DEFAULT_PROJECT,
    });
}

function jsonToolResult(value: unknown) {
    return {
        content: [{
            type: "text" as const,
            text: JSON.stringify(value, null, 2),
        }],
    };
}

function confirmationRequired(action: string) {
    return {
        content: [{
            type: "text" as const,
            text: `No changes were made because ${action} requires confirmed: true after explicit user confirmation.`,
        }],
    };
}

function toolError(toolName: string, error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error executing ${toolName}`, error);
    return {
        content: [{
            type: "text" as const,
            text: `Error executing ${toolName} tool: ${message || "Unknown error"}`,
        }],
        isError: true,
    };
}

async function engineRequest<T>(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    requestPath: string,
    body?: unknown,
    project?: string,
): Promise<T> {
    const response = await engineRawRequest(
        method,
        requestPath,
        body === undefined ? undefined : JSON.stringify(body),
        project,
        "application/json",
    );
    return await response.json() as T;
}

async function engineRawRequest(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    requestPath: string,
    body?: BodyInit,
    project?: string,
    contentType?: string,
): Promise<Response> {
    if (!CUEMAP_URL) throw new Error("CueMap engine URL is not available");
    const response = await fetch(`${CUEMAP_URL}${requestPath}`, {
        method,
        headers: {
            ...(body === undefined || !contentType ? {} : { "content-type": contentType }),
            ...(process.env.CUEMAP_API_KEY ? { "X-API-Key": process.env.CUEMAP_API_KEY } : {}),
            ...(project ? { "X-Project-ID": project } : {}),
        },
        ...(body === undefined ? {} : { body }),
    });
    if (!response.ok) {
        const message = await response.text();
        throw new Error(`CueMap returned HTTP ${response.status}: ${message}`);
    }
    return response;
}

async function main() {
    await startEngine();

    process.once("SIGINT", () => void shutdown("SIGINT"));
    process.once("SIGTERM", () => void shutdown("SIGTERM"));

    client = new CueMap({
        url: CUEMAP_URL,
        apiKey: process.env.CUEMAP_API_KEY,
        projectId: DEFAULT_PROJECT,
    });

    server.registerTool(
        "cuemap_init_preview",
        {
            description: "Preview supported repository files without ingesting content. Call this before first-time repository initialization, present the grouped paths to the user, and ask them to confirm or adjust the selection before calling cuemap_init.",
            inputSchema: z.object({
                path: z.string().describe("Absolute path to the repository root."),
                projectName: z.string().optional().describe("Optional project ID. Defaults to the stable repository-scoped CueMap project ID."),
                includedPaths: z.array(z.string()).optional().describe("Optional repository-relative files or folders to preview. Empty means every supported file allowed by ignore rules."),
                ignoredPatterns: z.array(z.string()).optional().describe("Optional additional gitignore-style exclusion patterns."),
                ignoredExtensions: z.array(z.string()).optional().describe("Optional additional excluded extensions without a leading dot."),
            }),
        },
        async (args) => {
            try {
                const project = args.projectName || defaultProjectId(args.path);
                const projects: any[] = await client.listProjects();
                const projectIds = projects.map((item: any) => typeof item === "string" ? item : item.project_id);
                let currentScope: any = null;
                if (projectIds.includes(project)) {
                    try {
                        currentScope = await engineRequest<any>(
                            "GET",
                            `/projects/${encodeURIComponent(project)}/watch-dir`,
                        );
                    } catch {
                        currentScope = null;
                    }
                }

                const preview = await engineRequest<any>("POST", "/ingest/directory/preview", {
                    watch_dir: args.path,
                    included_paths: args.includedPaths,
                    ignored_patterns: args.ignoredPatterns,
                    ignored_extensions: args.ignoredExtensions,
                });
                return {
                    content: [{
                        type: "text" as const,
                        text: JSON.stringify({
                            project_id: project,
                            current_scope: currentScope,
                            selection_semantics: "included_paths are repository-relative files or folders; an empty list selects all supported files allowed by ignore rules",
                            preview,
                        }, null, 2),
                    }],
                };
            } catch (error: any) {
                console.error("Error previewing CueMap initialization", error);
                return {
                    content: [{
                        type: "text" as const,
                        text: `Error previewing repository ingestion: ${error?.message || "Unknown error"}`,
                    }],
                    isError: true,
                };
            }
        },
    );

    server.registerTool(
        "cuemap_init",
        {
            description: "Apply a user-confirmed repository ingestion scope and start CueMap's incremental filesystem watcher. Always call cuemap_init_preview first for a new repository and obtain explicit user confirmation before setting confirmed=true.",
            inputSchema: z.object({
                path: z.string().describe("Absolute path to the repository root."),
                projectName: z.string().optional().describe("Optional project ID. Defaults to the stable repository-scoped CueMap project ID."),
                includedPaths: z.array(z.string()).optional().describe("User-approved repository-relative files or folders. Empty means every supported file allowed by ignore rules."),
                ignoredPatterns: z.array(z.string()).optional().describe("Additional gitignore-style exclusion patterns approved by the user."),
                ignoredExtensions: z.array(z.string()).optional().describe("Additional excluded extensions without a leading dot."),
                confirmed: z.boolean().describe("Must be true only after the user explicitly confirms the previewed ingestion scope."),
            })
        },
        async (args) => {
            try {
                if (!args.confirmed) {
                    return {
                        content: [{ type: "text" as const, text: "No repository files were ingested because the proposed scope was not confirmed." }],
                    };
                }

                const pName = args.projectName || defaultProjectId(args.path);

                const projects: any[] = await client.listProjects();
                const projectIds = projects.map((p: any) => typeof p === 'string' ? p : p.project_id);
                if (!projectIds.includes(pName)) {
                    await client.createProject(pName);
                }

                await engineRequest<any>(
                    "POST",
                    `/projects/${encodeURIComponent(pName)}/watch-dir`,
                    {
                        watch_dir: args.path,
                        included_paths: args.includedPaths,
                        ignored_patterns: args.ignoredPatterns,
                        ignored_extensions: args.ignoredExtensions,
                    },
                );
                console.error(`Started ingestion for project ${pName} at ${args.path}`);
                observedJobActivity.set(pName, false);

                // Polling for job completion
                let isComplete = false;
                let checks = 0;
                let lastStatus: CueMapJobStatus | null = null;
                while (!isComplete && checks < 60) {
                    const status = await client.jobsStatus(pName) as CueMapJobStatus;
                    lastStatus = status;
                    const evaluation = evaluateJobStatus(
                        status,
                        observedJobActivity.get(pName),
                    );
                    observedJobActivity.set(pName, evaluation.observed_activity);
                    if (evaluation.verified_complete) {
                        isComplete = true;
                        break;
                    }
                    checks++;
                    await new Promise(r => setTimeout(r, 1000));
                }

                if (isComplete) {
                    return {
                        content: [{
                            type: "text" as const,
                            text: `Successfully initialized and ingested project ${pName}. CueMap observed ingestion activity, reached a terminal job phase, and completed memory intent annotation. The watcher will automatically ingest new or changed supported files within the approved scope. You can now use cuemap_recall.`,
                        }]
                    };
                } else {
                    return {
                        content: [{
                            type: "text" as const,
                            text: `Project ${pName} initialized with the approved scope, but ingestion has not reached a verified terminal state. Last job status: ${JSON.stringify(lastStatus)}. Call cuemap_status periodically until verified_complete is true. The watcher is active and partial results may be returned by cuemap_recall.`,
                        }]
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
        "cuemap_add",
        {
            description: "Store a natural-language memory in CueMap. Uses the repository-scoped default project unless one is supplied, creates it when needed, and applies deterministic cue extraction plus any cues and metadata.",
            inputSchema: z.object({
                content: z.string().min(1).describe("The natural-language memory content to store."),
                project: z.string().min(1).optional().describe("Optional project ID. Defaults to a stable ID derived from the current Git repository."),
                cues: z.array(z.string()).optional().describe("Optional explicit cues/tags to associate with the memory."),
                metadata: z.record(z.string(), z.unknown()).optional().describe("Optional JSON metadata to store with the memory."),
                source_key: z.string().optional().describe("Optional stable source key for deterministic upsert/deduplication."),
                event_time: z.number().nonnegative().optional().describe("Optional original event timestamp as Unix seconds. Defaults to ingestion time."),
                embedding: z.array(z.number()).nonempty().optional().describe("Optional precomputed memory embedding."),
                disable_temporal_chunking: z.boolean().optional().describe("Disable temporal chunking for this memory. Default is false."),
                async_ingest: z.boolean().optional().describe("Process ingestion in the background and return immediately. Default is false."),
            })
        },
        async (args) => {
            try {
                const project = args.project || DEFAULT_PROJECT;
                const projects: any[] = await client.listProjects();
                const projectIds = projects.map((p: any) => typeof p === "string" ? p : p.project_id);
                if (!projectIds.includes(project)) {
                    await client.createProject(project);
                }

                const projectClient = new CueMap({
                    url: CUEMAP_URL,
                    apiKey: process.env.CUEMAP_API_KEY,
                    projectId: project,
                });
                const memoryId = await projectClient.add(
                    args.content,
                    args.cues || [],
                    args.metadata,
                    args.disable_temporal_chunking || false,
                    {
                        sourceKey: args.source_key,
                        eventTime: args.event_time,
                        embedding: args.embedding,
                        asyncIngest: args.async_ingest,
                    }
                );

                return {
                    content: [{
                        type: "text" as const,
                        text: `Stored memory ${memoryId} in CueMap project ${project}.`,
                    }],
                };
            } catch (error: any) {
                console.error("Error adding CueMap memory", error);
                return {
                    content: [{
                        type: "text" as const,
                        text: `Error executing cuemap_add tool: ${error?.message || "Unknown error"}`,
                    }],
                    isError: true,
                };
            }
        }
    );

    server.registerTool(
        "cuemap_intent_classify",
        {
            description: "Classify text with CueMap's local intent model and return recall/memory eligibility signals. Scores are ranking signals, not calibrated probabilities.",
            inputSchema: z.object({
                text: z.string().min(1),
                target: z.enum(["query", "memory"]).optional().describe("Classification target. Default is query."),
                project: z.string().min(1).optional().describe("Optional project ID. Defaults to the repository-scoped project."),
            }),
        },
        async (args) => {
            try {
                return jsonToolResult(await projectClient(args.project).classifyIntent(
                    args.text,
                    args.target || "query",
                ));
            } catch (error) {
                return toolError("cuemap_intent_classify", error);
            }
        },
    );

    server.registerTool(
        "cuemap_status",
        {
            description: "Check CueMap background ingestion progress for a project. After cuemap_init, poll this tool until verified_complete is true. An initial idle status with 0/0 writes is not proof that ingestion completed.",
            inputSchema: z.object({
                project: z.string().min(1).optional().describe("Optional project ID. Defaults to the stable repository-scoped CueMap project ID."),
            }),
        },
        async (args) => {
            try {
                const project = args.project || DEFAULT_PROJECT;
                const status = await client.jobsStatus(project) as CueMapJobStatus;
                const evaluation = evaluateJobStatus(
                    status,
                    observedJobActivity.get(project),
                );
                observedJobActivity.set(project, evaluation.observed_activity);

                return {
                    content: [{
                        type: "text" as const,
                        text: JSON.stringify({
                            project_id: project,
                            ...status,
                            ...evaluation,
                        }, null, 2),
                    }],
                };
            } catch (error: any) {
                console.error("Error checking CueMap status", error);
                return {
                    content: [{
                        type: "text" as const,
                        text: `Error executing cuemap_status tool: ${error?.message || "Unknown error"}`,
                    }],
                    isError: true,
                };
            }
        },
    );

    server.registerTool(
        "cuemap_projects",
        {
            description: "List CueMap projects, summary metadata, and whether each project is currently loaded in RAM.",
            inputSchema: z.object({}),
        },
        async () => {
            try {
                return jsonToolResult(await client.listProjects());
            } catch (error) {
                return toolError("cuemap_projects", error);
            }
        },
    );

    server.registerTool(
        "cuemap_project_save",
        {
            description: "Persist the current state of a CueMap project without unloading it. Package operations save automatically; use this only when an explicit durable checkpoint is useful.",
            inputSchema: z.object({
                project: z.string().min(1).optional().describe("Project ID to save. Defaults to the repository-scoped project."),
            }),
        },
        async (args) => {
            try {
                const project = args.project || DEFAULT_PROJECT;
                return jsonToolResult(await engineRequest(
                    "POST",
                    `/projects/${encodeURIComponent(project)}/save`,
                    undefined,
                    project,
                ));
            } catch (error) {
                return toolError("cuemap_project_save", error);
            }
        },
    );

    server.registerTool(
        "cuemap_project_load",
        {
            description: "Load a persisted CueMap project into RAM before a latency-sensitive operation. Normal project requests load automatically, so use this for explicit warm-up.",
            inputSchema: z.object({
                project: z.string().min(1).optional().describe("Project ID to load. Defaults to the repository-scoped project."),
            }),
        },
        async (args) => {
            try {
                const project = args.project || DEFAULT_PROJECT;
                return jsonToolResult(await engineRequest(
                    "POST",
                    `/projects/${encodeURIComponent(project)}/load`,
                    undefined,
                    project,
                ));
            } catch (error) {
                return toolError("cuemap_project_load", error);
            }
        },
    );

    server.registerTool(
        "cuemap_project_unload",
        {
            description: "Persist and unload a CueMap project from RAM to reduce memory use. Use only when the user explicitly asks to unload or free inactive project memory; active projects return a retryable busy error.",
            inputSchema: z.object({
                project: z.string().min(1).optional().describe("Project ID to unload. Defaults to the repository-scoped project."),
            }),
        },
        async (args) => {
            try {
                const project = args.project || DEFAULT_PROJECT;
                return jsonToolResult(await engineRequest(
                    "POST",
                    `/projects/${encodeURIComponent(project)}/unload`,
                    undefined,
                    project,
                ));
            } catch (error) {
                return toolError("cuemap_project_unload", error);
            }
        },
    );

    server.registerTool(
        "cuemap_project_pack",
        {
            description: "Write a ready-to-query .cuemap package for one project to a local file. The package contains sensitive project content; use only after the user explicitly approves the exact output path.",
            inputSchema: z.object({
                project: z.string().min(1).optional().describe("Project ID to package. Defaults to the repository-scoped project."),
                output_path: z.string().min(1).describe("Absolute local path for the .cuemap file."),
                overwrite: z.boolean().optional().describe("Replace an existing output file. Default is false."),
                confirmed: z.boolean().optional().describe("Must be true after explicit user approval of the output path and any overwrite."),
            }),
        },
        async (args) => {
            if (!args.confirmed) return confirmationRequired("project packaging");
            try {
                if (!path.isAbsolute(args.output_path)) {
                    throw new Error("output_path must be absolute");
                }
                const project = args.project || DEFAULT_PROJECT;
                const response = await engineRawRequest(
                    "POST",
                    `/projects/${encodeURIComponent(project)}/pack`,
                    undefined,
                    project,
                );
                const packageData = Buffer.from(await response.arrayBuffer());
                writeFileSync(args.output_path, packageData, {
                    flag: args.overwrite ? "w" : "wx",
                });
                return jsonToolResult({
                    status: "packed",
                    project_id: project,
                    output_path: args.output_path,
                    size_bytes: packageData.byteLength,
                });
            } catch (error) {
                return toolError("cuemap_project_pack", error);
            }
        },
    );

    server.registerTool(
        "cuemap_project_package_load",
        {
            description: "Install and warm a local .cuemap package. Use only after the user explicitly approves the exact package path; existing projects are never overwritten.",
            inputSchema: z.object({
                package_path: z.string().min(1).describe("Absolute local path to the .cuemap package."),
                confirmed: z.boolean().optional().describe("Must be true after explicit user approval of the package path."),
            }),
        },
        async (args) => {
            if (!args.confirmed) return confirmationRequired("project package loading");
            try {
                if (!path.isAbsolute(args.package_path)) {
                    throw new Error("package_path must be absolute");
                }
                const stats = statSync(args.package_path);
                if (!stats.isFile()) throw new Error("package_path must reference a regular file");
                const response = await engineRawRequest(
                    "POST",
                    "/projects/load",
                    readFileSync(args.package_path),
                    undefined,
                    "application/vnd.cuemap.project",
                );
                return jsonToolResult(await response.json());
            } catch (error) {
                return toolError("cuemap_project_package_load", error);
            }
        },
    );

    server.registerTool(
        "cuemap_project_push",
        {
            description: "Pack and upload a CueMap project with the engine host's configured AWS CLI. Use only after explicit approval of the exact S3 destination; an existing object at that URI may be replaced.",
            inputSchema: z.object({
                project: z.string().min(1).optional().describe("Project ID to push. Defaults to the repository-scoped project."),
                destination: z.string().startsWith("s3://").describe("Exact S3 object URI or prefix."),
                confirmed: z.boolean().optional().describe("Must be true after explicit user approval of the S3 destination."),
            }),
        },
        async (args) => {
            if (!args.confirmed) return confirmationRequired("project package upload");
            try {
                const project = args.project || DEFAULT_PROJECT;
                return jsonToolResult(await engineRequest(
                    "POST",
                    `/projects/${encodeURIComponent(project)}/push`,
                    { destination: args.destination },
                    project,
                ));
            } catch (error) {
                return toolError("cuemap_project_push", error);
            }
        },
    );

    server.registerTool(
        "cuemap_project_pull",
        {
            description: "Download, install, and warm a .cuemap package with the engine host's configured AWS CLI. Use only after explicit approval of the exact S3 source; existing projects are never overwritten.",
            inputSchema: z.object({
                source: z.string().startsWith("s3://").describe("Exact S3 object URI for a .cuemap package."),
                confirmed: z.boolean().optional().describe("Must be true after explicit user approval of the S3 source."),
            }),
        },
        async (args) => {
            if (!args.confirmed) return confirmationRequired("project package download and load");
            try {
                return jsonToolResult(await engineRequest(
                    "POST",
                    "/projects/pull",
                    { source: args.source },
                ));
            } catch (error) {
                return toolError("cuemap_project_pull", error);
            }
        },
    );

    server.registerTool(
        "cuemap_project_sync",
        {
            description: "Fast-forward a project through immutable history at an S3 sync root. Pushes local-only changes, pulls remote-only changes, and refuses divergent histories or stale concurrent writes. Use only after explicit approval of the project and exact S3 root.",
            inputSchema: z.object({
                project: z.string().min(1).optional().describe("Project ID to synchronize. Defaults to the repository-scoped project."),
                remote: z.string().startsWith("s3://").describe("Exact S3 root used for this project's sync history."),
                confirmed: z.boolean().optional().describe("Must be true after explicit user approval of the project and S3 sync root."),
            }),
        },
        async (args) => {
            if (!args.confirmed) return confirmationRequired("project synchronization");
            try {
                const project = args.project || DEFAULT_PROJECT;
                return jsonToolResult(await engineRequest(
                    "POST",
                    `/projects/${encodeURIComponent(project)}/sync`,
                    { remote: args.remote },
                    project,
                ));
            } catch (error) {
                return toolError("cuemap_project_sync", error);
            }
        },
    );

    server.registerTool(
        "cuemap_stats",
        {
            description: "Read CueMap statistics for the repository-scoped project or globally across the engine.",
            inputSchema: z.object({
                project: z.string().min(1).optional().describe("Optional project ID. Defaults to the repository-scoped project."),
                global: z.boolean().optional().describe("Return global engine statistics instead of project statistics. Default is false."),
            }),
        },
        async (args) => {
            try {
                if (args.global && args.project) {
                    throw new Error("project and global cannot be supplied together");
                }
                const project = args.global ? undefined : (args.project || DEFAULT_PROJECT);
                return jsonToolResult(await engineRequest("GET", "/stats", undefined, project));
            } catch (error) {
                return toolError("cuemap_stats", error);
            }
        },
    );

    server.registerTool(
        "cuemap_memory_get",
        {
            description: "Get one CueMap memory by numeric ID.",
            inputSchema: z.object({
                memory_id: z.number().int().nonnegative().max(4_294_967_295),
                project: z.string().min(1).optional().describe("Optional project ID. Defaults to the repository-scoped project."),
            }),
        },
        async (args) => {
            try {
                const project = args.project || DEFAULT_PROJECT;
                return jsonToolResult(await engineRequest(
                    "GET",
                    `/memories/${args.memory_id}`,
                    undefined,
                    project,
                ));
            } catch (error) {
                return toolError("cuemap_memory_get", error);
            }
        },
    );

    server.registerTool(
        "cuemap_memory_reinforce",
        {
            description: "Reinforce one CueMap memory, optionally along specific cue pathways.",
            inputSchema: z.object({
                memory_id: z.number().int().nonnegative().max(4_294_967_295),
                cues: z.array(z.string().min(1)).optional(),
                project: z.string().min(1).optional().describe("Optional project ID. Defaults to the repository-scoped project."),
            }),
        },
        async (args) => {
            try {
                const project = args.project || DEFAULT_PROJECT;
                return jsonToolResult(await engineRequest(
                    "PATCH",
                    `/memories/${args.memory_id}/reinforce`,
                    { cues: args.cues || [] },
                    project,
                ));
            } catch (error) {
                return toolError("cuemap_memory_reinforce", error);
            }
        },
    );

    server.registerTool(
        "cuemap_memory_delete",
        {
            description: "Permanently delete one CueMap memory. Set confirmed=true only after explicit user confirmation.",
            inputSchema: z.object({
                memory_id: z.number().int().nonnegative().max(4_294_967_295),
                project: z.string().min(1).optional().describe("Optional project ID. Defaults to the repository-scoped project."),
                confirmed: z.boolean().describe("Must be true only after the user explicitly confirms permanent deletion."),
            }),
        },
        async (args) => {
            if (!args.confirmed) return confirmationRequired("memory deletion");
            try {
                const project = args.project || DEFAULT_PROJECT;
                return jsonToolResult(await engineRequest(
                    "DELETE",
                    `/memories/${args.memory_id}`,
                    undefined,
                    project,
                ));
            } catch (error) {
                return toolError("cuemap_memory_delete", error);
            }
        },
    );

    server.registerTool(
        "cuemap_ingest_url",
        {
            description: "Explicitly ingest content from a URL, optionally crawling same-domain links. Use only when the user asks to ingest that URL.",
            inputSchema: z.object({
                url: z.string().url(),
                depth: z.number().int().nonnegative().max(10).optional().describe("Crawl depth. Zero ingests only the supplied page."),
                same_domain_only: z.boolean().optional().describe("Restrict recursive crawling to the starting domain. Default is true."),
                project: z.string().min(1).optional().describe("Optional project ID. Defaults to the repository-scoped project."),
            }),
        },
        async (args) => {
            try {
                const result = await projectClient(args.project).ingestUrl(
                    args.url,
                    args.depth || 0,
                    args.same_domain_only ?? true,
                );
                return jsonToolResult(result);
            } catch (error) {
                return toolError("cuemap_ingest_url", error);
            }
        },
    );

    server.registerTool(
        "cuemap_ingest_content",
        {
            description: "Explicitly ingest supplied raw content into CueMap. Use only when the user asks to persist that content.",
            inputSchema: z.object({
                content: z.string().min(1),
                filename: z.string().min(1).optional().describe("Logical source filename used for type detection. Default is content.txt."),
                source_key: z.string().optional().describe("Stable source key for deterministic replacement or deduplication."),
                metadata: z.record(z.string(), z.unknown()).optional(),
                structural_cues: z.array(z.string()).optional(),
                embeddings: z.array(z.array(z.number()).nonempty()).optional().describe("Optional one-vector-per-produced-chunk embeddings."),
                segmenter: z.enum(["sentence_window", "logical_block"]).optional(),
                segment_window_size: z.number().int().positive().optional(),
                segment_overlap: z.number().int().nonnegative().optional(),
                segment_min_chunk_chars: z.number().int().positive().optional(),
                segment_max_chunk_chars: z.number().int().positive().optional(),
                project: z.string().min(1).optional().describe("Optional project ID. Defaults to the repository-scoped project."),
            }),
        },
        async (args) => {
            try {
                const result = await projectClient(args.project).ingestContent(
                    args.content,
                    args.filename || "content.txt",
                    {
                        sourceKey: args.source_key,
                        metadata: args.metadata,
                        structuralCues: args.structural_cues,
                        embeddings: args.embeddings,
                        segmenter: args.segmenter,
                        segmentWindowSize: args.segment_window_size,
                        segmentOverlap: args.segment_overlap,
                        segmentMinChunkChars: args.segment_min_chunk_chars,
                        segmentMaxChunkChars: args.segment_max_chunk_chars,
                    },
                );
                return jsonToolResult(result);
            } catch (error) {
                return toolError("cuemap_ingest_content", error);
            }
        },
    );

    server.registerTool(
        "cuemap_ingest_file",
        {
            description: "Explicitly ingest one local file into CueMap. Use only for a file the user has placed in scope and asked to ingest.",
            inputSchema: z.object({
                path: z.string().min(1).describe("Absolute or repository-relative path to the file."),
                project: z.string().min(1).optional().describe("Optional project ID. Defaults to the repository-scoped project."),
            }),
        },
        async (args) => {
            try {
                const filePath = path.resolve(args.path);
                if (!statSync(filePath).isFile()) {
                    throw new Error(`Not a regular file: ${filePath}`);
                }
                const file = new File(
                    [readFileSync(filePath)],
                    path.basename(filePath),
                    { type: "application/octet-stream" },
                );
                return jsonToolResult(await projectClient(args.project).ingestFile(file));
            } catch (error) {
                return toolError("cuemap_ingest_file", error);
            }
        },
    );

    server.registerTool(
        "cuemap_project_export",
        {
            description: "Export a cursor-paginated page of memories from a CueMap project.",
            inputSchema: z.object({
                project: z.string().min(1).optional().describe("Optional project ID. Defaults to the repository-scoped project."),
                cursor: z.union([z.number().int().nonnegative(), z.string().min(1)]).optional(),
                limit: z.number().int().positive().max(10_000).optional(),
                include_content: z.boolean().optional(),
                include_cues: z.boolean().optional(),
                include_metadata: z.boolean().optional(),
            }),
        },
        async (args) => {
            try {
                const project = args.project || DEFAULT_PROJECT;
                return jsonToolResult(await projectClient(project).exportProject(project, {
                    cursor: args.cursor,
                    limit: args.limit,
                    includeContent: args.include_content,
                    includeCues: args.include_cues,
                    includeMetadata: args.include_metadata,
                }));
            } catch (error) {
                return toolError("cuemap_project_export", error);
            }
        },
    );

    server.registerTool(
        "cuemap_project_artifacts",
        {
            description: "Inspect CueBridge artifact metadata for a CueMap project without reloading or mutating it.",
            inputSchema: z.object({
                project: z.string().min(1).optional().describe("Optional project ID. Defaults to the repository-scoped project."),
            }),
        },
        async (args) => {
            try {
                const project = args.project || DEFAULT_PROJECT;
                return jsonToolResult(await projectClient(project).projectArtifacts(project));
            } catch (error) {
                return toolError("cuemap_project_artifacts", error);
            }
        },
    );

    server.registerTool(
        "cuemap_alias_list",
        {
            description: "List manual cue aliases associated with one cue.",
            inputSchema: z.object({
                cue: z.string().min(1),
                project: z.string().min(1).optional().describe("Optional project ID. Defaults to the repository-scoped project."),
            }),
        },
        async (args) => {
            try {
                return jsonToolResult(await projectClient(args.project).getAliases(args.cue));
            } catch (error) {
                return toolError("cuemap_alias_list", error);
            }
        },
    );

    server.registerTool(
        "cuemap_alias_add",
        {
            description: "Add a manual weighted mapping from one cue to another.",
            inputSchema: z.object({
                from: z.string().min(1),
                to: z.string().min(1),
                weight: z.number().min(0).max(1).optional().describe("Association weight from 0 to 1. Default is 1."),
                project: z.string().min(1).optional().describe("Optional project ID. Defaults to the repository-scoped project."),
            }),
        },
        async (args) => {
            try {
                const added = await projectClient(args.project).addAlias(
                    args.from,
                    args.to,
                    args.weight ?? 1,
                );
                if (!added) throw new Error("CueMap rejected the alias mapping");
                return jsonToolResult({ added: true, from: args.from, to: args.to, weight: args.weight ?? 1 });
            } catch (error) {
                return toolError("cuemap_alias_add", error);
            }
        },
    );

    server.registerTool(
        "cuemap_alias_merge",
        {
            description: "Merge multiple cues into one canonical cue. Set confirmed=true only after explicit user confirmation.",
            inputSchema: z.object({
                cues: z.array(z.string().min(1)).min(2),
                to: z.string().min(1),
                project: z.string().min(1).optional().describe("Optional project ID. Defaults to the repository-scoped project."),
                confirmed: z.boolean().describe("Must be true only after the user explicitly confirms the merge."),
            }),
        },
        async (args) => {
            if (!args.confirmed) return confirmationRequired("alias merging");
            try {
                const merged = await projectClient(args.project).mergeAliases(args.cues, args.to);
                if (!merged) throw new Error("CueMap rejected the alias merge");
                return jsonToolResult({ merged: true, cues: args.cues, to: args.to });
            } catch (error) {
                return toolError("cuemap_alias_merge", error);
            }
        },
    );

    server.registerTool(
        "cuemap_lexicon_inspect",
        {
            description: "Inspect one cue and its Lexicon relationships.",
            inputSchema: z.object({
                cue: z.string().min(1),
                project: z.string().min(1).optional().describe("Optional project ID. Defaults to the repository-scoped project."),
            }),
        },
        async (args) => {
            try {
                return jsonToolResult(await projectClient(args.project).lexiconInspect(args.cue));
            } catch (error) {
                return toolError("cuemap_lexicon_inspect", error);
            }
        },
    );

    server.registerTool(
        "cuemap_lexicon_graph",
        {
            description: "Read the current Lexicon graph for a project.",
            inputSchema: z.object({
                project: z.string().min(1).optional().describe("Optional project ID. Defaults to the repository-scoped project."),
            }),
        },
        async (args) => {
            try {
                return jsonToolResult(await projectClient(args.project).lexiconGraph());
            } catch (error) {
                return toolError("cuemap_lexicon_graph", error);
            }
        },
    );

    server.registerTool(
        "cuemap_lexicon_wire",
        {
            description: "Manually wire a token to a canonical Lexicon cue.",
            inputSchema: z.object({
                token: z.string().min(1),
                canonical: z.string().min(1),
                project: z.string().min(1).optional().describe("Optional project ID. Defaults to the repository-scoped project."),
            }),
        },
        async (args) => {
            try {
                return jsonToolResult(await projectClient(args.project).lexiconWire(
                    args.token,
                    args.canonical,
                ));
            } catch (error) {
                return toolError("cuemap_lexicon_wire", error);
            }
        },
    );

    server.registerTool(
        "cuemap_lexicon_delete",
        {
            description: "Permanently delete one Lexicon entry. Set confirmed=true only after explicit user confirmation.",
            inputSchema: z.object({
                entry_id: z.union([z.number().int().nonnegative(), z.string().min(1)]),
                project: z.string().min(1).optional().describe("Optional project ID. Defaults to the repository-scoped project."),
                confirmed: z.boolean().describe("Must be true only after the user explicitly confirms permanent deletion."),
            }),
        },
        async (args) => {
            if (!args.confirmed) return confirmationRequired("Lexicon entry deletion");
            try {
                const deleted = await projectClient(args.project).lexiconDelete(String(args.entry_id));
                if (!deleted) throw new Error("CueMap did not delete the Lexicon entry");
                return jsonToolResult({ deleted: true, entry_id: args.entry_id });
            } catch (error) {
                return toolError("cuemap_lexicon_delete", error);
            }
        },
    );

    server.registerTool(
        "cuemap_recall",
        {
            description: "Recall ranked context from CueMap using lexical, semantic, or hybrid query signals. Hybrid is the engine default and uses the configured local encoder to rerank lexical candidates.",
            inputSchema: z.object({
                query: z.string().describe("The natural language query to search the codebase memory for."),
                limit: z.number().optional().describe("Optional limit on the number of results to return. Default is 10."),
                projects: z.array(z.string()).optional().describe("Optional list of project IDs to scope the search to. Provide multiple for cross-project recall. If not provided, searches the default project."),
                cues: z.array(z.string()).optional().describe("Optional list of specific cues/tags to filter the search."),
                query_time: z.string().optional().describe("Optional timestamp or natural-language time anchor used by v0.7 temporal query intent."),
                depth: z.number().optional().describe("Depth of multi-hop recall. Default is 1."),
                expansion_depth: z.number().optional().describe("Alias/cue expansion depth. Default is 1."),
                auto_reinforce: z.boolean().optional().describe("Automatically reinforce retrieved memories. Default is false."),
                min_intersection: z.number().optional().describe("Minimum intersection count for retrieval. Default is 0."),
                explain: z.boolean().optional().describe("Include explain component for debug information in results. Default is false."),
                trace_timing: z.boolean().optional().describe("Include v0.7 timing diagnostics in the response. Default is false."),
                disable_salience_bias: z.boolean().optional().describe("Disable salience bias scoring. Default is false."),
                disable_alias_expansion: z.boolean().optional().describe("Disable alias expansion during querying. Default is true."),
                parent_fusion: z.enum(["off", "auto", "force"]).optional().describe("Parent fusion mode for chunk-parent reconstruction. Default is off."),
                parent_fusion_limit: z.number().optional().describe("Candidate limit for parent fusion. Default is 80."),
                parent_fusion_min_chunks: z.number().optional().describe("Minimum sibling chunks required for parent fusion. Default is 2."),
                ordered_reconstruction: z.enum(["off", "auto", "force"]).optional().describe("Ordered session reconstruction mode. Default is off."),
                ordered_reconstruction_limit: z.number().optional().describe("Result scan limit for ordered reconstruction. Default is 80."),
                ordered_session_scan_limit: z.number().optional().describe("Per-session scan limit for ordered reconstruction. Default is 4096."),
                ordered_max_sessions: z.number().optional().describe("Maximum sessions considered for ordered reconstruction. Default is 3."),
                evidence_coverage: z.enum(["off", "auto", "force"]).optional().describe("Evidence coverage mode for multi-evidence answers. Default is off."),
                evidence_coverage_limit: z.number().optional().describe("Result scan limit for evidence coverage. Default is 100."),
                evidence_coverage_session_scan_limit: z.number().optional().describe("Per-session scan limit for evidence coverage. Default is 4096."),
                evidence_coverage_max_sessions: z.number().optional().describe("Maximum sessions considered for evidence coverage. Default is 3."),
                disable_cuebridge_artifacts: z.boolean().optional().describe("Disable CueBridge artifact expansion. Default is false."),
                cuebridge_gap_limit: z.number().optional().describe("Maximum CueBridge gap expansions. Default is 6."),
                semantic_mode: z.enum(["lexical", "semantic", "hybrid"]).optional().describe("Query signal mode. lexical uses cue recall only, semantic uses vector candidate discovery, and hybrid reranks lexical candidates. Default is hybrid."),
                query_embedding: z.array(z.number()).optional().describe("Optional precomputed query vector. Use this when the application owns the embedding provider."),
            }),
        },
        async (args) => {
            try {
                const {
                    query, limit = 10, projects, cues, query_time,
                    depth = 1, expansion_depth = 1, auto_reinforce = false, min_intersection,
                    explain = false, trace_timing = false,
                    disable_salience_bias = false, disable_alias_expansion = true,
                    parent_fusion = "off", parent_fusion_limit = 80,
                    parent_fusion_min_chunks = 2, ordered_reconstruction = "off",
                    ordered_reconstruction_limit = 80, ordered_session_scan_limit = 4096,
                    ordered_max_sessions = 3, evidence_coverage = "off",
                    evidence_coverage_limit = 100, evidence_coverage_session_scan_limit = 4096,
                    evidence_coverage_max_sessions = 3, disable_cuebridge_artifacts = false,
                    cuebridge_gap_limit = 6, semantic_mode = "hybrid", query_embedding
                } = args;

                const results = await client.recall({
                    query_text: query,
                    cues,
                    projects,
                    limit,
                    depth,
                    query_time,
                    expansion_depth,
                    auto_reinforce,
                    min_intersection,
                    explain,
                    trace_timing,
                    disable_salience_bias,
                    disable_alias_expansion,
                    parent_fusion,
                    parent_fusion_limit,
                    parent_fusion_min_chunks,
                    ordered_reconstruction,
                    ordered_reconstruction_limit,
                    ordered_session_scan_limit,
                    ordered_max_sessions,
                    evidence_coverage,
                    evidence_coverage_limit,
                    evidence_coverage_session_scan_limit,
                    evidence_coverage_max_sessions,
                    disable_cuebridge_artifacts,
                    cuebridge_gap_limit,
                    semantic_mode,
                    query_embedding,
                } as any);

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

                let formattedText = `CueMap found ${items.length} relevant memories:\n\n`;
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
    console.error(`CueMap MCP server running on stdio (default project: ${DEFAULT_PROJECT})`);
}

main().catch((error) => {
    console.error("Server error:", error);
    process.exit(1);
});
