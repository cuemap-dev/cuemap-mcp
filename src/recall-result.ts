type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function memoryToolResult(response: unknown) {
    if (!isObject(response) || typeof response.content !== "string") {
        throw new Error("Decoded memory content unavailable; update the CueMap engine to support GET /memories/:id?decoded=true");
    }
    return {
        content: [{ type: "text" as const, text: JSON.stringify(response, null, 2) }],
        structuredContent: response,
    };
}

/** Preserve engine envelopes (including per-project errors and diagnostics).
 * IDs are only meaningful together with their owning project. */
export function recallToolResult(
    response: unknown,
    fallbackProject?: string,
    options: { response_mode?: "full" | "preview" } = {},
) {
    if (!isObject(response) || !Array.isArray(response.results)) {
        throw new Error("CueMap returned an invalid recall response: expected results array");
    }

    if (options.response_mode === "preview" && response.response_mode !== "preview") {
        throw new Error("Preview responses require an updated CueMap engine");
    }

    function withEvidenceHandles(item: unknown, project?: string): unknown {
        if (!isObject(item)) return item;
        const owner = typeof item.project_id === "string" ? item.project_id : project;
        if (Array.isArray(item.results)) {
            return {
                ...item,
                ...(owner === undefined ? {} : { project_id: owner }),
                results: item.results.map(result => withEvidenceHandles(result, owner)),
            };
        }
        // Engine HTTP responses use id; some clients expose memory_id instead.
        const id = item.memory_id ?? item.id;
        const validId = typeof id === "number" && Number.isInteger(id)
            && id >= 0 && id <= 4_294_967_295;
        return {
            ...item,
            ...(owner === undefined ? {} : { project_id: owner }),
            ...(validId ? { memory_id: id } : {}),
        };
    }

    const structuredContent = withEvidenceHandles(response, fallbackProject) as JsonObject;
    return {
        // The same evidence is available to text-only and structured MCP clients.
        content: [{ type: "text" as const, text: JSON.stringify(structuredContent, null, 2) }],
        structuredContent,
    };
}
