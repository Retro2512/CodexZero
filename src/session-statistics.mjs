import { createHash } from "node:crypto";

const TOOL_ITEMS = new Set(["CommandExecution", "DynamicToolCall", "CollabAgentToolCall", "SubAgentActivity",
  "WebSearch", "ImageView", "ImageGeneration", "Extension", "FileChange", "McpToolCall"]);
const CALLS = new Set(["function_call", "custom_tool_call", "tool_search_call", "local_shell_call"]);
const OUTPUTS = new Set(["function_call_output", "custom_tool_call_output", "tool_search_output"]);
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const duration = value => Number.isFinite(value) && value >= 0 ? value : null;
const usageKeys = ["input", "cached", "output"];

function usage(value) {
  if (!value) return null;
  const result = { input: count(value.input_tokens ?? value.inputTokens),
    cached: count(value.cached_input_tokens ?? value.cachedInputTokens),
    output: count(value.output_tokens ?? value.outputTokens) };
  return usageKeys.every(k => result[k] !== null) && result.cached <= result.input ? result : null;
}

function unionDuration(intervals) {
  const sorted = intervals.filter(([start, end]) => Number.isFinite(start) && end >= start)
    .sort((a, b) => a[0] - b[0]);
  let result = 0, start = null, end = null;
  for (const [nextStart, nextEnd] of sorted) {
    if (start === null) { start = nextStart; end = nextEnd; }
    else if (nextStart <= end) end = Math.max(end, nextEnd);
    else { result += end - start; start = nextStart; end = nextEnd; }
  }
  return result + (start === null ? 0 : end - start);
}

/** Numeric aggregates and opaque identifiers only; no conversation or tool content. */
export class SessionStatisticsAccumulator {
  constructor() {
    this.turns = new Map();
    this.calls = new Map();
    this.responses = new Set();
    this.usageRecords = new Set();
    this.total = null;
    this.currentTurn = null;
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.cachedInputTokens = 0;
    this.partial = false;
  }

  markPartial() { this.partial = true; this.cachedSnapshot = null; }

  turn(id, at) {
    const key = id ?? this.currentTurn ?? `legacy:${at}`;
    if (!this.turns.has(key)) this.turns.set(key, { start: at, completed: false, steps: 0, output: 0,
      tools: new Map(), samplingMs: null, profileSteps: null, ttftMs: null });
    return [key, this.turns.get(key)];
  }

  accept(record) {
    const p = record?.payload;
    const at = Date.parse(record?.timestamp);
    if (!p || !Number.isFinite(at)) return;
    this.cachedSnapshot = null;
    if (record.type === "turn_context" && p.turn_id) {
      [this.currentTurn] = this.turn(p.turn_id, at);
      return;
    }
    if (record.type === "event_msg" && ["task_started", "turn_started"].includes(p.type)) {
      [this.currentTurn] = this.turn(p.turn_id ?? `legacy:${at}`, at);
      return;
    }
    if (record.type === "event_msg" && p.type === "user_message" && !this.currentTurn) {
      [this.currentTurn] = this.turn(null, at);
      return;
    }
    if (record.type === "response_item") {
      if (CALLS.has(p.type) && p.call_id && !this.calls.has(p.call_id)) {
        const [turnId] = this.turn(null, at);
        this.calls.set(p.call_id, { start: at, turnId, completed: false });
      } else if (OUTPUTS.has(p.type) && p.call_id) {
        const call = this.calls.get(p.call_id);
        if (call && !call.completed && at >= call.start) {
          this.turns.get(call.turnId).tools.set(`call:${p.call_id}`, [call.start, at]);
          call.completed = true;
        } else if (!call || at < call.start) this.markPartial();
      }
      return;
    }
    if (record.type === "token_usage_record") {
      const response = p.response_id;
      if (response && this.responses.has(response)) return;
      if (response) this.responses.add(response);
      this.acceptUsage(p.thread_token_usage, p.usage, at, p.turn_id, response);
      return;
    }
    if (record.type !== "event_msg") return;
    if (p.type === "token_count" && p.info) {
      this.acceptUsage(p.info.total_token_usage, p.info.last_token_usage, at);
    } else if (p.type === "item_completed" && TOOL_ITEMS.has(p.item?.type)) {
      const start = duration(p.started_at_ms), end = duration(p.completed_at_ms);
      if (start !== null && end !== null && end >= start && p.item.id) {
        const [, turn] = this.turn(p.turn_id, at);
        turn.tools.set(`item:${p.item.id}`, [start, end]);
      } else this.markPartial();
    } else if (["task_complete", "task_completed", "turn_complete", "turn_aborted"].includes(p.type)) {
      const [id, turn] = this.turn(p.turn_id, at);
      turn.completed = true;
      turn.ttftMs = duration(p.time_to_first_token_ms) ?? turn.ttftMs;
      turn.samplingMs = duration(p.turn_profile?.sampling_ms) ?? turn.samplingMs;
      turn.profileSteps = count(p.turn_profile?.sampling_request_count) ?? turn.profileSteps;
      turn.toolBlockingMs = duration(p.turn_profile?.tool_blocking_ms) ?? turn.toolBlockingMs;
      if (this.currentTurn === id) this.currentTurn = null;
    }
  }

