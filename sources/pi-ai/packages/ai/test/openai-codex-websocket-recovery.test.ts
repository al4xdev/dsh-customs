import { zstdDecompressSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	closeOpenAICodexWebSocketSessions,
	getOpenAICodexWebSocketDebugStats,
	resetOpenAICodexWebSocketDebugStats,
	stream,
} from "../src/api/openai-codex-responses.ts";
import type { AssistantMessage, Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const model: Model<"openai-codex-responses"> = {
	id: "gpt-5.1-codex",
	name: "GPT-5.1 Codex",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api",
	reasoning: true,
	input: ["text"],
	cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 400000,
	maxTokens: 128000,
};
const apiKey = `aaa.${Buffer.from(
	JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "offline-account" } }),
).toString("base64")}.bbb`;
const context = normalizeContext({ messages: [{ role: "user", content: "Say hello", timestamp: 1 }] });
const options = { apiKey, sessionId: "raw-recovery", transport: "auto" as const };
const zeroUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const metadata = [
	{ type: "codex.rate_limits", rate_limits: { allowed: true } },
	{ type: "response.created", response: { id: "abandoned-response" } },
	{ type: "response.in_progress", response: { id: "abandoned-response", status: "in_progress" } },
];
const previousError = {
	type: "error",
	error: { code: "previous_response_not_found", message: "Missing previous response" },
};
const completed = {
	type: "response.completed",
	response: {
		id: "healthy-response",
		status: "completed",
		usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
	},
};
const emptyMessage = {
	type: "response.output_item.added",
	output_index: 0,
	item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
};
const textEvents = [
	emptyMessage,
	{ type: "response.output_text.delta", output_index: 0, delta: "Hello" },
	{
		type: "response.output_item.done",
		output_index: 0,
		item: { ...emptyMessage.item, status: "completed", content: [{ type: "output_text", text: "Hello" }] },
	},
];

function frame(socket: EventTarget, value: unknown): void {
	socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) }));
}

function rawClose(socket: EventTarget, code = 1000): void {
	Object.assign(socket, { readyState: 3 });
	socket.dispatchEvent(Object.assign(new Event("close"), { code, reason: "", wasClean: code === 1000 }));
}

function sse(withUsage = true): Response {
	const terminal = {
		...completed,
		response: { status: "completed", ...(withUsage ? { usage: completed.response.usage } : {}) },
	};
	return new Response([...textEvents, terminal].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
		headers: { "content-type": "text/event-stream" },
	});
}

function harness(onSend: (socket: EventTarget, request: number) => void) {
	const sockets: EventTarget[] = [];
	const sentBodies: Record<string, unknown>[] = [];
	class FakeSocket extends EventTarget {
		readyState = 1;

		constructor() {
			super();
			sockets.push(this);
			queueMicrotask(() => this.dispatchEvent(new Event("open")));
		}

		send(data: string): void {
			sentBodies.push(JSON.parse(data) as Record<string, unknown>);
			const request = sentBodies.length;
			queueMicrotask(() => onSend(this, request));
		}

		close(): void {
			this.readyState = 3;
		}
	}
	const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => sse());
	vi.stubGlobal("WebSocket", FakeSocket);
	vi.stubGlobal("fetch", fetchMock);
	return { sockets, sentBodies, fetchMock };
}

async function collect(resultStream: ReturnType<typeof stream>) {
	const events = [];
	for await (const event of resultStream) events.push(event);
	return { events, result: await resultStream.result() };
}

