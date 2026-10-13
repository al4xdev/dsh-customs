import { zstdDecompressSync } from "node:zlib";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	closeOpenAICodexWebSocketSessions,
	type OpenAICodexResponsesOptions,
	stream,
	streamSimple,
} from "../src/api/openai-codex-responses.ts";
import type { Model, ModelThinkingLevel, SimpleStreamOptions, ThinkingLevelMap } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const token = `aaa.${Buffer.from(
	JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
).toString("base64")}.bbb`;
const context = normalizeContext({
	systemPrompt: "Keep the backend reasoning default.",
	messages: [{ role: "user", content: "Hello", timestamp: 0 }],
	tools: [{ name: "ping", description: "Ping", parameters: Type.Object({ value: Type.String() }) }],
});
const solMap: ThinkingLevelMap = { minimal: "low", xhigh: "xhigh", max: "max" };

function codexModel(thinkingLevelMap: ThinkingLevelMap | undefined = solMap): Model<"openai-codex-responses"> {
	return {
		id: "gpt-6.1-sol",
		name: "GPT-6.1 Sol",
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: "https://example.invalid/backend-api",
		reasoning: true,
		thinkingLevelMap,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 400000,
		maxTokens: 128000,
	};
}

beforeEach(() => {
	// Fail closed even if a payload hook unexpectedly stops intercepting requests.
	vi.stubGlobal(
		"fetch",
		vi.fn(() => Promise.reject(new Error("Unexpected network request"))),
	);
	vi.stubGlobal(
		"WebSocket",
		class {
			constructor() {
				throw new Error("Unexpected WebSocket connection");
			}
		},
	);
});

afterEach(() => {
	closeOpenAICodexWebSocketSessions();
	vi.unstubAllGlobals();
});

const adapters = ["stream", "streamSimple"] as const;
type Adapter = (typeof adapters)[number];

async function capturePayload(
	adapter: Adapter,
	model: Model<"openai-codex-responses">,
	effort?: ModelThinkingLevel | "none",
): Promise<Record<string, unknown>> {
	let payload: Record<string, unknown> | undefined;
	const options = {
		apiKey: token,
		transport: "sse" as const,
		onPayload: (request: unknown) => {
			payload = request as Record<string, unknown>;
			// The hook runs before either transport; no real credentials or network are needed.
			throw new Error("payload captured");
		},
	};
	const result = await (adapter === "stream"
		? stream(model, context, {
				...options,
				reasoningEffort: effort === "off" ? "none" : effort,
			})
		: streamSimple(model, context, {
				...options,
				// Runtime accepts logical off although SimpleStreamOptions excludes it in v0.87.1.
				reasoning: (effort === "none" ? "off" : effort) as SimpleStreamOptions["reasoning"],
			})
	).result();

	expect(result.stopReason).toBe("error");
	expect(result.errorMessage).toContain("payload captured");
	if (!payload) throw new Error("Codex payload was not captured");
	return payload;
}

const completedEvent = {
	type: "response.completed",
	response: {
		id: "resp_test",
		status: "completed",
		usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
	},
};

function mockWebSocket(sentBodies: Record<string, unknown>[]) {
	return class MockWebSocket {
		private listeners = new Map<string, Set<(event: unknown) => void>>();

		constructor() {
			queueMicrotask(() => this.dispatch("open", {}));
		}

		addEventListener(type: string, listener: (event: unknown) => void): void {
			let listeners = this.listeners.get(type);
			if (!listeners) {
				listeners = new Set();
				this.listeners.set(type, listeners);
			}
			listeners.add(listener);
		}

		removeEventListener(type: string, listener: (event: unknown) => void): void {
			this.listeners.get(type)?.delete(listener);
		}

		send(data: string): void {
			sentBodies.push(JSON.parse(data) as Record<string, unknown>);
			queueMicrotask(() => this.dispatch("message", { data: JSON.stringify(completedEvent) }));
		}

		close(): void {}

		private dispatch(type: string, event: unknown): void {
			for (const listener of this.listeners.get(type) ?? []) listener(event);
		}
	};
}

