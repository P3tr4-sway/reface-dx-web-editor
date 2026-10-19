# reface DX editor — architecture, API reference, decisions

Shared parameter model + SysEx codec, a local Node server that owns the MIDI port, the AI-mode CLI, the web panel (`web/`,
built and served from `web/dist`), in-panel AI sound design (Claude Opus 5.5, server-side) and MIDI thru (a controller
keyboard plays the DX through the server). The web panel and the CLI are
both clients of the same server, so they always see one state.
Protocol facts come from `docs/sysex-spec.md`; anything measured on the user's unit is marked **DEV** below.

```
 Claude Code ──> cli/dx.ts ──HTTP──┐                                  ┌──── designVoice (server/ai.ts) ── Claude API (HTTPS)
                                   ├──> server (127.0.0.1:7777) ── Editor ── VoiceState (voice, slot, dirty, undo)
 web panel ─────── WebSocket /ws ──┘                                  └──── DxDevice ── OutQueue ── MidiTransport ── CoreMIDI "reface DX"
 controller (e.g. Keystation) ── CoreMIDI input ── InputPort ── Thru (allowlist, channel) ─────────────────┘ (direct send)
```

## Run

```
npm install
npm start                        # server on http://127.0.0.1:7777 (serves web/dist if it exists; loads ./.env if present)
npm run dx -- status             # or: node cli/dx.ts status
npm test && npm run typecheck
```

Env: `PORT` (7777), `DX_MIDI_PORT` (`reface DX`), `DX_DATA_DIR` (`./data`), `ANTHROPIC_API_KEY` (in the gitignored `.env`,
loaded by `node --env-file-if-exists=.env`; enables AI sound design), CLI: `DX_URL` (`http://127.0.0.1:7777`).
The server starts and serves even when the DX is absent; it rescans the port list every 2 s.

## Files

| File | Purpose |
|---|---|
| `shared/params.ts` | Param schema (124 params, single source of truth), raw<->value codec per param, validation/clamp, derived helpers (frequency, fx param names, algorithm topology) |
| `shared/codec.ts` | Checksum, bulk/param-change/dump-request builders, 7-message voice dump parse/build, FM-section CC map, hex/.syx helpers |
| `shared/protocol.ts` | HTTP response + WebSocket message types (import these in the web UI) |
| `server/midi.ts` | Byte-stream MIDI parser (SysEx reassembly, F8/FE filtering, running status) + CoreMIDI port transport with presence scan + `InputPort` (the input-only thru port, same scan) |
| `server/thru.ts` | MIDI thru: the allowlist (`thruMessage`), channel rewrite, held-note/sustain tracking and release, loop guard |
| `server/device.ts` | `OutQueue` (single serialized outbound queue with per-address coalescing) + `DxDevice` (dumps with footer wait/timeout/retry, PC+dump, bulk write, notes) |
| `server/state.ts` | `VoiceState`: current voice bytes, current slot, dirty, undo/redo batching, write generation (stale-dump guard) |
| `server/editor.ts` | Orchestration: edits, polling sync, CC/PC from the device, preset scan/load, audition, patches |
| `server/audition.ts` | Audition presets and note-name parsing |
| `server/ai.ts` | AI sound design: the Claude call (structured output), output schema, validation + safety rule, error kinds, cost/log line |
| `server/ai-prompt.ts` | The system prompt (FM sound-design briefing); parameter facts generated from `shared/params.ts` |
| `server/storage.ts` | `data/backups/<ts>/` (.syx + presets.json), `data/patches/<name>.json` and `data/settings.json` (thru port) |
| `server/http.ts` | HTTP routes, WebSocket `/ws`, static `web/dist` |
| `server/main.ts` | Entry point, timing constants, signal handling (all-notes-off on exit) |
| `cli/dx.ts` | AI-mode CLI |

## Parameter model

- One param = one hardware byte; `name` = the 10 name bytes as one string param. Ids: `name, transpose, partMode, …, fx2Param2`
  and `op1.enabled … op4.detune` (full list: `GET /api/params` / `dx params`).
- Values are in the panel/display domain: `algorithm` 1..12, `transpose`/`pitchBendRange` -24..24, `pegLevelN` -48..48,
  `opN.detune` -64..63, `opN.fine` 0..99, `opN.coarse` 0..31, enums as strings, switches as booleans, everything else 0..127.
  `raw = value + bias` for ints; tests prove the mapping is a bijection over every param's full range.
