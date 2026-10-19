// AI sound design: one Claude call that returns a complete voice as structured output, then server-side
// validation (the schema cannot express ranges, and a reply is never trusted blindly). Job orchestration
// (busy rules, the one-undo-step write, audition) lives in Editor; the briefing lives in ai-prompt.ts.
import Anthropic from '@anthropic-ai/sdk';
import {
  ALGORITHMS, PARAMS, ParamError, coerceValue, getParam, opFrequency, type ParamDef, type VoiceValues,
} from '../shared/params.ts';
import type { AiErrorKind, AiJob, AiUsage, AuditionPreset, VoiceResponse } from '../shared/protocol.ts';
import { FIXED_CARRIER_MIN_HZ, SYSTEM_PROMPT } from './ai-prompt.ts';
import { AUDITION_PRESETS } from './audition.ts';

export const AI_MODEL = 'claude-opus-5-5';
/** Only the surface Editor uses; tests inject a fake. */
export type ClaudeClient = Pick<Anthropic, 'beta'>;

// Skill guidance for non-streaming calls: 16k leaves room for the (low-effort) thinking plus ~2.5k tokens of JSON.
const MAX_TOKENS = 16_000;
// One attempt, no SDK retries: the UI's Retry is the retry policy, so 90 s is the hard upper bound per job.
const TIMEOUT_MS = 90_000;
const SUMMARY_MAX = 90;

const VALUE_PARAMS = PARAMS.filter((p) => p.id !== 'name');
const COMMON_PARAMS = VALUE_PARAMS.filter((p) => p.op === null);
const OP_FIELDS = PARAMS.filter((p) => p.op === 1).map((p) => ({ ...p, id: p.id.slice(4) })); // "op1.level" → "level"
const valueSchema = (p: ParamDef) =>
  p.kind === 'int' ? { type: 'integer' } : p.kind === 'enum' ? { type: 'string', enum: [...p.options] } : { type: 'boolean' };
const objectSchema = (defs: ParamDef[]) => ({
  type: 'object', properties: Object.fromEntries(defs.map((p) => [p.id, valueSchema(p)])),
  required: defs.map((p) => p.id), additionalProperties: false,
});

/** Structured-output schema. The operator object is declared once (an array of four): a flat object with all 123
 *  param ids was rejected by the API ("compiled grammar is too large"). Ranges are left out on purpose (numeric
 *  constraints are not supported); the prompt states them and validateDesign enforces them. All properties are
 *  required, so their order is kept. */
export const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    common: objectSchema(COMMON_PARAMS),
    operators: { type: 'array', items: objectSchema(OP_FIELDS) },
    name: { type: 'string' },
    summary: { type: 'string' },
    audition: { type: 'string', enum: AUDITION_PRESETS },
  },
  required: ['common', 'operators', 'name', 'summary', 'audition'],
  additionalProperties: false,
};

