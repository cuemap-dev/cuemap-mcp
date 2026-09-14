const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const builtServer = readFileSync(join(__dirname, "../build/index.js"), "utf8");

const expectedTools = [
    "cuemap_init_preview",
    "cuemap_init",
    "cuemap_add",
    "cuemap_intent_classify",
    "cuemap_status",
    "cuemap_projects",
    "cuemap_project_save",
    "cuemap_project_load",
    "cuemap_project_unload",
    "cuemap_project_pack",
    "cuemap_project_package_load",
    "cuemap_project_push",
    "cuemap_project_pull",
    "cuemap_project_sync",
    "cuemap_stats",
    "cuemap_memory_get",
    "cuemap_memory_reinforce",
    "cuemap_memory_delete",
    "cuemap_ingest_url",
    "cuemap_ingest_content",
    "cuemap_ingest_file",
    "cuemap_project_export",
    "cuemap_project_artifacts",
    "cuemap_alias_list",
    "cuemap_alias_add",
    "cuemap_alias_merge",
    "cuemap_lexicon_inspect",
    "cuemap_lexicon_graph",
    "cuemap_lexicon_wire",
    "cuemap_lexicon_delete",
    "cuemap_recall",
];

test("registers the requested MCP tool surface", () => {
    for (const tool of expectedTools) {
        assert.match(
            builtServer,
            new RegExp(`registerTool\\(\\s*["']${tool}["']`),
            `${tool} should be registered`,
        );
    }
});

test("does not register grounded recall", () => {
    assert.doesNotMatch(
        builtServer,
        /registerTool\(\s*["']cuemap_recall_grounded["']/,
    );
});

test("recall exposes the v0.7.3 semantic contract", () => {
    const start = builtServer.indexOf('registerTool("cuemap_recall"');
    const registration = builtServer.slice(start);
    for (const field of ["semantic_mode", "query_embedding"]) {
        assert.match(registration, new RegExp(field));
    }
    assert.match(registration, /semantic_mode = "hybrid"/);
    assert.doesNotMatch(registration, /CueSense|semantic_preview|semantic_interpretation|cuesense_multi_interpretation_v1/);
    assert.doesNotMatch(registration, /cuepacks/);
});

test("exposes intent classification and caller-provided embeddings", () => {
    assert.match(builtServer, /registerTool\(\s*["']cuemap_intent_classify["']/);
    assert.match(builtServer, /embedding: .*\.array/);
    assert.match(builtServer, /embeddings: .*\.array/);
});

test("guards destructive and canonicalizing tools with confirmation", () => {
    for (const tool of [
        "cuemap_memory_delete",
        "cuemap_alias_merge",
        "cuemap_lexicon_delete",
        "cuemap_project_pack",
        "cuemap_project_package_load",
        "cuemap_project_push",
        "cuemap_project_pull",
        "cuemap_project_sync",
    ]) {
        const start = builtServer.indexOf(`registerTool("${tool}"`);
        const next = builtServer.indexOf("registerTool(", start + 1);
        const registration = builtServer.slice(start, next === -1 ? undefined : next);
        assert.match(registration, /confirmed/);
        assert.match(registration, /confirmationRequired/);
    }
});
