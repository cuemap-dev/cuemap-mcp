export interface CueMapJobStatus {
    phase: string;
    writes_completed: number;
    writes_total: number;
    intent_completed?: number;
    intent_total?: number;
    intent_failed?: number;
    intent_ready?: boolean;
    [key: string]: unknown;
}

export interface EvaluatedJobStatus {
    active: boolean;
    observed_activity: boolean;
    pending_writes: number;
    pending_intents: number;
    verified_complete: boolean;
}

const TERMINAL_PHASES = new Set(["done", "idle"]);

export function evaluateJobStatus(
    status: CueMapJobStatus,
    previouslyObservedActivity = false,
): EvaluatedJobStatus {
    const phase = String(status.phase || "").toLowerCase();
    const writesCompleted = Number.isFinite(status.writes_completed)
        ? Math.max(0, status.writes_completed)
        : 0;
    const writesTotal = Number.isFinite(status.writes_total)
        ? Math.max(0, status.writes_total)
        : 0;
    const intentCompleted = Number.isFinite(status.intent_completed)
        ? Math.max(0, status.intent_completed || 0)
        : 0;
    const intentTotal = Number.isFinite(status.intent_total)
        ? Math.max(0, status.intent_total || 0)
        : 0;
    const intentFailed = Number.isFinite(status.intent_failed)
        ? Math.max(0, status.intent_failed || 0)
        : 0;
    const pendingWrites = Math.max(0, writesTotal - writesCompleted);
    const pendingIntents = Math.max(0, intentTotal - intentCompleted - intentFailed);
    const active = !TERMINAL_PHASES.has(phase) || pendingWrites > 0 || pendingIntents > 0;
    const observedActivity = previouslyObservedActivity
        || active
        || writesCompleted > 0
        || writesTotal > 0
        || intentCompleted > 0
        || intentTotal > 0
        || intentFailed > 0;

    return {
        active,
        observed_activity: observedActivity,
        pending_writes: pendingWrites,
        pending_intents: pendingIntents,
        verified_complete: observedActivity
            && TERMINAL_PHASES.has(phase)
            && pendingWrites === 0
            && pendingIntents === 0
            && intentFailed === 0
            && status.intent_ready !== false,
    };
}
