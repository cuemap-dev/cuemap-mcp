const test = require("node:test");
const assert = require("node:assert/strict");

const { evaluateJobStatus } = require("../build/job-status.js");

test("does not treat an initial idle 0/0 status as complete", () => {
    assert.deepEqual(
        evaluateJobStatus({
            phase: "idle",
            writes_completed: 0,
            writes_total: 0,
        }),
        {
            active: false,
            observed_activity: false,
            pending_writes: 0,
            pending_intents: 0,
            verified_complete: false,
        },
    );
});

test("observes writing activity before totals are populated", () => {
    assert.deepEqual(
        evaluateJobStatus({
            phase: "writing",
            writes_completed: 0,
            writes_total: 0,
        }),
        {
            active: true,
            observed_activity: true,
            pending_writes: 0,
            pending_intents: 0,
            verified_complete: false,
        },
    );
});

test("does not finish while the phase is active even when writes match", () => {
    assert.deepEqual(
        evaluateJobStatus({
            phase: "writing",
            writes_completed: 10,
            writes_total: 10,
        }),
        {
            active: true,
            observed_activity: true,
            pending_writes: 0,
            pending_intents: 0,
            verified_complete: false,
        },
    );
});

test("verifies done after activity", () => {
    assert.deepEqual(
        evaluateJobStatus({
            phase: "done",
            writes_completed: 10,
            writes_total: 10,
        }),
        {
            active: false,
            observed_activity: true,
            pending_writes: 0,
            pending_intents: 0,
            verified_complete: true,
        },
    );
});

test("verifies idle after activity was previously observed", () => {
    assert.deepEqual(
        evaluateJobStatus({
            phase: "idle",
            writes_completed: 0,
            writes_total: 0,
        }, true),
        {
            active: false,
            observed_activity: true,
            pending_writes: 0,
            pending_intents: 0,
            verified_complete: true,
        },
    );
});

test("waits for intent annotation after writes complete", () => {
    assert.deepEqual(
        evaluateJobStatus({
            phase: "processing",
            writes_completed: 10,
            writes_total: 10,
            intent_completed: 8,
            intent_total: 10,
            intent_failed: 0,
            intent_ready: false,
        }),
        {
            active: true,
            observed_activity: true,
            pending_writes: 0,
            pending_intents: 2,
            verified_complete: false,
        },
    );
});

test("does not verify completion when intent annotation failed", () => {
    assert.deepEqual(
        evaluateJobStatus({
            phase: "done",
            writes_completed: 10,
            writes_total: 10,
            intent_completed: 9,
            intent_total: 10,
            intent_failed: 1,
            intent_ready: false,
        }),
        {
            active: false,
            observed_activity: true,
            pending_writes: 0,
            pending_intents: 0,
            verified_complete: false,
        },
    );
});