- KSL depth/curve and feedback level/type stay separate params (one byte each); the panel's signed -127..127 views are
  inferred in the spec (§2.3) and are left to the UI.
- The voice is stored as raw bytes (`VoiceData`), so reserved bytes are always preserved verbatim from the last dump.
- Derived, read-only (`GET /api/voice` → `derived`): `algorithm` {carriers, edges, confidence}, `frequencies[4]`
  (RATIO: `coarse==0 ? 0.5+fine*0.005 : coarse+fine/100`; FIXED: `10^((coarse>>3)+fine/100)` with `estimated:true`,
  spec §3.2 unresolved), `fx1`/`fx2` param names for the selected effect type.
- Validation: HTTP rejects bad ids/values with 400 and a message naming the param and the allowed range; the WS `set`
  path clamps numbers (slider input). Names: printable ASCII, ≤10 chars.

## Server behaviour

**Outbound queue.** Every byte to the DX goes through one `OutQueue`. Param changes are keyed by address and coalesce
(latest value wins) while queued, but never across a non-param job, so a later edit cannot jump ahead of a bulk write
that would overwrite it. Jobs (dump request, PC+dump, bulk write, notes) run strictly in order; a dump job blocks the
queue until its footer arrives, so nothing interleaves with a reply. 1 ms gap after each param change; 20 ms between
the 7 bulk-write messages.

**Dumps.** Request `0E 0F 00`, collect from header to footer `0F 0F 00`, validate byte counts + checksums + block
layout; 2 s timeout, one retry, malformed replies rejected. System block `00 00 00` is read (never written) and exposed
in `status.device.system`.

**Hardware → panel sync.** (a) When the queue has been write-idle ≥ 1.5 s the server polls a dump every 1.5 s, diffs it,
and broadcasts `voice-changed` with `source:"device"`. Every local state change bumps `writeGen`; a dump is applied only
if `writeGen` is unchanged since it was requested, so a dump requested before a write never overwrites newer state.
(b) FM-section CCs (spec §6.3) are applied instantly when they arrive (only sent when System MIDI Control is ON).
(c) An incoming Program Change sets `currentSlot`, then dumps; the dump is cached as that slot's stored voice.

**Voice state.** `currentSlot` (0..31 or null), `dirty` = current voice ≠ cached stored voice of that slot (null when
unknown), undo/redo of voice snapshots: changes from the same source within 500 ms form one batch (a slider drag is one
undo step). Device-detected changes and preset loads are undoable too (undo writes the old voice back into the edit
buffer). Undo/redo/PUT/patch-load write the whole voice with one bulk write. At startup the latest backup warms the
stored-voice cache and `currentSlot` is inferred when the edit buffer byte-equals exactly one stored voice.

**Presets.** Scan = dump edit buffer E → for slot 0..31: PC + dump (waits for the footer each time) → original slot =
known `currentSlot`, else the unique slot byte-equal to E, else the unique name match, else unknown → PC to it → if E
differs from that slot's stored voice (or the slot is unknown), bulk-write E → dump again and assert it equals E
(`editBufferPreserved`). Writes are rejected (409) and polling paused while scanning. If a slot does not answer (after the
retry) the scan writes E back into the edit buffer and fails with 502 saying whether that restore worked. Backup: `data/backups/<ts>/` with
`1-1_DigiChord.syx` … , `all.syx` (32 × 241 bytes), `presets.json`. Loading a preset = PC + dump; the response warns when
the previous voice was dirty (or unknown). There is no MIDI command to store into a slot (spec §6.4): loads of patches
say "loaded into edit buffer — press STORE on the DX to keep".

**Audition.** Notes on channel 1 (DX receive channel is ALL on this unit). Every note-on gets a note-off; on shutdown the
server sends note-offs for sounding notes plus CC123. Note names are scientific pitch: C4 = MIDI 60 (the DX manual calls
this C3).

