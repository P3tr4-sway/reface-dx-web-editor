// Wire types shared by server, CLI and web UI. HTTP JSON bodies and WebSocket (/ws) messages.
import type { DerivedVoice, ParamValue, VoiceValues } from './params.ts';

export const DEFAULT_PORT = 7777;

export type ChangeSource = 'ui' | 'api' | 'device' | 'preset' | 'undo';
export interface ParamChange { id: string; value: ParamValue }

/** Read-only view of the System block (00 00 00). The server never writes it. */
export interface SystemInfo {
  txChannel: number | null; // 1..16, null = off
  rxChannel: number | 'ALL';
  localControl: boolean;
  /** When false the DX sends no FM-section CCs, so panel edits are only seen by polling. */
  midiControl: boolean;
  autoPowerOff: boolean;
  masterTranspose: number;
}

export interface DeviceStatus { connected: boolean; port: string; system: SystemInfo | null }

/** MIDI thru: one selectable CoreMIDI input played into the DX (docs/architecture.md "MIDI thru"). */
export interface ThruStatus {
  /** Selected input port, null = thru off. Saved in data/settings.json and restored at startup. */
  port: string | null;
  /** The selected port is present and open. */
  connected: boolean;
  /** Input ports that can be selected right now (never the DX's own port). */
  inputs: string[];
  /** Messages forwarded to the DX since the server started. */
  forwarded: number;
}

export type BusyState = { task: 'scan'; done: number; total: number; message: string };

export interface Status {
  device: DeviceStatus;
  voiceName: string | null;
  /** 0..31 (= Program Change number) or null when unknown. */
  currentSlot: number | null;
  currentSlotLabel: string | null; // "2-3" = bank 2, voice 3
  /** Current voice differs from the cached stored voice of currentSlot; null = unknown (no cache). */
  dirty: boolean | null;
  canUndo: boolean;
  canRedo: boolean;
  busy: BusyState | null;
  presetsScannedAt: string | null;
  /** AI sound design: configured = the server has an ANTHROPIC_API_KEY (the key itself never leaves the server). */
  ai: { configured: boolean; model: string };
  thru: ThruStatus;
}

export interface VoiceResponse {
  values: VoiceValues;
  derived: DerivedVoice;
  currentSlot: number | null;
  dirty: boolean | null;
  /** Only with ?raw=1: hex of the 38 common bytes and 4×28 operator bytes. */
  raw?: { common: string; ops: string[] };
}

export interface PresetEntry { slot: number; label: string; name: string }

export interface PresetScan {
  scannedAt: string;
  presets: PresetEntry[];
  backupDir: string;
  originalSlot: number | null;
  /** Final dump equals the edit buffer captured before the scan. */
  editBufferPreserved: boolean;
  editBufferRewritten: boolean;
}

export interface PatchInfo { name: string; voiceName: string; savedAt: string }
/** File format of data/patches/<name>.json */
export interface PatchFile { name: string; savedAt: string; values: VoiceValues }

export type AuditionPreset = 'chord' | 'arp' | 'bass' | 'lead' | 'pad' | 'keys';
export interface AuditionRequest {
  /** A preset name or an explicit chord like "C4,E4,G4". Default "chord". */
  what?: string;
  velocity?: number; // 1..127, default 100
  duration?: number; // seconds per step, default depends on preset
}

export type AiState = 'designing' | 'writing' | 'done' | 'error' | 'cancelled';
export type AiErrorKind = 'auth' | 'network' | 'rate' | 'refused' | 'invalid' | 'timeout';
/** Tokens of one Claude call; estUsd at Opus 5.5 list prices ($4 in, $20 out, $0.20 cache read, $5 cache write per MTok). */
export interface AiUsage { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; estUsd: number }
/** One AI sound-design job (POST /api/ai/generate). `result` is set from `writing` on, `error` only in `error`. */
export interface AiJob {
  jobId: string;
  state: AiState;
  prompt: string;
  startedAt: string;
  result?: { name: string; summary: string; changedCount: number; audition: AuditionPreset };
  error?: { kind: AiErrorKind; message: string };
  usage?: AiUsage;
}

// ---- HTTP responses ----
export interface ApplyResponse { applied: ParamChange[]; dirty: boolean | null }
export interface LoadResponse { slot: number; label: string; name: string; warning?: string; note: string }
export interface AuditionResponse { played: string[][]; durationMs: number }
export interface ErrorResponse { error: string }

// ---- WebSocket ----
export type ServerMessage =
  | { type: 'state'; status: Status; voice: VoiceResponse | null; presets: PresetScan | null; ai: AiJob | null }
  | { type: 'voice-changed'; source: ChangeSource; changes: ParamChange[]; status: Status }
  | { type: 'presets'; scan: PresetScan }
  | { type: 'device'; device: DeviceStatus }
  | { type: 'note'; on: boolean; note: number; velocity: number }
  /** An audition phrase was scheduled (by any client or the AI): step i sounds from i*stepMs for 0.9*stepMs. */
  | { type: 'audition'; what: string; steps: number[][]; stepMs: number; velocity: number; ai: boolean }
  | ({ type: 'ai' } & AiJob)
  | { type: 'busy'; busy: BusyState | null }
  /** Thru selection, connection or the input list changed. */
  | { type: 'thru'; thru: ThruStatus }
  /**
   * A note on/off from the thru input reached the DX (velocity 0 on off), or thru released a held note (switch, off,
   * input unplugged, DX reconnect). The panel lights the key while it is held and blinks its MIDI-in dot on note-on.
   */
  | { type: 'thru-note'; on: boolean; note: number; velocity: number }
  | { type: 'error'; message: string };

export type ClientMessage =
  /** High-rate partial changes (slider drags). Out-of-range numbers are clamped, not rejected. */
  | { type: 'set'; values: Record<string, unknown> }
  | { type: 'audition'; request: AuditionRequest }
  /** A held key from the on-screen keyboard. The server releases this client's held notes when its socket closes. */
  | { type: 'note'; on: boolean; note: number; velocity?: number }
  /** Select the thru input by name (one of `status.thru.inputs`), or null for off. */
  | { type: 'thru'; port: string | null };