describe("Codex backend reasoning default", () => {
	for (const adapter of adapters) {
		describe(adapter, () => {
			it.each([
				{ label: "without metadata", map: undefined },
				{ label: "with gpt-6.1-sol metadata", map: solMap },
				{ label: "with off mapped to none", map: { ...solMap, off: "none" } },
				{ label: "with off mapped to low", map: { ...solMap, off: "low" } },
				{ label: "with off mapped to null", map: { ...solMap, off: null } },
			] satisfies { label: string; map: ThinkingLevelMap | undefined }[])(
				"omits reasoning when effort is absent $label",
				async ({ map }) => {
					const model = codexModel();
					model.thinkingLevelMap = map;
					const payload = await capturePayload(adapter, model);
					expect(payload).not.toHaveProperty("reasoning");
				},
			);

			it.each(["low", "medium", "high", "xhigh", "max"] as const)("preserves explicit %s effort", async (effort) => {
				const payload = await capturePayload(adapter, codexModel(), effort);
				expect(payload.reasoning).toEqual({ effort, summary: "auto" });
			});

			it.each(["none", "low", undefined] as const)("preserves off mapped to %s", async (off) => {
				const payload = await capturePayload(adapter, codexModel({ ...solMap, off }), "off");
				expect(payload.reasoning).toEqual({ effort: off ?? "none", summary: "auto" });
			});

			it("preserves the off:null contract", async () => {
				const payload = await capturePayload(adapter, codexModel({ ...solMap, off: null }), "off");
				if (adapter === "stream") {
					expect(payload).not.toHaveProperty("reasoning");
				} else {
					// Unsupported logical off still clamps to minimal, mapped to low by this model.
					expect(payload.reasoning).toEqual({ effort: "low", summary: "auto" });
				}
			});

			it("omits reasoning for a non-reasoning model without effort", async () => {
				const payload = await capturePayload(adapter, { ...codexModel(), reasoning: false });
				expect(payload).not.toHaveProperty("reasoning");
			});
		});
	}

	it("does not translate simple off to none for a non-reasoning model", async () => {
		const payload = await capturePayload("streamSimple", { ...codexModel(), reasoning: false }, "off");
		expect(payload).not.toHaveProperty("reasoning");
	});

	for (const adapter of adapters) {
		for (const transport of ["sse", "websocket"] as const) {
			it.each(["short", "none"] as const)(
				`${adapter} preserves encrypted include, tools and %s cache on ${transport} without effort`,
				async (cacheRetention) => {
					const sentBodies: Record<string, unknown>[] = [];
					vi.stubGlobal("WebSocket", mockWebSocket(sentBodies));
					const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
						const body = init?.body;
						const json =
							typeof body === "string"
								? body
								: body instanceof Uint8Array
									? Buffer.from(zstdDecompressSync(body)).toString("utf8")
									: undefined;
						if (!json) throw new Error("Missing SSE request body");
						sentBodies.push(JSON.parse(json) as Record<string, unknown>);
						return new Response(`data: ${JSON.stringify(completedEvent)}\n\n`, {
							headers: { "content-type": "text/event-stream" },
						});
					});
					vi.stubGlobal("fetch", fetchMock);
					let capturedPayload: unknown;
					const options = {
						apiKey: token,
						transport,
						cacheRetention,
						sessionId: "reasoning-default-regression",
						onPayload: (payload: unknown) => {
							capturedPayload = payload;
						},
					} satisfies OpenAICodexResponsesOptions & SimpleStreamOptions;
					const result = await (adapter === "stream"
						? stream(codexModel(), context, options)
						: streamSimple(codexModel(), context, options)
					).result();

					expect(result.stopReason).toBe("stop");
					expect(capturedPayload).not.toHaveProperty("reasoning");
					expect(sentBodies).toHaveLength(1);
					const body = sentBodies[0];
					expect(body).not.toHaveProperty("reasoning");
					expect(body.include).toEqual(["reasoning.encrypted_content"]);
					expect(body.store).toBe(false);
					expect(body.parallel_tool_calls).toBe(true);
					expect(body.tool_choice).toBe("auto");
					expect(body.tools).toEqual([
						{
							type: "function",
							name: "ping",
							description: "Ping",
							strict: null,
							parameters: {
								type: "object",
								properties: { value: { type: "string" } },
								required: ["value"],
							},
						},
					]);
					if (cacheRetention === "none") {
						expect(body).not.toHaveProperty("prompt_cache_key");
					} else {
						expect(body.prompt_cache_key).toBe("reasoning-default-regression");
					}
					expect(fetchMock).toHaveBeenCalledTimes(transport === "sse" ? 1 : 0);
				},
			);
		}
	}
});