**MIDI thru.** One selectable CoreMIDI input (e.g. "Keystation 49 MK3 (USB MIDI)") is played into the DX. The selection
is saved in `data/settings.json` (`{"thruPort": name|null}`, default off; a missing or unreadable file means off) and
restored at startup; a saved port that is not plugged in stays selected (`connected:false`) and opens when it appears.
The input list is rescanned every 2 s like the DX port, so unplug/replug recovers by itself. The DX's own port
(`DX_MIDI_PORT`) is never listed or accepted, not even from the settings file (its output fed back to it would loop);
every other input is listed as CoreMIDI names it. Bytes go through `MidiStreamParser`, then one allowlist
(`thruMessage` in `server/thru.ts`): note on/off, pitch bend, channel pressure (the DX ignores it, spec §6.3) and CC 1, 7,
11, 64 pass; SysEx (could write the System block), Program Change (discards unsaved edits), every other CC (80 and 85–119
FM-section CCs would silently edit the voice; 120–127 channel mode, 122 = Local Control), poly aftertouch, system common
and realtime (F8 would switch the DX to external sync; FE arms its 350 ms active-sensing mute) are dropped. The input port
also ignores SysEx/clock/sensing at the driver. Messages are rewritten to the DX receive channel (System RX channel; channel
1 when it is ALL or not read yet) and sent **directly to `MidiTransport`, not through `OutQueue`**. Held notes and the
sustain pedal are tracked per channel; a port switch, thru off, the input disappearing, the DX reconnecting and shutdown
send note-offs for held notes plus sustain off (kept while the DX is absent, sent when it returns). Messages that cannot
be delivered (DX absent) are dropped, not counted. `status.thru.forwarded` counts delivered messages; each delivered
note on/off is broadcast as WS `thru-note` {on, note, velocity}, and a release broadcasts an off for every note it
silences, so the panel's lit thru keys always equal the held set (pedal-held notes are not keys: they go dark at
their note-off; while the DX is absent they stay lit until its return releases them).

**Presence.** The port list is rescanned every 2 s; on loss the ports are closed and `device` is broadcast with
`connected:false`; on return they are reopened and the System block + voice are re-read.

## Device timing and facts (measured on the user's unit, 2026-10-17)

| Fact | Result | How |
|---|---|---|
| Param-change rate | **No limit found up to a 272-message (≈3 KB) burst.** 68 distinct param changes sent in 0.6 ms (no gap) and at 0.5/1/2/5 ms gaps: 0 lost in every run. 272 changes (68 addresses × 4 values) in a 0.5 ms burst: all 68 final values correct, 0 untargeted bytes changed. 100-write sweep of one address: final value landed at 0 and 1 ms gaps | `/tmp` script: random in-range writes (op params except level), then dump + byte compare against a snapshot taken immediately before; voice restored after |
| Chosen param gap | 1 ms: the device needs no gap at all; 1 ms only yields the event loop between sends and lets same-millisecond updates of one param coalesce (≥1000 msg/s, far above any UI rate) | derived from the row above |
| Bulk-write gap | 0, 2, 5, 10, 20 ms all read back byte-identical (one trial each). Kept 20 ms (spec §6.5) because one trial per gap is thin evidence and 20 ms costs only ~140 ms per bulk write | write modified voice, dump, compare |
| Dump round trip | 18–25 ms (10 samples); refresh via HTTP ≈ 21 ms | timed `readVoice()` |
| PC + dump | ≈ 215–240 ms per slot (the DX takes ~200 ms to switch voices before answering); full 32-slot scan ≈ 7.5 s | WS `busy` timestamps, timed `dx load` |
| Param change with MIDI Control OFF | works | all of the above ran with System 0x0E = 0 (MIDI Control has since been switched ON, see below) |
| System block | TX ch 1, RX ALL, local control ON, master transpose 0, auto power-off ON, **MIDI Control OFF** (raw `00 10 00 04 01 0F 01 40 00 78 20 01 01 01 00 4C 01 00…`) | `F0 43 20 7F 1C 05 00 00 00 F7` |
| MIDI Control now | **ON** (observed 2026-10-18, `status.device.system.midiControl: true`): FM-section CCs should now arrive (not exercised); other panel edits are still seen only by polling | `/api/status` |
| Panel voice select | **Transmits Program Change** (with MIDI Control OFF): the user selected 4-2, 4-7, 4-3, 4-4, 4-8, 4-7 on the panel and the server logged each PC, re-read the voice and showed `currentSlot` 4-7 GlassHarp, `dirty:false` (answers spec open question 10) | server log |
| Out-of-band edit | A param change written to the DX by another CoreMIDI client was picked up by the idle poll 1.5 s later and broadcast as `voice-changed` `source:"device"` | WS log |
| Stored voices | Names match the spec §7.2 factory list except **slot 2-4, stored as `=i>Tune`** (bytes `3D 69 3E 54 75 6E 65`, list says "BitTune") | preset scan |
| Port presence | CoreMIDI port list refreshes inside the running process: a virtual "Fake DX" endpoint was detected gone within one 2 s scan and reconnected + re-synced when it returned (a physical unplug was not tested) | virtual-port simulator |

