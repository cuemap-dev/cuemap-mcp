const assert = require("node:assert/strict");
const { createServer } = require("node:http");
const { mkdtempSync, rmSync, statSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const test = require("node:test");

const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");

async function freePort() {
    const server = createServer();
    await new Promise((resolvePromise, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolvePromise);
    });
    const address = server.address();
    const port = address.port;
    await new Promise((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
    return port;
}

function textOf(result) {
    return (result.content || [])
        .filter((item) => item.type === "text")
        .map((item) => item.text)
        .join("\n");
}

const requiredTools = [
    "cuemap_init_preview", "cuemap_init", "cuemap_add", "cuemap_intent_classify",
    "cuemap_status", "cuemap_projects", "cuemap_project_save",
    "cuemap_project_load", "cuemap_project_unload", "cuemap_project_pack",
    "cuemap_project_package_load", "cuemap_project_push", "cuemap_project_pull",
    "cuemap_project_sync",
    "cuemap_stats", "cuemap_memory_get",
    "cuemap_memory_reinforce", "cuemap_memory_delete", "cuemap_ingest_url",
    "cuemap_ingest_content", "cuemap_ingest_file", "cuemap_project_export",
    "cuemap_project_artifacts", "cuemap_alias_list", "cuemap_alias_add",
    "cuemap_alias_merge", "cuemap_lexicon_inspect", "cuemap_lexicon_graph",
    "cuemap_lexicon_wire", "cuemap_lexicon_delete", "cuemap_recall",
];

test("serves the packed MCP protocol against a real release engine", {
    skip: process.env.CUEMAP_E2E !== "1",
}, async (context) => {
    const dataDir = mkdtempSync(join(tmpdir(), "cuemap-mcp-e2e-data-"));
    const repoDir = mkdtempSync(join(tmpdir(), "cuemap-mcp-e2e-repo-"));
    writeFileSync(join(repoDir, "README.md"), "The billing migration uses Postgres.\n");
    const project = `mcp-e2e-${process.pid}`;
    const port = await freePort();
    const binary = process.env.CUEMAP_E2E_BIN || resolve(__dirname, "../../rust_engine/target/release/cuemap");
    const serverPath = resolve(__dirname, "../build/index.js");
    const client = new Client({ name: "cuemap-mcp-e2e", version: "0.7.3" });
    const transport = new StdioClientTransport({
        command: process.execPath,
        args: [serverPath],
        cwd: resolve(__dirname, ".."),
        env: {
            ...process.env,
            CUEMAP_BIN: binary,
            CUEMAP_PORT: String(port),
            CUEMAP_DATA_DIR: dataDir,
            CUEMAP_PROJECT: project,
            CUEMAP_SNAPSHOT_INTERVAL_SECONDS: "3600",
            CUEMAP_LOG_PATH: join(dataDir, "engine.log"),
        },
    });

    context.after(async () => {
        await client.close().catch(() => undefined);
        rmSync(dataDir, { recursive: true, force: true });
        rmSync(repoDir, { recursive: true, force: true });
    });

    await client.connect(transport);
    const listed = await client.listTools();
    const toolNames = listed.tools.map((tool) => tool.name);
    for (const name of requiredTools) assert.ok(toolNames.includes(name), `${name} missing from listTools`);

    const previewProject = `${project}-repo`;
    const preview = await client.callTool({
        name: "cuemap_init_preview",
        arguments: { path: repoDir, projectName: previewProject, includedPaths: ["README.md"] },
    });
    assert.match(textOf(preview), new RegExp(previewProject));

    const initialized = await client.callTool({
        name: "cuemap_init",
        arguments: {
            path: repoDir,
            projectName: previewProject,
            includedPaths: ["README.md"],
            confirmed: true,
        },
    });
    assert.match(textOf(initialized), /Successfully initialized|verified terminal state/);

    const status = await client.callTool({
        name: "cuemap_status",
        arguments: { project: previewProject },
    });
    assert.match(textOf(status), /verified_complete/);

    const added = await client.callTool({
        name: "cuemap_add",
        arguments: {
            project,
            content: "On 2026-08-18 we chose Postgres for the billing migration.",
            cues: ["billing", "postgres", "decision"],
            source_key: "mcp-e2e:billing-choice",
            event_time: 1_755_504_000,
        },
    });
    assert.match(textOf(added), /Stored memory \d+/);

    const packagePath = join(dataDir, `${project}.cuemap`);
    const packed = await client.callTool({
        name: "cuemap_project_pack",
        arguments: {
            project,
            output_path: packagePath,
            confirmed: true,
        },
    });
    assert.match(textOf(packed), /"status": "packed"/);
    assert.ok(statSync(packagePath).size > 0);

    const recalled = await client.callTool({
        name: "cuemap_recall",
        arguments: {
            projects: [project],
            query: "What database did we choose for the billing migration?",
            cues: ["billing", "postgres"],
            semantic_mode: "lexical",
            limit: 5,
            explain: true,
            trace_timing: true,
        },
    });
    assert.match(textOf(recalled), /Postgres/);
    const evidence = JSON.parse(textOf(recalled));
    assert.deepEqual(evidence, recalled.structuredContent);
    const group = evidence.results.find((item) => item.project_id === project);
    assert.ok(group.explain, "per-project explanation survives MCP formatting");
    const hit = group.results.find((item) => item.content.includes("Postgres"));
    assert.equal(hit.project_id, project);
    assert.ok(Number.isInteger(hit.memory_id));
    const fetched = await client.callTool({
        name: "cuemap_memory_get",
        arguments: { project: hit.project_id, memory_id: hit.memory_id },
    });
    assert.match(textOf(fetched), /Postgres/);

    const defaultRecall = await client.callTool({
        name: "cuemap_recall",
        arguments: { query: "billing Postgres", semantic_mode: "lexical", limit: 3, trace_timing: true },
    });
    const defaultEvidence = JSON.parse(textOf(defaultRecall));
    assert.deepEqual(defaultEvidence, defaultRecall.structuredContent);
    assert.ok(defaultEvidence.timing, "single-project timing survives MCP formatting");
    assert.ok(defaultEvidence.results.length > 0);
    assert.equal(defaultEvidence.results[0].project_id, project);
    assert.ok(Number.isInteger(defaultEvidence.results[0].memory_id));

    const previewSource = "Preview discovery source. " + "Supporting implementation detail. ".repeat(40);
    await client.callTool({ name: "cuemap_add", arguments: {
        project, content: previewSource, source_key: "mcp-e2e:preview", disable_temporal_chunking: true,
    } });
    const previewRecall = await client.callTool({ name: "cuemap_recall", arguments: {
        projects: [project], query: "Preview discovery source", semantic_mode: "lexical",
        response_mode: "preview", preview_chars: 100, limit: 3,
    } });
    const previewEvidence = JSON.parse(textOf(previewRecall));
    assert.deepEqual(previewEvidence, previewRecall.structuredContent);
    const previewHit = previewEvidence.results[0].results.find((hit) => hit.preview.startsWith("Preview discovery source."));
    assert.ok(previewHit);
    assert.equal(previewHit.content, undefined);
    assert.equal(previewHit.preview, previewSource.slice(0, 100));
    assert.equal(previewHit.content_truncated, true);
    const fullMemory = await client.callTool({ name: "cuemap_memory_get", arguments: {
        project: previewHit.project_id, memory_id: previewHit.memory_id,
    } });
    assert.equal(JSON.parse(textOf(fullMemory)).content, previewSource);
    const invalidPreview = await client.callTool({ name: "cuemap_recall", arguments: {
        query: "test", response_mode: "preview", preview_chars: 0,
    } });
    assert.equal(invalidPreview.isError, true);

    const guarded = await client.callTool({
        name: "cuemap_memory_delete",
        arguments: { project, memory_id: 1, confirmed: false },
    });
    assert.match(textOf(guarded), /requires confirmed: true/);
});
