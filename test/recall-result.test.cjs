const test = require("node:test");
const assert = require("node:assert/strict");
const { memoryToolResult, recallToolResult } = require("../build/recall-result.js");

test("memory fetch exposes decoded evidence and rejects old engine storage payloads", () => {
    const memory = { memory_id: 7, project_id: "a", content: "readable evidence", metadata: { source: "a.rs" } };
    const result = memoryToolResult(memory);
    assert.deepEqual(result.structuredContent, memory);
    assert.deepEqual(JSON.parse(result.content[0].text), memory);
    assert.throws(() => memoryToolResult({ id: 7, content: [40, 181, 47, 253] }), /update the CueMap engine/);
});

test("text-only clients receive the same evidence and diagnostics as structured clients", () => {
    const response = {
        results: [{ id: 0, content: "fn retry() {}", score: 0.75,
            metadata: { source: "src/client.rs", start_line: 12, end_line: 20,
                parent_id: "file:client", source_session_id: "session-1" },
            explain: { matched_cues: ["retry"] }, timestamp: "not a date" }],
        explain: { query_cues: ["retry"] }, timing: { total_before_response_ms: 3.1 },
        engine_latency: 2.8,
    };
    const original = structuredClone(response);
    const result = recallToolResult(response, "repo-a");
    assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
    assert.deepEqual(result.structuredContent, { ...response, project_id: "repo-a",
        results: [{ ...response.results[0], project_id: "repo-a", memory_id: 0 }] });
    assert.deepEqual(response, original);
});

test("cross-project results keep distinct handles, empty groups, failures and diagnostics", () => {
    const response = { results: [
        { project_id: "a", results: [{ id: 7, content: "first" }], explain: { cues: ["a"] } },
        { project_id: "b", results: [{ id: 7, content: "second" }] },
        { project_id: "empty", results: [], timing: { scan_ms: 1 } },
        { project_id: "failed", error: "Capacity reached" },
    ], timing: { total_ms: 4 } };
    const result = recallToolResult(response).structuredContent;
    assert.deepEqual(result.results[0].results[0], { id: 7, memory_id: 7, project_id: "a", content: "first" });
    assert.equal(result.results[1].results[0].project_id, "b");
    assert.deepEqual(result.results[0].explain, response.results[0].explain);
    assert.deepEqual(result.results.slice(2), response.results.slice(2));
    assert.deepEqual(result.timing, response.timing);
});

test("empty recall preserves query diagnostics instead of reducing them to no-results prose", () => {
    const response = { results: [], explain: { query_cues: [] }, timing: { scan_ms: 0 } };
    assert.deepEqual(recallToolResult(response).structuredContent, response);
});

test("existing memory IDs and project ownership take precedence over fallback scope", () => {
    const result = recallToolResult({ results: [{ memory_id: 12, project_id: "actual", content: "fact" }] }, "fallback");
    assert.equal(result.structuredContent.results[0].memory_id, 12);
    assert.equal(result.structuredContent.results[0].project_id, "actual");
});

test("does not invent a fetchable ID or an ambiguous cross-project owner", () => {
    for (const id of [undefined, "7", -1, 1.5, 4_294_967_296]) {
        const result = recallToolResult({ results: [{ id, content: "evidence" }] });
        assert.equal(result.structuredContent.results[0].memory_id, undefined);
        assert.equal(result.structuredContent.results[0].project_id, undefined);
    }
});

test("malformed responses are errors rather than false evidence of no matches", () => {
    for (const value of [null, [], {}, { error: "Unavailable" }, { results: null }]) {
        assert.throws(() => recallToolResult(value), /invalid recall response/);
    }
});

test("preview is shaped by the engine and passed through unchanged", () => {
    const response = {response_mode:"preview", preview_chars:100, results:[{memory_id:3, project_id:"repo", preview:"excerpt", content_truncated:true, content_length:200}]};
    const result = recallToolResult(response, undefined, {response_mode:"preview"});
    assert.deepEqual(result.structuredContent, response);
    assert.deepEqual(JSON.parse(result.content[0].text), response);
    assert.throws(() => recallToolResult({results:[]}, "repo", {response_mode:"preview"}), /updated CueMap engine/);
});