## HTTP API (JSON; errors are `{"error": "..."}` with 400 / 404 / 405 / 409 busy / 503 not connected)

| Method + path | Body | Response |
|---|---|---|
| `GET /api/status` | – | `Status` (device + system, voiceName, currentSlot/Label, dirty, canUndo/Redo, busy, presetsScannedAt) |
| `GET /api/voice[?raw=1]` | – | `VoiceResponse` {values, derived, currentSlot, dirty[, raw hex]} |
| `PATCH /api/voice` | `{id: value, …}` (strings accepted, e.g. `"100"`, `"on"`) | `ApplyResponse` {applied, dirty}; 400 lists every bad id/value |
| `PUT /api/voice` | every param `{id: value}` or `{values: {...}}` | bulk write; 400 if any param missing |
| `POST /api/voice/refresh` | – | re-reads the edit buffer → `VoiceResponse` |
| `POST /api/undo`, `POST /api/redo` | – | `ApplyResponse`; 409 when nothing to undo/redo |
| `GET /api/params` | – | `ParamDef[]` (id, label, group, description, block/op/offset, kind + range/options/length) |
| `GET /api/presets` | – | cached `PresetScan` or `{presets:null, hint}` |
| `POST /api/presets/scan` | – | `PresetScan` {presets[32], originalSlot, editBufferPreserved, editBufferRewritten, backupDir} |
| `POST /api/presets/:slot/load` | slot `2-3` or `0..31` | `LoadResponse` {slot, label, name, warning?, note} |
| `POST /api/audition` | `{what?: preset|"C4,E4,G4", velocity?: 1..127, duration?: s}` | {played, durationMs} |
| `GET /api/thru` | – | `ThruStatus` {port, connected, inputs, forwarded} (also `status.thru`) |
| `PUT /api/thru` | `{port: "<input name>"}` or `{port: null}` (off) | `ThruStatus`; saved to `data/settings.json`; 400 for an unknown port, the DX's own port, or a bad body |
| `GET /api/patches` | – | `PatchInfo[]` |
| `POST /api/patches` | `{name}` | saves the current voice → {name, file} |
| `POST /api/patches/:name/load` | – | applies the patch values on top of the current voice, bulk write → {name, note, applied, dirty} |
| `POST /api/ai/generate` | `{prompt}` (1..500 chars) | starts one AI job → `{jobId}` at once; 400 bad prompt, 503 no DX / no `ANTHROPIC_API_KEY`, 409 a job, scan or preset load is running |
| `POST /api/ai/cancel` | – | aborts the Claude request → `{jobId}`; 409 when no job runs or it is already writing |
| `GET /api/ai` | – | current/last `AiJob` {jobId, state, prompt, startedAt, result?, error?, usage?} or `null` |

## WebSocket `/ws` (types: `ServerMessage`, `ClientMessage` in `shared/protocol.ts`)

Server → client: `state` (full snapshot on connect: status, voice, presets) · `voice-changed` {source: ui|api|device|preset|undo,
changes, status} · `presets` · `device` · `note` {on, note, velocity} for keys played on the DX · `busy` (scan progress) ·
`error` (reply to a bad client message) · `audition` {what, steps, stepMs, velocity, ai} whenever a phrase is scheduled (the UI
lights those keys white) · `ai` (the `AiJob`, on every state change; the `state` snapshot carries the current job as `ai`) ·
`thru` {thru: ThruStatus} when the thru selection, its connection or the input list changes · `thru-note` {on, note, velocity}
for every note on/off the thru delivered (velocity 0 on off) and for every held note a thru release silences (the panel
lights those keys like DX-held ones and blinks its MIDI-in dot on note-on; the `state` snapshot carries no held keys, so
a new socket starts with none lit).
`Status` includes `ai: {configured, model}` — never the key. Client → server: `{type:"set", values:{…}}` (high rate, clamped, coalesced),
`{type:"audition", request}`, `{type:"thru", port}` (same as `PUT /api/thru`) and `{type:"note", on, note, velocity?}` (a held key from the web keyboard: note 0..127,
velocity 1..127, default 100; sent through the same note path as audition). The server tracks each socket's held notes
and sends their note-offs when that socket closes, so closing the tab mid-note cannot hang a note.