/** Flat param values (without name) → the output shape, so Claude sees the current voice as it must answer. */
export function toOutputShape(values: VoiceValues) {
  return {
    common: Object.fromEntries(COMMON_PARAMS.map((p) => [p.id, values[p.id]])),
    operators: [1, 2, 3, 4].map((n) => Object.fromEntries(OP_FIELDS.map((f) => [f.id, values[`op${n}.${f.id}`]]))),
  };
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export interface Design { values: VoiceValues; name: string; summary: string; audition: AuditionPreset; clamped: number }

/** A job failure with the error kind shown to the user; usage is set when Claude answered (and billed). */
export class AiFailure extends Error {
  readonly kind: AiErrorKind;
  readonly usage?: AiUsage;
  constructor(kind: AiErrorKind, message: string, usage?: AiUsage) {
    super(message);
    this.kind = kind;
    this.usage = usage;
  }
}

/** Unknown/missing ids or bad types/enums → invalid; out-of-range numbers are clamped and counted.
 *  Safety: a carrier (per the algorithm) in FIXED mode below FIXED_CARRIER_MIN_HZ (estimated Hz) → invalid. */
export function validateDesign(output: unknown): Design {
  const o = output as Record<string, unknown>;
  const ops = o?.operators;
  if (!isObject(o?.common) || !Array.isArray(ops) || ops.length !== 4 || !ops.every(isObject)
    || typeof o.summary !== 'string' || !AUDITION_PRESETS.includes(o.audition as AuditionPreset)) {
    throw new AiFailure('invalid', 'reply needs common values, exactly 4 operators, a summary and a known audition phrase');
  }
  const values: Record<string, unknown> = {
    ...o.common,
    ...Object.fromEntries(ops.flatMap((op, i) => Object.entries(op).map(([field, v]) => [`op${i + 1}.${field}`, v]))),
  };
  const problems = [
    ...Object.keys(values).filter((id) => !VALUE_PARAMS.some((p) => p.id === id)).map((id) => `unknown ${id}`),
    ...VALUE_PARAMS.filter((p) => !(p.id in values)).map((p) => `missing ${p.id}`),
  ];
  const out: VoiceValues = {};
  let clamped = 0;
  for (const p of VALUE_PARAMS.filter((p) => p.id in values)) {
    try {
      out[p.id] = coerceValue(p, values[p.id], true);
      if (typeof values[p.id] === 'number' && out[p.id] !== values[p.id]) clamped++;
    } catch (err) {
      if (!(err instanceof ParamError)) throw err;
      problems.push(err.message);
    }
  }
  try {
    out.name = coerceValue(getParam('name'), o.name, true); // over-long names are cut to 10 chars
  } catch (err) {
    if (!(err instanceof ParamError)) throw err;
    problems.push(err.message);
  }
  if (problems.length) throw new AiFailure('invalid', problems.slice(0, 4).join('; ') + (problems.length > 4 ? ` (+${problems.length - 4} more)` : ''));
  for (const op of ALGORITHMS[(out.algorithm as number) - 1].carriers) {
    const f = opFrequency(out, op);
    if (f.mode === 'FIXED' && f.value < FIXED_CARRIER_MIN_HZ) {
      throw new AiFailure('invalid', `carrier OP${op} in FIXED mode at ${f.display} (below ${FIXED_CARRIER_MIN_HZ} Hz can damage speakers)`);
    }
  }
  const summary = o.summary.replace(/\s+/g, ' ').trim();
  return {
    values: out, name: out.name as string, clamped, audition: o.audition as AuditionPreset,
    summary: summary.length > SUMMARY_MAX ? `${summary.slice(0, SUMMARY_MAX - 1)}…` : summary,
  };
}

// Opus 5.5 list prices per token; 5-minute cache writes cost 1.25x input.
const USD = { input: 4e-6, output: 20e-6, cacheRead: 0.2e-6, cacheWrite: 5e-6 };

function toUsage(u: Anthropic.Beta.BetaUsage): AiUsage {
  const usage = {
    inputTokens: u.input_tokens, outputTokens: u.output_tokens,
    cacheReadTokens: u.cache_read_input_tokens ?? 0, cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
  };
  const est = usage.inputTokens * USD.input + usage.outputTokens * USD.output + usage.cacheReadTokens * USD.cacheRead + usage.cacheWriteTokens * USD.cacheWrite;
  return { ...usage, estUsd: Math.round(est * 1e5) / 1e5 };
}

/** Ask Claude for a voice and validate it. Throws AiFailure, or the SDK's own error classes (see toAiError). */
export async function designVoice(client: ClaudeClient, prompt: string, current: Pick<VoiceResponse, 'values' | 'derived'>,
  signal: AbortSignal): Promise<{ design: Design; usage: AiUsage; model: string }> {
  const msg = await client.beta.messages.create({
    model: AI_MODEL,
    max_tokens: MAX_TOKENS,
    // Server-side refusal fallback: the fallback model runs this same request, structured output included
    // (the docs require the request to be valid on the fallback model; Opus 5 / Opus 4.8 support output_config.format).
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low', format: { type: 'json_schema', schema: OUTPUT_SCHEMA } },
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{
      role: 'user',
      content: `Current voice on the DX (in the answer's shape, plus derived algorithm/frequency/effect info):\n${
        JSON.stringify({ ...toOutputShape(current.values), name: current.values.name, derived: current.derived })}\n\nRequest: ${prompt}`,
    }],
  }, { signal, timeout: TIMEOUT_MS, maxRetries: 0 });
  const usage = toUsage(msg.usage);
  if (msg.stop_reason === 'refusal') {
    throw new AiFailure('refused', `declined${msg.stop_details?.category ? ` (${msg.stop_details.category})` : ''}`, usage);
  }
  if (msg.stop_reason === 'max_tokens') throw new AiFailure('invalid', 'reply was cut off at max_tokens', usage);
  const text = msg.content.find((b) => b.type === 'text');
  let output: unknown;
  try {
    output = JSON.parse(text?.text ?? '');
  } catch {
    throw new AiFailure('invalid', 'reply is not valid JSON', usage);
  }
  try {
    return { design: validateDesign(output), usage, model: msg.model };
  } catch (err) {
    throw err instanceof AiFailure ? new AiFailure(err.kind, err.message, usage) : err;
  }
}

/** One server-log line per finished job: duration, tokens, estimated cost. Holds no credentials. */
export function logAiJob(job: AiJob, ms: number, note = ''): void {
  const u = job.usage;
  const tokens = u ? ` · tokens in ${u.inputTokens} out ${u.outputTokens} cache-read ${u.cacheReadTokens} cache-write ${u.cacheWriteTokens} · ≈$${u.estUsd.toFixed(4)}` : '';
  const what = job.state === 'error' ? `${job.error!.kind}: ${job.error!.message}`
    : job.result ? `${job.result.name} · ${job.result.changedCount} changed · ${job.result.summary}` : '';
  console.log(`[ai] ${job.jobId} ${job.state} in ${(ms / 1000).toFixed(1)} s${tokens} · "${job.prompt}"${what && ` → ${what}`}${note && ` · ${note}`}`);
}

/** SDK errors → the user-facing kind. Most specific first: the timeout error is a connection error, which is an APIError. */
export function toAiError(err: unknown): { kind: AiErrorKind; message: string } {
  if (err instanceof AiFailure) return { kind: err.kind, message: err.message };
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return { kind: 'auth', message: `API error ${err.status} · check ANTHROPIC_API_KEY in .env` };
  }
  if (err instanceof Anthropic.RateLimitError) return { kind: 'rate', message: 'API error 429 · rate limited, retry in a moment' };
  if (err instanceof Anthropic.APIConnectionTimeoutError) return { kind: 'timeout', message: `no reply within ${TIMEOUT_MS / 1000} s` };
  if (err instanceof Anthropic.APIConnectionError) return { kind: 'network', message: 'network offline' };
  if (err instanceof Anthropic.APIError) return { kind: 'network', message: `API error ${err.status}` };
  return { kind: 'network', message: (err as Error).message }; // not from Claude, e.g. the DX vanished before the write
}
