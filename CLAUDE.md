# reface DX editor

A local Node server owns the USB-MIDI link to a Yamaha reface DX. Two clients share its single voice state: a React web panel (design "B — Light Spine") and AI sound design. The AI either runs through Claude Code driving `cli/dx.ts`, or through the panel's prompt bar, which calls the Claude API.

## Run
- Node ≥ 24 is required: it runs TS natively, with erasable syntax only (no enums/namespaces, `.ts` import extensions), and supports `--env-file-if-exists`.
- `npm install` → `npm run web:build` → `npm start` → http://localhost:7777. For UI work, `npm run web:dev` serves on :5173 and proxies to :7777.
- Gates: `npm test`, `npm run typecheck` (covers web/ too).
- `.env` is gitignored and holds `ANTHROPIC_API_KEY=`. Only the server reads it. Never print, log, cat or commit the key.

## Where things are (read before changing)
- `shared/params.ts` is the single source of truth for all 124 params: ids, ranges, enums, algorithm topology, frequency display. The UI, the CLI, and the AI prompt and schema are generated from it. Never duplicate the table.
- `docs/sysex-spec.md`: the protocol, with a confidence tag on every fact.
- `docs/architecture.md`: server behaviour, the HTTP/WS/CLI API, decisions, measured device timing.
- `design/README.md`: the UI spec, plus **Implementation status** (deviations from Paper and still-unconfirmed items).
- The browser never talks MIDI. All writes go through the server (WS `set` / HTTP).

## Driving the synth from Claude Code
- With the server running: `node cli/dx.ts status | params [group] | get | set op1.level=100 algorithm=5 | put file.json | refresh | undo | redo | presets [--scan] | load 2-3 | play pad | thru ["<port>"|off] | patches | save <name> | open <name> | ai "<prompt>"`. Output is compact JSON. `dx thru` is MIDI thru: a controller keyboard (e.g. "Keystation 49 MK3 (USB MIDI)") plays the DX; the choice is saved in `data/settings.json`.
- Values are in the panel domain: algorithm 1–12, transpose −24..24, detune −64..63, enums as strings. `dx params` lists ranges. Note names use C4 = 60.

## Device safety (a real instrument that may hold unsaved work)
- MIDI writes only reach the edit buffer. Nothing can store to a slot over MIDI: the user presses STORE on the DX. Never claim otherwise.
- Before any write test, run `dx save <name>`; restore it afterwards. If `dx status` shows the user changed voices in the meantime, leave their state alone and report.
- Loading a preset (Program Change) discards unsaved edits, so check `dirty` first.
- Never write the System block (MIDI Control, local control, auto power-off). Read it only.
- Never put a carrier in FIXED mode below about 20 Hz: the owner's manual warns about speaker damage, and the AI validator rejects it.
- A preset scan switches through all 32 voices (about 7.5 s). Don't repeat it needlessly; the result is cached.

## Gotchas
- The DX streams F8 clock and FE active sensing nonstop, and CoreMIDI fragments SysEx. `server/midi.ts` handles both.
- Panel edits on the DX are announced only for FM-section CCs, and only when MIDI Control is ON (it is ON on this unit). Everything else arrives through 1.5 s dump polling.
- AI: model `claude-opus-5-5`, effort `low`, structured output. A flat 124-property schema fails with "compiled grammar is too large", so the schema is nested as `{common, operators[4]}`. Forced `tool_choice` returns a 400 on this model. Tune `server/ai-prompt.ts`, not the schema.
- The UI is one 1440×900 canvas scaled to fit the window (`useViewportFit` in `web/src/controls.tsx`). Convert pointer math to design px; never mix `clientX` with unscaled `offsetWidth`.

## Working agreements
- Design source: a private Paper file (artboards `B — …`); `design/README.md` and the PNGs in `design/` are the public reference.
- UI copy is English.
- Don't commit or push unless asked.