## CLI (`node cli/dx.ts …` / `npm run dx -- …`)

Prints one line of JSON; errors go to stderr as `{"error": …}` with exit 1 (API error) or 2 (server not running → "npm start").
`status | params [group] | get [--raw] | set id=value … | put <file.json|-> | refresh | undo | redo | presets [--scan] |
load <bank-voice> | play [preset|notes] [--vel N --dur S] | thru ["<port>"|off] | patches | save <name> | open <name> | ai "<prompt>"`.
`dx thru` prints `ThruStatus`; `dx thru "<port>"` selects an input (names as listed in `inputs`); `dx thru off` turns it off.
`dx ai` starts a job, polls `GET /api/ai` until it ends and prints `{name, summary, changedCount, audition, usage, seconds}`;
error/cancel → stderr + exit 1; Ctrl-C while designing cancels the job.

## AI sound design

Prompt bar (web) or `dx ai` → `POST /api/ai/generate` → job `designing` → one Claude call → server-side validation →
`writing` (one bulk write through the same path as PUT, source `api`, i.e. one undo step that the UI renders with the AI
chip) → `done` → the chosen audition phrase plays 150 ms later. Every state change is broadcast as WS `ai`.

- **Call** (`server/ai.ts`): `claude-opus-5-5`, `output_config: {effort: "low", format: json_schema}`, adaptive thinking (the
  model default; it cannot be disabled), `max_tokens` 16 000 (non-streaming), 90 s timeout, no SDK retries. System prompt
  (`server/ai-prompt.ts`, ≈6 k tokens; ≈11.6 k with the schema) is byte-stable and marked `cache_control`; the current voice
  (`values` + `derived`) and the request go in the user message only. Server-side refusal fallback: `fallbacks: "default"`
  with beta `server-side-fallback-2026-07-01`.
- **Output**: `{common: {24 voice params}, operators: [4 × {24 operator fields}], name, summary, audition}` — every param
  id except `name`, flattened back to `opN.field` ids before validation. The operator object is declared once because a flat
  object with all 123 ids was rejected by the API (`400 compiled grammar is too large`; `count_tokens` does not compile the
  grammar, so only a real request finds this). The schema is generated from `PARAMS` (types and enums only: structured
  outputs do not support numeric ranges); the current voice is sent in the same shape. `stop_reason` `refusal` → error `refused`,
  `max_tokens` → `invalid`, both before content is read.