  acceptUsage(totalValue, lastValue, at, turnId, responseId) {
    const total = usage(totalValue), last = usage(lastValue);
    if (!total || !last) { this.markPartial(); return; }
    const fingerprint = createHash("sha256").update(JSON.stringify([at, total, last])).digest("hex");
    if (this.usageRecords.has(fingerprint)) return;
    this.usageRecords.add(fingerprint);
    if (this.total && usageKeys.every(k => total[k] === this.total[k])) return;
    const previous = this.total;
    this.total = total;
    // Compaction may replace cumulative context counts. It is not a response.
    if (previous && usageKeys.some(k => total[k] < previous[k]) && !responseId) {
      this.markPartial();
      return;
    }
    const exact = usageKeys.every(k => total[k] - (previous?.[k] ?? 0) === last[k]);
    if (!exact) this.markPartial();
    if (!last.input && !last.output) return;
    // A response ID proves a single completed request even after cumulative resets.
    // Legacy cumulative gaps reveal usage but not how many requests were missed.
    const amount = exact || responseId || !previous ? last : null;
    if (!amount) return;
    this.inputTokens += amount.input;
    this.outputTokens += amount.output;
    this.cachedInputTokens += amount.cached;
    const [, turn] = this.turn(turnId, at);
    turn.steps++;
    turn.output += amount.output;
  }

  get snapshot() {
    if (this.cachedSnapshot) return this.cachedSnapshot;
    let toolTimeMs = 0, llmTimeMs = 0, llmTimeSamples = 0, llmOutputTokens = 0,
      ttftTotalMs = 0, ttftSamples = 0, modelSteps = 0, partial = this.partial;
    for (const turn of this.turns.values()) {
      // Each turn has its own interval union: parallel calls do not double count,
      // and independent concurrent turns must not erase one another's tool time.
      toolTimeMs += turn.toolBlockingMs ?? unionDuration([...turn.tools.values()]);
      modelSteps += turn.profileSteps ?? turn.steps;
      if (turn.samplingMs !== null) {
        llmTimeMs += turn.samplingMs;
        llmTimeSamples++;
        llmOutputTokens += turn.output;
      } else if (turn.completed && turn.steps) partial = true;
      if (turn.ttftMs !== null) { ttftTotalMs += turn.ttftMs; ttftSamples++; }
    }
    if ([...this.calls.values()].some(call => !call.completed)) partial = true;
    this.cachedSnapshot = {
      turns: this.turns.size, modelSteps,
      llmTimeMs: llmTimeSamples ? llmTimeMs : null, toolTimeMs,
      avgTtftMs: ttftSamples ? ttftTotalMs / ttftSamples : null,
      tokensPerSecond: llmTimeMs > 0 ? llmOutputTokens * 1000 / llmTimeMs : null,
      totalTokens: this.inputTokens + this.outputTokens,
      inputTokens: this.inputTokens, outputTokens: this.outputTokens,
      cachedInputTokens: this.cachedInputTokens,
      cacheHitRate: this.inputTokens ? this.cachedInputTokens / this.inputTokens : null,
      llmTimeSamples, llmOutputTokens, ttftTotalMs, ttftSamples, partial,
    };
    return this.cachedSnapshot;
  }
}

/** Combine disjoint rollout segments using numerators rather than averages. */
export function combineSessionStats(snapshots) {
  const values = snapshots.map(value => value?.sessionStats ?? value).filter(Boolean);
  const sum = key => values.reduce((total, value) => total + (value[key] ?? 0), 0);
  const inputTokens = sum("inputTokens"), outputTokens = sum("outputTokens"), cachedInputTokens = sum("cachedInputTokens");
  const llmTimeSamples = sum("llmTimeSamples"), llmTimeMs = sum("llmTimeMs"), llmOutputTokens = sum("llmOutputTokens");
  const ttftSamples = sum("ttftSamples"), ttftTotalMs = sum("ttftTotalMs");
  return { turns: sum("turns"), modelSteps: sum("modelSteps"),
    llmTimeMs: llmTimeSamples ? llmTimeMs : null, toolTimeMs: sum("toolTimeMs"),
    avgTtftMs: ttftSamples ? ttftTotalMs / ttftSamples : null,
    tokensPerSecond: llmTimeMs > 0 ? llmOutputTokens * 1000 / llmTimeMs : null,
    totalTokens: inputTokens + outputTokens, inputTokens, outputTokens, cachedInputTokens,
    cacheHitRate: inputTokens ? cachedInputTokens / inputTokens : null,
    llmTimeSamples, llmOutputTokens, ttftSamples, ttftTotalMs,
    partial: values.some(value => value.partial === true) };
}
