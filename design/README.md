# reface DX editor: visual design (chosen direction: B, "Light Spine")

**Paper file:** `reface DX — Editor` (private; the PNGs below are exported from it)

| Page | Artboard | PNG |
|---|---|---|
| B — Light Spine | `B — Light Spine · Editor` (1440×900) | `direction-b.png` |
| B — Light Spine | `B — Light Spine · Library open` (1440×900) | `direction-b-library.png` |
| B — Light Spine | `B — Components` (1440×1844, state sheet) | `direction-b-components.png` |
| B — Light Spine | `B — AI Prompt · In context` (1440×900, bar generating) | `ai-prompt-context.png` |
| B — Light Spine | `B — AI Prompt · States` (1440×2348, bar states + Done in context) | `ai-prompt-states.png` |
| A — Colour Field | `A — Colour Field · Editor` (not chosen, reference only) | `direction-a.png` |

For exact values, read Paper with `get_jsx` / `get_computed_styles`. Use screenshots only to check the result.

**Status (2026-10-18):** B and the AI prompt bar are implemented in `web/`. This document describes the build as shipped. Where the build deliberately differs from Paper, the text below says so, and [Implementation status](#implementation-status-2026-10-18) at the end collects every deviation, everything that is still unconfirmed, and the repository state. Screenshots of the real build against the real DX are in `design/impl/` (`editor.png`, `library.png`, `interaction.png`, `ai-generating.png`, `ai-done.png`, `fit-1280x740.png`, `fit-1440x900.png`, `fit-1920x1080.png`, `no-dx.png`, `server-offline.png`). The `B — Light Spine · Editor` / `Library open` artboards still show the original 4 × 140 lanes; the `B — AI Prompt` artboards are the source for the final heights.

---

## B: Light Spine

**Concept.** Everything sits on black, and the only light comes from the sound. Each operator is a light source with its own hue. That hue colours its lane, its big frequency number, its envelope trace and its node in the algorithm. The algorithm diagram is the *spine* of the screen: each node sits at the height of its own lane (OP4 at the top, OP1 at the bottom). Modulation flows down into the carriers, and the carriers feed a white bus to OUT. The colour comes from the four hues. The minimalism comes from everything else: one monospace family, no cards, hairlines only, and no colour that doesn't stand for something.

**Rules.** Colour means *operator*. White means *global/system* (common, LFO, PEG, FX, AI/DX activity). Everything else stays dark.

### Tokens

```css
--void:#000000;      /* canvas */
--raised:#0B0B0E;    /* overlays: library drawer */
--hover:#1A1A20;     /* row/cell hover, idle white keys */
--line-hair:#1C1C21; /* section dividers */
--line-track:#2A2A30;/* fader tracks, envelope baseline */
--line-strong:#3A3A42;/* key-off line, disabled fill (decorative only) */
--notch:#6E6E76;     /* centre notches, idle glyphs, pill outlines (4.2:1, non-text only) */
--text-1:#F2F2F2;    /* 18.8:1 */
--text-2:#A0A0A8;    /* 8.1:1  labels */
--text-3:#8A8A93;    /* 6.1:1  captions; no text goes below this */
--light:#FFFFFF;     /* global "lit" state, AI/DX chips, focus ring */
--op4:#8F7CFF; /* violet  6.5:1 */
--op3:#2EE6FF; /* cyan   13.9:1 */
--op2:#FFB02E; /* amber  11.5:1 */
--op1:#FF3D7A; /* magenta 6.2:1 */
```
Contrast is measured on #000; it stays at 5:1 or better on #1A1A20. The hues run in prism order down the lanes (violet, cyan, amber, magenta). The **prism gradient** (`op4 → op3 → op2 → op1`, top to bottom) means "the whole voice". It is used only for keys lit from the DX and for the current-voice marker in the library.

### Fonts
| Role | Paper font | Web fallback |
|---|---|---|
| UI, labels, values, voice name | **Martian Mono** (Google, variable wght 100–800) | `"Martian Mono", ui-monospace, "SF Mono", Menlo, monospace` |
| Big numerals (operator frequency, algorithm no.) | **Barlow Condensed 200** (Google) | `"Barlow Condensed", "Arial Narrow", sans-serif` |

Martian Mono uses a slashed zero. That's fine for small values. For the big readouts I tried it and Geist Mono (also slashed) and rejected both, so the large numbers use Barlow Condensed with plain zeros.

### Type scale
| px / line | Font | Use |
|---|---|---|
| 56 / 54, wght 200, −0.01em | Barlow Cond. | operator frequency (`15.00`, `440 Hz`), op hue + `text-shadow 0 0 22px hue@55%` |
| 36 / 32, wght 200 | Barlow Cond. | algorithm number `08` |
| 28 / 32, wght 300, −0.03em | Martian | voice name in header |
| 12 | Martian 400 | values, library names |
| 11, wght 500, +0.12em | Martian | operator id `OP4` (op hue) |
| 10, +0.04 to 0.14em | Martian | labels (lower-case), enum options and section titles (UPPER) |
| 9, +0.1em UPPER | Martian | captions and FX type list only |

### Grid (one 1440×900 canvas, scaled to fit, no scrolling)
- **One layout only.** The app is a fixed 1440×900 canvas, uniformly scaled to the window with a CSS transform: `scale = min(innerWidth / 1440, innerHeight / 900)`. It is centred, letterboxed in `--void`, scales up on large screens, and recomputes on resize. There is no separate narrow layout and no minimum window size. Example: a 13" MacBook at the default "looks like 1280×832" leaves a browser viewport of about 1280×740, so the scale is 0.822.
- Pointer input is converted to design pixels in one place, so drags stay under the cursor at any scale (measured within 0.7 px at 0.822× and 1.2×).
- Header **56**. Library rail **64** (the header's left cell lines up with it). Main area **1376**.
- Main column, 844 tall: global strip **176** + operator lanes **536** + AI prompt bar **60** + audition **72**.
- Global strip **176**: algorithm **200** | common **268** | LFO **292** | pitch EG **300** | effects (flex, ≈316). Sections are split by 1px `--line-hair` lines only.
- Operator lanes **4 × 134** = 536 (lane centres 67 / 201 / 335 / 469). On the left is the **spine column at 200**, the same width as the algorithm picker directly above it. Each lane is a row with padding `0 24 0 20` and gap 24, holding these columns: identity+frequency **190** | level+feedback **240** | envelope **400** | modulation (flex ≈230).
- AI prompt bar **60**: see "AI prompt bar" below.
- Audition **72**, keys **56**. Its label column (200) lines up with the spine.
- Spacing steps: 2 · 4 · 6 · 8 · 10 · 12 · 14 · 16 · 20 · 24 · 28. Corner radii: 4 for thumbnails, 6 for cells, and fully round (pill) for buttons and pills.

### Control vocabulary
| Control | Look | Behaviour |
|---|---|---|
| **Fader** (0–127) | 2px track `--line-track`; filled part 2px in the op hue with `box-shadow 0 0 8px hue`; 12px black thumb with a 1.5px hue ring. Value sits right-aligned on the label row. | Drag anywhere on the row (pointer capture). Shift = fine (×¼). ↑↓ ±1, PgUp/PgDn ±8, Home/End. Double-click resets. Wheel ±1. **Hover:** thumb grows to 14px, glow gets brighter, cursor `ew-resize`. **Dragging:** 16px thumb filled with the hue plus a white ring, 3px track, value turns white. **Focus:** `0 0 0 3px #000, 0 0 0 4.5px #F2F2F2`. **Disabled** (op off / no DX): greys, no glow. |
| **Bipolar feedback** (−127…+127) | Same track with a 1px `--notch` at the centre. Light grows outward from the notch. End labels `← square` / `saw →`, and the active side brightens. | Snaps to 0 within ±3. Value text `+18 saw` / `−96 sq` / `0`. |
| **Frequency readout** | Big Barlow number in the op hue, plus the `RATIO FIXED` enum and the scrub-numbers `c15 f0 d−8`. Fixed mode shows `440 Hz`. | Drag the big number vertically to change coarse. c/f/d: drag ↕ or click to type. Detune −64…+63. |
| **Toggle** | Operator power = 26×14 pill (hue dot on the right when on). Per-op switches (lfo→pitch, pitch eg) = 7px lit dot + label. | The whole label is the hit area. Turning an operator off dims its whole lane to the disabled state. |
| **Enum ("lightboard")** | All options always visible. The selected one is white (or op hue) with a 1px underline and glow. Hover = `--text-1` with a `--notch` underline. | ←/→ to step, click to select, no dropdowns. Used for part mode, LFO wave (7 glyphs), FX type (8 words), ratio/fixed. FX parameter labels follow the type: DIST drive/tone · T.WAH sens/rez · CHO/FLA/PHA depth/rate · DLY/REV depth/time · THRU disables both. |
| **Envelope editor** | 400×88 SVG. Hue polyline 1.6px, a wider glow copy underneath, and an area gradient from hue@30% to 0. Four ring handles mark the end of each segment. Dashed vertical line = key-off. The rate/level numbers under the curve stay editable. | Drag a handle: x = rate (further left = faster), y = level. Hover shows dashed guides and a white readout `R2 55 · L2 107`. While dragging, the handle fills, the readout takes the hue, and a ghost of the previous curve stays visible. Keyboard: Tab between handles, ↑↓ level, ←→ rate. |
| **Algorithm** | Picker: 12 thumbnails (6×2, 28×44). Selected = 1px white frame with op-coloured dots. Hover = `--hover` fill. Spine: carrier = filled hue disc plus halo; modulator = hue ring; feedback loop above each node (dashed at 0, solid with value label when ≠ 0); modulation edge = cubic curve with a gradient from source hue to destination hue; carriers → white bus → `OUT`. | Click a thumbnail to change algorithm. Nodes keep their lane row and slide horizontally to their new depth (240 ms). Clicking a node focuses that lane. |
| **Preset cell / library** | 36px rows, slot `1-4` + name. Hover: `--hover` + `load ↵`. Loaded: 1px white frame + prism marker. Loaded and edited: white dot. Disabled when there's no DX. | Drawer opens from the rail button or `L`, closes with Esc or a backdrop click. It sits **under the header**, which stays live. Layout: 4 bank columns × 8 voices plus a *My patches* column. Clicking a cell loads it, and asks first if the voice is dirty. Search filters the cells. The rail shows a 4×8 dot map of the banks with the current voice lit. *My patches* rows show the patch name over `<date> · <voice name>` (e.g. `oct 18 · LegendEP`); the server stores no origin slot or AI flag. |
| **Header** | Link status (white dot `LINKED · USB`, plus ` · 24ms` once a real round trip has been measured; or `NO DX FOUND` / `SERVER OFFLINE` + `retry`), slot, voice name, `● EDITED` + `STORE on the DX keeps it`, activity log, undo/redo, `SAVE AS PATCH` pill. | Clicking the activity log jumps to that control. Clean state reads `○ IN SYNC WITH 1-4`; when the server can't tell whether the buffer matches a stored slot (e.g. after a server restart while the buffer was edited) it reads `○ SLOT UNKNOWN`. The latency is the WebSocket round trip of the last edit to its echo; it is never estimated. |
| **Audition** | 37 keys, assumed C3–C6 (MIDI 48–84; unconfirmed, see the end). Idle `--hover`, keys held on the DX or on the MIDI IN controller lit with the prism gradient (each source tracked apart: a key stays lit while either holds it; sustain does not keep keys lit), keys played with the mouse or by a phrase in white. Caption: last note-on chord with a source chip, `[DX] Cmaj7 · vel 80` / `[IN] A3 · vel 48` / `[AI] pad · …`, clipped at the label column. **MIDI IN** (not in Paper): two lines left of the pills, `MIDI IN` + dot over the selected input port (`.caption`, ellipsis past 168 px); a native select lies invisibly over both lines. Phrase pills: chord, arp, bass, lead, pad, keys. | The playing pill turns white and filled and stays lit until the phrase ends. There is no click-to-stop: the server has no stop command. MIDI-in dot: hollow `--text-3` = off, filled `--text-2` = connected, `--op1` outline = selected port not plugged in; it flashes white (0.2 s fade, like a released key) on every forwarded note-on. |

### Remote-change indicator (AI / DX)
Every change carries a source from the server (`ChangeSource` in `shared/protocol.ts`): `ui | api | device | preset | undo`. `api` is Claude, from the Claude Code CLI or the AI prompt bar, and renders the **AI** chip. `device` is an edit made on the DX itself and renders the **DX** chip. `ui` (your own edits) gets no indicator; `preset` and `undo` refresh the values without a bloom. For AI and DX changes:
- **t = 0:** the value text blooms white (`text-shadow 0 0 12px #fff`), the thumb gets a white ring and a 16px glow, a white ghost trail spans the old→new range, and a chip (`AI` filled white / `DX` outlined) appears next to the value.
- **t = 0 → 1600 ms:** everything eases (ease-out) back to the resting hue. The chip switches from filled to outlined at 600 ms and is removed at 4 s.
- Changes to the same parameter within 300 ms merge into one bloom. The header log shows the latest change: `AI OP2 LEVEL 96→108 2s`.
- With `prefers-reduced-motion`, use a static 1px white outline for 1.6 s instead.

Other motion: library drawer 180 ms fade+slide with a 120 ms backdrop. Keys light instantly and fade over 200 ms on note-off. Dragging is direct, with no easing.

### Algorithm topology (drives both picker and spine)
Notation: A>B means A modulates B. Depth = the longest path to a carrier. Node x position = `carrierX − depth × step`, and node y position = the lane centre (OP4 top … OP1 bottom).
`1 c[1] 4>3 3>2 2>1 · 2 c[1] 4>2 3>2 2>1 · 3 c[1] 4>1 3>2 2>1 · 4 c[1] 4>2 4>3 2>1 3>1 · 5 c[1] 2>1 3>1 4>1 · 6 c[1,2] 4>3 3>2 · 7 c[1,2] 4>3 3>1 3>2 · 8 c[1,3] 2>1 4>3 · 9 c[1,2,3] 4>1 4>2 4>3 · 10 c[1,2,3] 4>2 4>3 · 11 c[1,2,3] 4>3 · 12 c[1,2,3,4] —`

### Notes for the React build
- **Component tree:** `AppShell › Header · LibraryRail · LibraryDrawer · GlobalStrip(AlgorithmPicker, CommonPanel, LfoPanel, PitchEgPanel, EffectsPanel) · OperatorLanes(Spine, OperatorLane×4 › Identity, LevelFeedback, EnvelopeEditor, ModPanel) · Audition(Keyboard, MidiIn, PhraseButtons)`.
- **Hue per lane:** set `style={{'--op': 'var(--op3)'}}` on the lane, and have every child use `var(--op)`. No per-component colour props.
- **One set of control primitives everywhere:** `<Fader>`, `<Bipolar>`, `<ScrubNumber>`, `<Enum>`, `<Toggle>`, `<EnvelopeEditor>`. Each binds to a parameter id (`op2.level`, `fx2Param2`, …) in a single voice store. The browser never talks MIDI: edits go to the local server as one coalesced WebSocket `set` per animation frame (latest value per parameter), and the server owns the SysEx (see `docs/architecture.md`).
- **SVG** for the spine, envelopes, thumbnails and keyboard. Glows via `box-shadow` / `filter: drop-shadow` on HTML and a wider low-opacity duplicate stroke inside SVG (cheaper than SVG filters).
- **Accessibility:** faders and bipolar controls use `role="slider"` with `aria-valuetext` (e.g. "+18, saw"); enums use `role="radiogroup"`; envelope handles are sliders labelled "OP1 segment 2". Focus ring as specified above. Keys `1`–`4` focus a lane.
- The lanes run top-to-bottom as OP4 → OP1 on purpose (signal flows down into the carriers). The ids `OP4…OP1` stay visible so this doesn't conflict with the hardware numbering.

---

## A: Colour Field (not chosen)
A Swiss poster on pure white. Each operator is a flat, saturated column of colour (OP1 vermilion `#FF4A1C`, OP2 yellow `#FFC400`, OP3 green `#00B26B`, OP4 blue `#3D7BFF`), and every control on it is 100% black ink. Typeface is Archivo, with numbered sections, square carriers / round modulators in a classic DX diagram, and a permanent library column. It stays in Paper on page `A — Colour Field` for reference only.

---


## AI prompt bar

**Paper:** `B — AI Prompt · In context` (the editor with the bar in the Generating state) and `B — AI Prompt · States` (states 01–07, then a full editor frame showing the Done moment). Both artboards are on page `B — Light Spine`. PNGs: `ai-prompt-context.png`, `ai-prompt-states.png`.

The user types one line of English. Claude Opus 5.5 on the local server designs a complete voice, the app writes it to the DX, and a matching phrase plays. There is no transcript: the bar only shows the current request and the state it is in. This is the headline feature, so the bar is a **contained text field** that the eye finds early. Its prominence comes from white, contrast, size and the prism hairline, never from a new hue.

### Placement and layout change
- The bar is a full-width strip in the main column (1376 wide), **between the operator lanes and the audition strip**. The AI writes into the lanes directly above it, and the result plays on the keys directly below it. The header has no room left, and the audition strip only has about 190 px free.
- **Heights in the 844 px main column:**

  | Region | Height | Before |
  |---|---|---|
  | Global strip | 176 | unchanged |
  | Operator lanes | **536** (each lane **134**) | 560 (each lane 140) |
  | AI bar | **60** (incl. 1 px bottom hairline `--line-hair`) | none |
  | Audition | **72** | ≈108 |

  Keys are **56** tall (was 64), leaving 8 px above and below. White keys are 22×56; black keys are 14×33 (was 38). The keyboard SVG viewBox is `0 0 528 56`.
- The lane content still fits. The tallest column is the envelope at 110, which leaves 12 px above and below.
- **Spine redraw at 536:**
  - Lane centres: y = 67 + 134·i, i.e. 67 / 201 / 335 / 469 (was 70/210/350/490).
  - Node digits: top 59 / 193 / 327 / 461. Feedback arcs move with their nodes.
  - Bus: runs to y 516, arrow at 511–519. `OUT` label at top 518; `+18` label at top 429.
  - viewBox: `0 0 200 536`.
- **Bar columns:**
  - **Label column, 220 wide:** padding-left 16, so it lines up with `AUDITION`. It holds `PROMPT` (10 px, +0.14em, `--text-2`) over `claude opus 5.5` (10 px, `--text-3`).
  - **Field:** x **220 → 1352**, i.e. **1132 × 40**. It starts on the lane-content edge and ends at the 24 px right padding, centred vertically (10 px above and below).
- **Field box:**
  - 1 px border, radius 6 (the "cell" radius), padding `0 5 0 12`, gap 12, `position: relative`.
  - Children, left to right: `AI` mark → value → status → actions.
  - Bottom-edge light line: absolute, left 6, bottom −1, width 1120, height 1.
- **Field parts:**
  - **`AI` mark:** white chip, 9 px / 600, +0.08em, padding 2×5, radius 3. It is always the first thing in the field.
  - **Value:** **15 / 20 px** Martian Mono (larger than the 12 px control values).
  - **Caret:** the browser's native caret in white (`caret-color: var(--light)`). Paper's 2×20 glowing caret was not built: a drawn caret can't follow the native text selection reliably.
  - **Pills:** 30 high, radius 15, padding 0 14, gap 8.
    - Primary `GENERATE` / `RETRY`: 10 px / 500, +0.08em, upper case (same as `SAVE AS PATCH`), plus an 11 px `↵`.
    - Secondary `cancel` / `undo`: 10 px, +0.06em, lower case, `--notch` border, plus a 9 px `--text-3` hint.
    - `play again`: white outline, ▶ glyph.
    - Disabled: `--line-track` border, `--text-3` text.
  - **Keycap `/`:** 20×20, 1 px `--notch` border, radius 4, 11 px `--text-1`. It sits just left of `GENERATE` in Idle.
  - **Example chips:** inside the field in Idle only. 24 high, 1 px `--line-track` border, 10 px `--text-2`.
- **Width:** always 1132, because the whole canvas scales (see Grid); there are no narrow-width chip rules. In Done, the summary truncates with `…` (the full text stays in `title` and in the announcement).
- **Colour:** no new colours. Errors are not red: colour means operator, so an error is carried by its glyph and its copy. The prism hairline means "the whole voice", which matches its existing meaning (DX-lit keys, current-voice marker).

### Field states
| # | State | Border | Fill / glow | Bottom-edge line | Content | Right side |
|---|---|---|---|---|---|---|
| 01 | Idle | `--notch` #6E6E76 | `--raised` #0B0B0E | **resting prism hairline** at 75 % | `AI` (soft glow `0 0 8px #FFFFFF4D`) + placeholder `Describe a sound…` 15 px `--text-2` | 3 chips, `/` keycap, `GENERATE ↵` white outline |
| 02 | Typing (focus) | **#F2F2F2** | `--hover` #1A1A20 + `0 0 0 3px #FFFFFF14, 0 0 24px #FFFFFF26` | prism at 100 % + `0 0 8px #FFFFFF66` | `AI` (glow `0 0 12px #FFFFFFB3`) + value 15 px `--text-1` + white caret | `GENERATE ↵` **filled white**, black text, `0 0 16px #FFFFFF59` |
| 03a | Generating · designing | `--notch` | `--raised` | **prism comet** | `AI` (strong glow) + lock glyph 10×12 `--text-3` + prompt **still readable**, 15 px `--text-2` | `● DESIGNING ── ○ WRITING TO DX`, elapsed `7s` (13 px), `cancel esc` |
| 03b | Generating · writing to DX | `--notch` | `--raised` | **determinate prism fill** | same, locked | `● DESIGNING` dimmed to `--text-2`, `● WRITING TO DX  29/41` lit, `12s`, `cancel` disabled |
| 04 | Done | white flash (#D8D8DC at t ≈ 300 ms) + `0 0 22px #FFFFFF2E` | `--raised` | white 85 % + 10 px glow, fading | `AI` + ✓ + `DONE` + voice name **15 px / 500** + summary 11 px `--text-2` | `41 params changed`, `undo ⌘Z`, `▶ play again pad` (white outline) |
| 05 | Error (×3) | `--notch` | `--raised` | off | `AI` + prompt kept, 15 px `--text-1`, click to edit | ⓘ message 12 px `--text-1` + detail 10 px `--text-2`, `RETRY ↵` white outline |
| 06 | No API key | `--line-track` #2A2A30 | #000 | off | `AI` outlined (`--notch` / `--text-3`) + key glyph + hint 14 px | `GENERATE` disabled |
| 07 | No DX connected | `--line-track` | #000 | off | `AI` outlined + ○ + hint 14 px | `GENERATE` disabled |

Focus (02) is deliberately the strongest resting state: a white border, a lifted fill, a white halo, the full prism line and a filled `GENERATE`. Idle keeps the outline and a 75 % prism hairline, so the field is never mistaken for a readout.

**Phase dots:**
- Active: 6 px white dot with an 8 px glow, label `--text-1`.
- Next: 6 px ring in `--notch`, label `--text-3`.
- Done: 6 px dot in `--text-2`, label `--text-2`.
- A 20 px `--line-strong` rule joins the two phases.

**How Done ties to the AI bloom:**
- **t = 0 (last param acknowledged):** every changed control runs the existing remote-change bloom (white value, filled `AI` chip, ghost trail; see "Remote-change indicator"). All the blooms start together, with no stagger. At the same moment the field border and bottom-edge line flash white and fade over the same 1600 ms ease-out, so the field and the controls read as one event.
- **Big frequency readouts:** the chip floats at the top-right of the number (absolute, left 118, top 26 in the 190 column).
- **Header:**
  - The voice name becomes the new name (≤ 10 chars, shown as returned) and `● EDITED` is set.
  - The log shows a single entry for the whole batch: `AI PROMPT → 41 PARAMS now`.
  - Clicking that entry jumps to the first changed control.
- **Auto phrase:** the AI picks one of chord / arp / bass / lead / pad / keys. It starts 150 ms after t = 0. That pill takes the playing style and the played keys light **white** (app-played, same as mouse). The audition caption reads `[AI] pad · Cmaj7 · vel 80`, with the `AI` chip outlined.
- **`play again`:** replays the same phrase, or restarts it if it is still playing.
- **`undo`:** reverts the whole AI write as one undo step (the same entry the header's undo and ⌘Z use) and writes the previous values back to the DX. The bar returns to Idle with the prompt kept, and shows `Restored LegendEP` for 2 s.
- **How long Done stays:** until the user focuses the field, or until **any** later voice change arrives, whatever its source: your own edit, an edit on the DX panel, a preset load, or undo. Any of these sends the bar back to Idle. This is wider than the original spec on purpose: otherwise Done's `undo` could revert a later DX-panel edit instead of the AI write.

### Motion and timing
- **Idle → focus:** border, fill, halo and line strength ease over **120 ms** ease-out (reverse on blur). `GENERATE` fills white in the same 120 ms.
- **Resting prism hairline:** `linear-gradient(90deg, transparent, op4 14%, op3 38%, op2 62%, op1 86%, transparent)`, 1 px, opacity 0.75. It is static.
- **Designing comet (on the field's bottom edge):**
  - The segment is 420 px long with a 2 px core, `linear-gradient(90deg, op4@0 0%, op4 38%, op3 62%, op2 82%, op1 100%)`.
  - The head is a 6×4 white pill with an op1 glow.
  - Under it sits a 9 px tall copy, blurred 6 px, at 80 % opacity.
  - It crosses the 1120 px edge from off-left in **1400 ms, linear**, and loops. The resting hairline is hidden while it runs.
- **Writing to DX:**
  - A determinate prism fill (op4 0 % → op3 35 % → op2 70 % → op1 100 %) runs from x 6 to 6 + written/total × 1120.
  - Each update eases over 80 ms.
  - The phase is shown for at least **400 ms**. The DX bulk write is atomic and takes about 140 ms, so the `29/41` counter and the fill are animated across that 400 ms window; they don't track individual MIDI messages.
- **Done flash:** the border jumps to #FFFFFF with a 22 px white halo, and the bottom line goes white with a 10 px glow. Both ease out over **1600 ms** back to Idle styling, in step with the bloom.
- **Phase change:** the dot and label crossfade over 160 ms. Error and Done content fade in over 120 ms.
- **Elapsed time:**
  - Whole seconds from `0s`, updated every 1000 ms.
  - Fixed 36 px right-aligned slot, so the layout never shifts.
  - At 30 s the label gains `· taking longer than usual`.
  - There is no client-side give-up. The server enforces a hard **90 s** timeout per job (one attempt, no SDK retries) and reports `timeout`; the page waits for the server so it can never show an error while a voice still lands on the DX. Measured real jobs took 10–15 s.
- **`prefers-reduced-motion`:**
  - The comet becomes a static full-length prism line at 100 %.
  - The writing fill steps without easing.
  - The Done flash becomes a static white border for 1.6 s.

### Copy (English)
| Where | String |
|---|---|
| Label | `PROMPT` · `claude opus 5.5` |
| Field mark | `AI` |
| Placeholder | `Describe a sound…` |
| Example chips | `interstellar pad` · `glassy 80s e-piano` · `make it brighter and shorter` |
| Primary action | `GENERATE` + `↵` |
| Phases | `DESIGNING` · `WRITING TO DX` (+ `29/41`) |
| Elapsed | `7s` · `· taking longer than usual` (from 30 s) |
| Cancel | `cancel` + hint `esc` |
| Done | `DONE` · `<VoiceName>` · `<summary>`, e.g. `ALGO 8 · slow swells · detuned 1:2 stacks · long reverb` · `41 params changed` |
| Done actions | `undo` + `⌘Z` (`Ctrl+Z` on Windows/Linux) · `play again` + `<phrase>` |
| After undo | `Restored <previous name>` (2 s) |
| Error · network/API | `Couldn't reach Claude` · `<server message> · nothing was changed`, e.g. `API error 529`, `no reply within 90 s`. One headline covers the four server kinds `auth`, `network`, `rate` and `timeout`; the detail is the server's message. |
| Error · refused | `Claude declined this request` · `describe a sound instead` |
| Error · invalid result | `That result wasn't a valid voice` · `nothing was written to the DX` |
| Retry | `RETRY` + `↵` |
| No API key | `Add ANTHROPIC_API_KEY to .env and restart the server` (`ANTHROPIC_API_KEY` and `.env` in `--text-1`, the rest in `--text-2`) |
| No DX | `Connect the reface DX to design a sound` |

No error ever leaves a half-written voice. The server validates the complete reply before anything is sent, so every Claude-side error (refused, invalid, network, timeout) happens before the DX is touched. The write itself is one local MIDI bulk write and doesn't involve Claude.

### Keyboard
- `/` focuses the field from anywhere. It is ignored while another text field has focus or the library drawer is open. Inside the field, `/` types a slash.
- Clicking anywhere in the field box, not just on the text, focuses it.
- `Enter` (or clicking `GENERATE`) sends. An empty field does nothing. Max 280 chars, and a `240/280` counter appears left of `GENERATE` from 240 chars.
- `Esc` in the field: the first press clears the text, the second blurs it (focus returns to where it was).
- While generating, `Esc` cancels from anywhere. If the library drawer is open, `Esc` closes the drawer first. During Writing to DX, `Esc` does nothing, because the write is atomic and short.
- `↑` in an empty field recalls the last prompt. It is one level deep, not a history list.
- Example chips are buttons in tab order. `Enter`/`Space` fills the field and focuses it; it does **not** send.
- Done: `⌘Z` / `Ctrl+Z` undoes the whole AI change. `/` focuses the field with the last prompt selected, so the user can type a follow-up such as "make it brighter". The request then applies to the current voice.
- Error: `Enter` in the field retries, with the same prompt or an edited one.
- While the field has focus, the editor's single-key shortcuts (`1`–`4`, `L`) are suspended.
- Disabled states: `/` does nothing.

### ARIA
- **Form and input:** `<form aria-label="Design a sound with AI">` wraps `<input type="text" aria-label="Describe a sound" aria-keyshortcuts="/" maxlength="280" autocomplete="off">` and `<button type="submit">Generate</button>`.
- **Decorative parts:** the `AI` mark and the lock glyph are `aria-hidden`.
- **Live status region:** a single `<div role="status" aria-live="polite" aria-atomic="true">` holds the current phase only. It announces on transitions only:
  - `Designing`
  - `Writing to DX`
  - `Done. StarDrift. ALGO 8, slow swells, detuned 1:2 stacks, long reverb. 41 parameters changed. Playing pad phrase.`
  - `Cancelled. Nothing was changed.`
  - `Restored LegendEP.`
- **Elapsed seconds:** `aria-hidden="true"`. At 15 s the status announces `Still designing` once.
- **Errors:** a separate `role="alert"` region, e.g. `Couldn't reach Claude. API error 529. Nothing was changed.` Focus is not moved; Retry is next in tab order after the input.
- **Generating:**
  - The input becomes `readonly` with `aria-readonly="true"`, not `disabled`, so the prompt stays focusable and readable.
  - The form gets `aria-busy="true"`.
  - Cancel is a `<button aria-keyshortcuts="Escape">`, and it is `disabled` during Writing to DX.
- **Writing phase:** the bottom-edge line carries `role="progressbar" aria-label="Writing to DX" aria-valuemin="0" aria-valuemax="41" aria-valuenow="29"`. The resting hairline, the comet and the Done flash are `aria-hidden`.
- **Done:** focus is not moved. `undo` gets `aria-keyshortcuts="Meta+Z Control+Z"`, and `play again` gets `aria-label="Play the pad phrase again"`.
- **Disabled (no API key / no DX):** the input is `disabled` with `aria-describedby` pointing at the hint text, and `Generate` is `disabled`.
- **Chips:** `<button aria-label="Use example: interstellar pad">`.
- **Focus visibility:**
  - The field itself is the focus indicator: white border, 3 px white halo and caret.
  - Pills and chips use the standard ring (`0 0 0 3px #000, 0 0 0 4.5px #F2F2F2`).
  - Text inside the field is ≥ 14 px, with no text below `--text-3`.

---

## Implementation status (2026-10-18)

Evidence levels: **verified** = checked in code or on the real DX; **inferred** = derived, not measured; **docs only** = from a single written source.

### Deviations from Paper (deliberate, all reflected above)
- **Scaling:** one fixed 1440×900 canvas scaled to fit the window replaces the 1280×800 minimum and the narrow-width rules (verified: screenshots at 1280×740, 1440×900, 1920×1080, no scrollbars).
- **Fonts:** the big numerals use Barlow Condensed 200 as specified. Paper doesn't have Barlow installed, so the Paper artboards and their PNGs render those numerals in a fallback face and look narrower than the build. The npm Martian Mono files lack `←` and `→`, so those two glyphs fall back to the system monospace font.
- **AI prompt bar:** native white caret; Done also ends on any later voice change; the writing counter is animated over the 400 ms minimum phase; no 60 s client give-up (server timeout 90 s).
- **Audition:** phrase pills can't be stopped mid-phrase (the server has no stop command).
- **MIDI IN selector (Audition row):** not in Paper. It picks the MIDI thru input (e.g. a Keystation) that plays the DX, in the ~183 px between the keys and the pills, using existing tokens and the `.title` / `.caption` styles; existing elements keep their positions (verified: pills at the same x, row still 72 px). Long port names end in an ellipsis; the full name is in the menu and the tooltip.
- **MIDI IN keys (Audition row):** not in Paper. Keys held on the thru controller light with the same prism layer as DX-held keys, and the caption chip reads `IN` (same outlined chip as `DX`). The caption clips at the 200 px label column (a two-hand chord lists up to ten note names) instead of running under the keys.
- **Header:** latency appears only after a real round trip has been measured.
- **Spine geometry:** follows the 4 × 134 lanes of the `B — AI Prompt` artboards. The older Editor artboards still show 4 × 140.

### Still unconfirmed
| Item | Current behaviour | Level | How to settle it |
|---|---|---|---|
| Fixed-mode frequency formula: does `coarse >> 3` or `coarse & 3` pick the decade? | Shown with `≈`, using `coarse >> 3` | docs only (community tool output) | Sweep coarse 0–31 in FIXED mode on the DX and read the LCD (`docs/sysex-spec.md` §3.2) |
| Operator numbering of algorithms 6, 9, 10, 11 (3 partly) | Drawn from a community chart plus inference | inferred | Step ALGO on the DX and photograph the LCD diagrams (`docs/sysex-spec.md` §5) |
| Keyboard range of the 37 keys | Assumed C3–C6 (MIDI 48–84) | inferred | Play the lowest and highest key on the DX and watch the lit keys |
| Refusal fallback (`fallbacks: "default"`) | Sent with every AI request and accepted by the API | verified as accepted; the fallback path itself never ran (no refusal occurred) | Wait for a real refusal, or test deliberately |
| Slot 2-4 name | Stored as `=i>Tune` (bytes `3D 69 3E 54 75 6E 65`), not the `BitTune` in the factory list | verified on the device; cause unknown | Compare with VOICE RECALL on the DX |
| `dirty` after a STORE done on the DX panel | Not seen until that slot is loaded or scanned again | reported by the implementing engineer; not re-checked | Design decision pending |
| Slot pointer after a server restart with an edited buffer | Lost, shown as `SLOT UNKNOWN` | reported by the implementing engineer; not re-checked | Design decision pending |
| Physical USB unplug / replug | Handled by port polling (2 s); tested only with a simulated port | inferred for the real cable | Unplug the DX while the server runs |

### Repository state
- Ignored on purpose: `.env` (your Anthropic API key; copy `.env.example`), `data/settings.json` (this machine's MIDI thru choice), `data/backups/` (preset-scan dumps of your own unit), `node_modules/`, `web/dist/`.