- **Validation** (always): unknown/missing ids, wrong types, enum mismatches → `invalid`, nothing written; out-of-range numbers
  are clamped (counted in the log); names cut to 10 chars; **safety**: a carrier (per the algorithm topology) in FIXED mode
  below 20 Hz (estimated) → `invalid` (owner's manual: can damage speakers; the prompt says so too).
- **Errors** (`error.kind`): `auth` (401/403), `rate` (429), `timeout` (90 s), `network` (connection or other API status,
  message `API error 529` / `network offline`), `refused`, `invalid`. Cancel aborts the request (AbortController) → `cancelled`.
- **Measured (2026-10-18, real calls)**: new design 15.2 s / 11.4 s, ≈1.4 k input + ≈8.4 k cache-write + ≈1.2 k output tokens
  ≈ $0.073; relative edit with a warm cache 10.4 s, ≈ $0.032 (8.4 k cache-read).
- **Log**: one line per job in the server log: duration, input/output/cache-read/cache-write tokens, estimated cost at
  $4 / $20 / $0.20 / $5 per MTok, result or error. The key is never logged, returned or sent to the browser.
- **Busy rules**: one job at a time; a scan or preset load is refused (409) while a job runs, and a job is refused while they
  run. Slider/panel edits during `designing` are allowed; the write then replaces them (undo restores them).

## Decisions

- **Server owns the port**; clients never talk MIDI. One queue, one state; HTTP and WS call the same `Editor` methods.
- **Raw bytes are the state**, values are derived → reserved bytes can never be invented, and the schema stays the only mapping.
- **Write generation instead of timestamps** for stale dumps: simple and exact, because the queue is FIFO (writes enqueued
  before a dump request are on the device before it is answered).
- **Send every requested value, broadcast only real changes**: the device may hold an unpolled panel edit equal to a stale state value.
- **Whole-voice operations use one bulk write** (undo/redo, PUT, patch load) instead of choosing between bulk and param diffs:
  one code path; 140 ms is acceptable for these.
- **Busy lock (409) during scan / preset load** instead of merging concurrent edits into a voice that is being replaced.
- **System block is read-only** (MIDI Control, local control, auto power-off are reported, never changed).
- **Note names use C4 = 60**; documented because Yamaha's own naming is one octave lower.
- **AI: structured outputs, not a tool call**: forced `tool_choice` is a 400 on Opus 5.5 and we only need JSON back.
- **AI: refusal fallback kept with structured outputs**: the fallback docs say the fallback model runs the same request and
  that a request the fallback model cannot serve is rejected up front; the default targets (Opus 5 / Opus 4.8) support
  `output_config.format`. The real calls were accepted with both.
- **AI: the server owns the 90 s deadline**, not the browser (the design's 60 s client give-up was dropped): a page that gave
  up early could show an error while the voice still lands on the DX.
- **AI: prompt and schema are generated from `shared/params.ts`**, so adding or renaming a param cannot desynchronise them.
- **Web panel = one 1440×900 canvas scaled to fit the window** (`transform: scale(min(w/1440, h/900))`, centred, letterboxed
  in black, up- and down-scaling; the former 1280-wide layout variant was removed). A transform rather than CSS `zoom`
  because its coordinate model is the same in every browser. Layout/SVG/ResizeObserver sizes stay in design px; pointer
  input is converted once (`useDrag` deltas and the envelope editor divide by `viewScale`), verified at 0.82× and 1.2×.
- **MIDI thru is an allowlist, not a blocklist**: only what a player needs (keys, pedal, bend, mod/volume/expression,
  pressure) can reach the instrument, so a controller's transport buttons, clock, SysEx or a stray CC map can never edit the
  voice, change a System setting or discard edits. Kept in one function (`thruMessage`) with the reason for each block.
- **MIDI thru sends directly, bypassing `OutQueue`**: queued, a note would wait behind a dump job (until its reply: ~20 ms,
  up to 2 × 2 s on timeout) or a bulk write (~140 ms). Direct sends cannot split a SysEx: `MidiTransport.send` is
  synchronous and RtMidi 6.0 (`MidiOutCore::sendMessage`) hands CoreMIDI each whole message as one `MIDIPacket`, so a
  thru message lands only between two outgoing messages. It can land between the 7 blocks of a bulk write (20 ms apart),
  which no note did before; spec §1.4 only forbids foreign *blocks* inside a voice stream, and this is untested on the
  device. Tested: a thru note goes out while a dump holds the queue, a web-keyboard note does not (`test/thru.test.ts`).
- **AI writes reuse the PUT path with source `api`** (the CLI/AI source the UI already renders as the AI chip), so undo,
  dirty and the bloom need no new code.

## Open issues

- Not verified on hardware: FM-section CC handling (MIDI Control is now ON, but CC behaviour was not exercised; mapping is unit-tested) and a
  physical USB unplug (only a virtual endpoint was removed).
- Scan order follows the brief: a known `currentSlot` wins over byte-equality. Since the panel sends PC, `currentSlot` is
  only stale if a PC is missed (e.g. voice changed while the server was down or the cable was out — `currentSlot` is
  cleared on disconnect for that reason).
- Fixed-mode frequency (spec §3.2) and ALGO 6/9/10/11 numbering (spec §5) remain estimates (flagged in `derived`).
- Polling (one 241-byte dump every 1.5 s when idle) is unverified for audible side effects while playing. Thru makes
  playing through the server common: thru sends do not count as writes, so polling continues while a controller plays.
- MIDI thru on the real DX is only partly verified (2026-10-18). Through real CoreMIDI against a virtual DX endpoint
  (RX channel 5): 12/12 allowed messages arrived rewritten to channel 5; PC, F8, FE, CC 122, CC 85, CC 80 and a System
  SysEx were dropped; release on off; loop guard. On the real server: selection, persistence across a restart, a virtual
  input vanishing (`connected:false`, selection kept), and `forwarded` reached 892 messages delivered to "reface DX"
  from the Keystation while someone played it (no test notes were sent to the real DX). Whether they sounded was not
  observed; unplugging the Keystation was not tested.
- Web-keyboard and audition notes still go through `OutQueue`, so they can wait behind a dump; thru notes do not.
- `dirty` relies on the cached stored voice; a STORE done on the panel is not visible over MIDI, so the cache goes stale until
  the next scan/load of that slot.