afterEach(() => {
	closeOpenAICodexWebSocketSessions();
	resetOpenAICodexWebSocketDebugStats();
	vi.unstubAllGlobals();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

// Regression for #7648: raw assistant output, not metadata or materialized text, determines replay safety.
describe("Codex raw websocket replay safety", () => {
	it.each(["auto", "websocket", "websocket-cached"] as const)(
		"recovers metadata then raw close1000 via SSE in %s with one start and clean state",
		async (transport) => {
			const { sockets, sentBodies, fetchMock } = harness((socket, request) => {
				if (request > 1) return frame(socket, completed);
				for (const event of metadata) frame(socket, event);
				rawClose(socket);
			});
			let partial: AssistantMessage | undefined;
			fetchMock.mockImplementation(async (_url, init) => {
				expect(partial?.responseId).toBeUndefined();
				expect(partial?.usage).toEqual(zeroUsage);
				expect(partial?.content).toEqual([]);
				expect(partial?.stopReason).toBe("pending");
				expect(partial?.rawStopReason).toBeUndefined();
				expect(partial?.errorMessage).toBeUndefined();
				expect(partial?.endTurn).toBeUndefined();
				const body = init?.body;
				const decoded =
					typeof body === "string" ? body : Buffer.from(zstdDecompressSync(body as Uint8Array)).toString();
				const { type: _type, ...fullBody } = sentBodies[0];
				expect(JSON.parse(decoded)).toEqual(fullBody);
				return sse();
			});
			const resultStream = stream(model, context, { ...options, transport });
			const types: string[] = [];
			for await (const event of resultStream) {
				types.push(event.type);
				if (event.type === "start") partial = event.partial;
			}
			const result = await resultStream.result();
			expect(result.stopReason).toBe("stop");
			expect(result).toBe(partial);
			expect(result.responseId).toBeUndefined();
			expect(result.content).toHaveLength(1);
			expect(result.content[0]).toMatchObject({ type: "text", text: "Hello" });
			expect(result.usage).toMatchObject({ input: 5, output: 3, totalTokens: 8 });
			expect(result.usage.cost.total).toBeCloseTo(0.000011, 10);
			expect(types.filter((type) => type === "start")).toHaveLength(1);
			expect(types.filter((type) => type === "done")).toHaveLength(1);
			expect(types).not.toContain("error");
			expect(result.diagnostics?.[0].details).toMatchObject({ fallbackTransport: "sse", eventsEmitted: true });
			expect(fetchMock).toHaveBeenCalledTimes(1);
			expect(sentBodies).toHaveLength(1);
			expect((await stream(model, context, { ...options, transport }).result()).stopReason).toBe("stop");
			expect(sockets).toHaveLength(2);
			expect(fetchMock).toHaveBeenCalledTimes(1);
			expect(getOpenAICodexWebSocketDebugStats(options.sessionId)).toMatchObject({
				websocketFailures: 1,
				sseFallbacks: 1,
				websocketFallbackActive: false,
			});
		},
	);

	it.each([[], [metadata[0]], [metadata[1]], [metadata[2]]].map((prefix) => ({ prefix })))(
		"allows raw close1000 recovery after metadata-only prefix $prefix",
		async ({ prefix }) => {
			const { fetchMock } = harness((socket) => {
				for (const event of prefix) frame(socket, event);
				rawClose(socket);
			});
			fetchMock.mockImplementation(async () => sse(false));
			const { result, events } = await collect(stream(model, context, options));
			expect(result.stopReason).toBe("stop");
			expect(result.responseId).toBeUndefined();
			expect(result.usage).toEqual(zeroUsage);
			expect(events.filter((event) => event.type === "start")).toHaveLength(1);
			expect(fetchMock).toHaveBeenCalledTimes(1);
		},
	);

	const outputCases = [
		["empty message", emptyMessage],
		[
			"empty text part",
			{ type: "response.content_part.added", output_index: 0, part: { type: "output_text", text: "" } },
		],
		["orphan empty text delta", { type: "response.output_text.delta", output_index: 0, delta: "" }],
		["orphan text done", { type: "response.output_text.done", output_index: 0, text: "" }],
		[
			"empty reasoning",
			{ type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "r1", summary: [] } },
		],
		[
			"encrypted reasoning",
			{
				type: "response.output_item.done",
				output_index: 0,
				item: { type: "reasoning", id: "r1", summary: [], encrypted_content: "ciphertext" },
			},
		],
		["orphan reasoning delta", { type: "response.reasoning_text.delta", output_index: 0, delta: "" }],
		[
			"orphan reasoning summary",
			{ type: "response.reasoning_summary_part.done", output_index: 0, part: { type: "summary_text", text: "" } },
		],
		[
			"empty function tool",
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { type: "function_call", id: "fc1", call_id: "call1", name: "tool", arguments: "" },
			},
		],
		["orphan function arguments", { type: "response.function_call_arguments.delta", output_index: 0, delta: "" }],
		[
			"empty custom tool",
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { type: "custom_tool_call", id: "ct1", call_id: "call1", name: "tool", input: "" },
			},
		],
		["orphan custom input", { type: "response.custom_tool_call_input.done", output_index: 0, input: "" }],
		[
			"refusal part",
			{ type: "response.content_part.added", output_index: 0, part: { type: "refusal", refusal: "" } },
		],
		["orphan refusal delta", { type: "response.refusal.delta", output_index: 0, delta: "" }],
		["orphan refusal done", { type: "response.refusal.done", output_index: 0, refusal: "No" }],
		["unmaterialized audio", { type: "response.audio.delta", delta: "encoded" }],
		["unmaterialized image", { type: "response.image_generation_call.partial_image", partial_image_b64: "encoded" }],
		["unknown response event", { type: "response.future_output.delta", delta: "" }],
	] as const;

	it.each(outputCases)("never replays %s after raw close1000", async (_name, outputEvent) => {
		const { fetchMock, sentBodies, sockets } = harness((socket) => {
			frame(socket, metadata[0]);
			frame(socket, outputEvent);
			rawClose(socket);
		});
		const { result, events } = await collect(stream(model, context, options));
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("WebSocket closed 1000");
		expect(fetchMock).not.toHaveBeenCalled();
		expect(sentBodies).toHaveLength(1);
		expect(sockets).toHaveLength(1);
		expect(events.filter((event) => event.type === "start")).toHaveLength(1);
		expect(events.filter((event) => event.type === "error")).toHaveLength(1);
		expect(events.some((event) => event.type === "done")).toBe(false);
	});

	it.each(outputCases)("never retries missing previous response after %s", async (_name, outputEvent) => {
		const { fetchMock, sentBodies, sockets } = harness((socket, request) => {
			if (request > 1) return frame(socket, completed);
			frame(socket, metadata[0]);
			frame(socket, outputEvent);
			frame(socket, previousError);
		});
		const { result } = await collect(stream(model, context, options));
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Missing previous response");
		expect(fetchMock).not.toHaveBeenCalled();
		expect(sentBodies).toHaveLength(1);
		expect(sockets).toHaveLength(1);
	});

	it.each(["text", "function", "custom"] as const)("preserves partial %s output without replay", async (kind) => {
		for (const failure of ["close1000", "missing-previous"] as const) {
			const outputEvents =
				kind === "text"
					? textEvents.slice(0, 2)
					: [
							{
								type: "response.output_item.added",
								output_index: 0,
								item: {
									type: kind === "function" ? "function_call" : "custom_tool_call",
									id: "tool1",
									call_id: "call1",
									name: "tool",
									arguments: "",
									input: "",
								},
							},
							{
								type:
									kind === "function"
										? "response.function_call_arguments.delta"
										: "response.custom_tool_call_input.delta",
								output_index: 0,
								delta: kind === "function" ? '{"value":1' : "partial input",
							},
						];
			const { fetchMock, sentBodies } = harness((socket, request) => {
				if (request > 1) return frame(socket, completed);
				for (const event of outputEvents) frame(socket, event);
				if (failure === "close1000") rawClose(socket);
				else frame(socket, previousError);
			});
			const result = await stream(model, context, options).result();
			expect(result.stopReason).toBe("error");
			expect(result.content).toHaveLength(1);
			expect(result.content[0]).toMatchObject(
				kind === "text"
					? { type: "text", text: "Hello" }
					: { type: "toolCall", arguments: kind === "function" ? { value: 1 } : { input: "partial input" } },
			);
			expect(result.content[0]).not.toHaveProperty("partialJson");
			expect(result.content[0]).not.toHaveProperty("customInput");
			expect(fetchMock).not.toHaveBeenCalled();
			expect(sentBodies).toHaveLength(1);
			closeOpenAICodexWebSocketSessions();
			resetOpenAICodexWebSocketDebugStats();
		}
	});

	it.each(["response.created", "response.in_progress"])("blocks embedded output in %s metadata", async (type) => {
		const { fetchMock } = harness((socket) => {
			frame(socket, {
				type,
				response: { id: "embedded", output: [{ type: "reasoning", encrypted_content: "ciphertext", summary: [] }] },
			});
			rawClose(socket);
		});
		expect((await stream(model, context, options).result()).stopReason).toBe("error");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it.each(["response.completed", "response.done", "response.incomplete"])(
		"blocks replay when terminal %s is queued after a previous-response error",
		async (type) => {
			const { sentBodies, fetchMock } = harness((socket, request) => {
				if (request > 1) return frame(socket, completed);
				frame(socket, previousError);
				frame(socket, { ...completed, type });
			});
			expect((await stream(model, context, options).result()).stopReason).toBe("error");
			expect(sentBodies).toHaveLength(1);
			expect(fetchMock).not.toHaveBeenCalled();
		},
	);

	it("observes raw output queued after a previous-response error before the consumer reaches it", async () => {
		const { sentBodies, fetchMock } = harness((socket, request) => {
			if (request > 1) return frame(socket, completed);
			frame(socket, previousError);
			frame(socket, { type: "response.refusal.done", refusal: "No" });
		});
		expect((await stream(model, context, options).result()).stopReason).toBe("error");
		expect(sentBodies).toHaveLength(1);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it.each(["close1000", "missing-previous"] as const)(
		"does not replay while Blob output is pending on %s",
		async (failure) => {
			let resolveData: ((bytes: ArrayBuffer) => void) | undefined;
			const data = {
				arrayBuffer: () =>
					new Promise<ArrayBuffer>((resolve) => {
						resolveData = resolve;
					}),
			};
			const { sentBodies, fetchMock } = harness((socket, request) => {
				if (request > 1) return frame(socket, completed);
				socket.dispatchEvent(new MessageEvent("message", { data }));
				if (failure === "close1000") rawClose(socket);
				else frame(socket, previousError);
			});
			const result = await stream(model, context, options).result();
			expect(result.stopReason).toBe("error");
			expect(sentBodies).toHaveLength(1);
			expect(fetchMock).not.toHaveBeenCalled();
			resolveData?.(new TextEncoder().encode(JSON.stringify(emptyMessage)).buffer);
			await Promise.resolve();
			await Promise.resolve();
			expect(result.content).toEqual([]);
		},
	);

	it("resets metadata before a single full-context missing-continuation retry", async () => {
		const { sentBodies, fetchMock } = harness((socket, request) => {
			if (request === 1) {
				frame(socket, metadata[1]);
				frame(socket, previousError);
			} else {
				frame(socket, { ...completed, response: { status: "completed" } });
			}
		});
		const { result, events } = await collect(stream(model, context, options));
		expect(result.stopReason).toBe("stop");
		expect(result.responseId).toBeUndefined();
		expect(result.usage).toEqual(zeroUsage);
		expect(sentBodies).toHaveLength(2);
		expect(sentBodies[1]).toEqual(sentBodies[0]);
		expect(events.filter((event) => event.type === "start")).toHaveLength(1);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("does not retry a second missing-continuation error", async () => {
		const { sentBodies, fetchMock } = harness((socket) => frame(socket, previousError));
		expect((await stream(model, context, options).result()).stopReason).toBe("error");
		expect(sentBodies).toHaveLength(2);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it.each([1006, 1009])("preserves fail-fast after metadata and raw close%i", async (code) => {
		const { fetchMock } = harness((socket) => {
			frame(socket, metadata[1]);
			rawClose(socket, code);
		});
		expect((await stream(model, context, options).result()).stopReason).toBe("error");
		expect(fetchMock).not.toHaveBeenCalled();
		expect(getOpenAICodexWebSocketDebugStats(options.sessionId)?.websocketFallbackActive).toBe(code === 1009);
	});

	it("preserves fail-fast on an idle timeout after metadata", async () => {
		vi.useFakeTimers();
		const { fetchMock } = harness((socket) => frame(socket, metadata[1]));
		const resultPromise = stream(model, context, { ...options, timeoutMs: 50 }).result();
		await vi.advanceTimersByTimeAsync(50);
		const result = await resultPromise;
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("WebSocket idle timeout after 50ms");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it.each(["response.completed", "response.done", "response.incomplete"])(
		"does not replay terminal %s followed by raw close1000",
		async (type) => {
			const { fetchMock } = harness((socket) => {
				frame(socket, {
					...completed,
					type,
					response: {
						...completed.response,
						status: type === "response.incomplete" ? "incomplete" : "completed",
						incomplete_details: { reason: "max_output_tokens" },
					},
				});
				queueMicrotask(() => rawClose(socket));
			});
			const { result, events } = await collect(stream(model, context, options));
			expect(result.stopReason).toBe(type === "response.incomplete" ? "length" : "stop");
			expect(events.filter((event) => event.type === "done")).toHaveLength(1);
			expect(fetchMock).not.toHaveBeenCalled();
		},
	);

	it.each(
		["Uint8Array", "ArrayBuffer", "DataView"].flatMap((format) => ["text", "tool"].map((kind) => ({ format, kind }))),
	)("preserves mixed $format $kind output before a string terminal event", async ({ format, kind }) => {
		const outputEvent =
			kind === "text"
				? textEvents[2]
				: {
						type: "response.output_item.done",
						output_index: 0,
						item: {
							type: "function_call",
							id: "fc_mixed",
							call_id: "call_mixed",
							name: "tool",
							arguments: '{"value":1}',
						},
					};
		const bytes = new TextEncoder().encode(JSON.stringify(outputEvent));
		const data = format === "ArrayBuffer" ? bytes.buffer : format === "DataView" ? new DataView(bytes.buffer) : bytes;
		const { sentBodies, fetchMock } = harness((socket, request) => {
			if (request === 1) {
				frame(socket, { type: "response.created", response: { id: "healthy-response" } });
				socket.dispatchEvent(new MessageEvent("message", { data }));
			}
			frame(socket, completed);
		});
		const { result, events } = await collect(stream(model, context, options));
		expect(result.stopReason).toBe(kind === "tool" ? "toolUse" : "stop");
		expect(result.content).toHaveLength(1);
		expect(result.content[0]).toMatchObject(
			kind === "text"
				? { type: "text", text: "Hello" }
				: { type: "toolCall", name: "tool", arguments: { value: 1 } },
		);
		expect(events.filter((event) => event.type === "start")).toHaveLength(1);
		expect(events.filter((event) => event.type === "done")).toHaveLength(1);
		expect(events.some((event) => event.type === "error")).toBe(false);
		const nextContext = normalizeContext({
			messages: [...context.messages, result, { role: "user", content: "Continue", timestamp: 2 }],
		});
		expect((await stream(model, nextContext, options).result()).stopReason).toBe("stop");
		expect(sentBodies[1].previous_response_id).toBe("healthy-response");
		expect(sentBodies[1].input).toEqual([
			...(kind === "tool"
				? [{ type: "function_call_output", call_id: "call_mixed", output: "No result provided" }]
				: []),
			{ role: "user", content: [{ type: "input_text", text: "Continue" }] },
		]);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("never recovers raw close1000 when cancellation is requested", async () => {
		const controller = new AbortController();
		const { fetchMock, sentBodies } = harness((socket) => {
			frame(socket, metadata[1]);
			controller.abort();
			rawClose(socket);
		});
		expect((await stream(model, context, { ...options, signal: controller.signal }).result()).stopReason).toBe(
			"aborted",
		);
		expect(sentBodies).toHaveLength(1);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
