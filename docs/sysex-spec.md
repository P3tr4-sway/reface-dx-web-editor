# Yamaha reface DX - MIDI / SysEx Parameter Specification

Purpose: authoritative parameter reference for a real-time voice editor (Node server + web panel over USB-MIDI).
Compiled 2026-10-17 from the official Yamaha documents, five open-source projects, a 9,310-voice community corpus (checked programmatically), and ground truth supplied by the coordinator from the user's real device.

Scope note: nothing in this file was tested by the author against hardware. Facts marked DEV were verified on the user's device by the coordinator. The §2.4 curves are DEV facts from audio recordings of this unit (2026-10-18).

---

## 0. Evidence legend

Every fact carries a source tag and a confidence level.

| Confidence | Meaning |
|---|---|
| OFF | Stated in an official Yamaha document (page cited) |
| DEV | Verified on the user's real reface DX (ground truth from coordinator) |
| XC | Cross-checked: two or more independent implementations or datasets agree |
| 1S | Single non-official source |
| INF | Inferred by the author; reasoning given; must be verified |

Source codes:

| Code | Source |
|---|---|
| DL | Official "reface CS/DX/CP/YC Data List", file `reface_en_dl_b0.pdf` (19 pp, created 2016-04-07). DX section = pp. 6-10. MIDI chart "Version 1.0, 20-FEB-2015". Read via text extraction AND page images |
| OM | Official "reface CS/DX/CP/YC Owner's Manual" (`ZT92080_reface_En_OM_C0.pdf`, 64 pp) |
| RM | Official "reface Reference Manual" (`reface_en_rm_a0.pdf`, 11 pp) |
| FW130 | Official "reface Version 1.30 Supplementary Manual" (`v130_Manual_en.pdf`, 28 pp) |
| MK | github.com/christofmuc/MidiKraft-yamaha-refacedx (C++, used by KnobKraft Orm; commit 2f650e3) |
| SK | github.com/SpotlightKid/reface-dx-lib (Python; commit 46b63eb) |
| MT | github.com/mikatahara/RefaceDX, JS source read from the live app https://mikatahara.github.io/RefaceDX/ |
| RS | github.com/normaldotcom/refacesender (Web MIDI patch sender; commit 9a6f9ed; README states it was confirmed on a real DX) |
| DH | github.com/dmhrpr/reface-dx-sysex-librarian (Python; commit 45ad99d) |
| CORPUS | 9,310 `.syx` + 6,578 `.txt` voice files shipped in RS `assets/DX/` (Soundmondo community voices, mirrored by M. Tarenskeen). Parsed by the author for structure, checksums, and per-offset value ranges |
| GT | Ground truth from the real device, relayed by the coordinator (see 0.1) |

### 0.1 Device ground truth (GT, confidence DEV)

- Edit buffer voice name is `"LegendEP  "` (10 chars, space padded).
- Algorithm raw = `07` (= ALGO 8). Effect 1 type raw = `03` (CHO). Effect 2 type raw = `07` (REV).
- Bulk dump layout matches section 1.4: common block 38 data bytes at `30 00 00`; each operator block 28 data bytes at `31 0n 00`.
- Checksum = `(128 - (sum(model ID + address + data) mod 128)) & 0x7F`, verified on the header block.
- Parameter change `F0 43 10 7F 1C 05 30 00 12 <v> F7` writes LFO Speed (offset 0x12). Confirmed.

---

## 1. Message formats

All multi-byte values are 7-bit clean (every data byte 0x00-0x7F). "n" is the device-number nibble (section 1.7).

### 1.1 Constants

| Field | Value | Source |
|---|---|---|
| Manufacturer ID | `43` (Yamaha) | OFF DL p.6 |
| Group number high / low | `7F` `1C` (reface family) | OFF DL p.6 |
| Model ID | `05` = reface DX | OFF DL p.6; XC MK/SK/MT/RS |
| Other model IDs (not verified by the author) | CS `03`, CP `04`, YC `06` | 1S (YamahaSynth forum, via search summary) |

### 1.2 Parameter Change (host -> device)

```
F0 43 1n 7F 1C 05 <AH> <AM> <AL> <data...> F7
```

- No checksum. Data size is 1 byte for every voice parameter. System Master Tune is 4 bytes and Tempo is 2 bytes: DL p.6 says "for parameters with data size of 2 or more, the appropriate number of data bytes will be transmitted", so send all bytes of a multi-byte parameter in ONE message. [OFF DL p.6]
- Confirmed on device for `30 00 12` (LFO Speed). [DEV]
- Example, set Operator 3 output level (`31 02 12`) to 100: `F0 43 10 7F 1C 05 31 02 12 64 F7`.
- Example, set voice-name character 1 (`30 00 00`) to 'A': `F0 43 10 7F 1C 05 30 00 00 41 F7`.
- Example (RS): disable Auto Power-Off: `F0 43 10 7F 1C 05 00 00 0C 00 F7`. [XC RS + DL system table]

### 1.3 Requests (host -> device)

Dump Request (voice or system block):

```
F0 43 2n 7F 1C 05 <AH> <AM> <AL> F7
```

| Request | Address | Bytes | Reply | Source |
|---|---|---|---|---|
| Current voice (edit buffer) | `0E 0F 00` (Bulk Header address) | `F0 43 20 7F 1C 05 0E 0F 00 F7` | 7 bulk-dump messages (1.4), 241 bytes total | OFF DL p.8 ("designate its corresponding BulkHeader address"); XC MK/SK/MT/DH/RS; the 241-byte total is verified in CORPUS |
| System settings | `00 00 00` | `F0 43 20 7F 1C 05 00 00 00 F7` | 1 bulk-dump message: 32 data bytes, byte count `00 24`, 45 bytes total | OFF DL p.8 (System block in bulk table); XC MK (field-used for device detect: reads data[0], [1], [6], [0x0E]) |

Parameter Request (DL p.6/7, "(3-4-5)"):

```
F0 43 3n 7F 1C 05 <AH> <AM> <AL> F7
```

Defined in the Data List, but no open-source tool uses it and the reply format is not specified. Treat as unverified. [OFF existence only; reply behaviour unknown]

Requests for individual sub-blocks (`30 00 00`, `31 0n 00`) are NOT documented: DL p.8 says to request a voice by designating the Bulk Header address. Whether sub-block requests are answered is unknown. [open question]

### 1.4 Bulk Dump (device -> host, and host -> device)

```
F0 43 0n 7F 1C <BCH> <BCL> 05 <AH> <AM> <AL> <data...> <checksum> F7
```

- `BCH BCL` = 14-bit byte count = `(BCH << 7) | BCL`.
- Byte count semantics. DL p.6 says "size of data in blocks from Model ID onward (up to but not including the checksum)". That equals `1 (model) + 3 (address) + N (data)`. Observed value is also `3 + N + 1 (checksum)`. Both are `N + 4`, so there is no practical difference. Verified on all 65,163 messages in CORPUS. [OFF + XC]
- A voice is sent as 7 consecutive messages in this order (corpus: 9,309 of 9,310 files are complete voices in exactly this order; MK `isStreamComplete`):

| # | Block | Address | Data bytes (N) | Byte count (BC) | Total message bytes |
|---|---|---|---|---|---|
| 1 | Bulk Header | `0E 0F 00` | 0 | `00 04` | 13 |
| 2 | Voice Common | `30 00 00` | 38 | `00 2A` (42) | 51 |
| 3-6 | Operator 1..4 | `31 00 00`, `31 01 00`, `31 02 00`, `31 03 00` | 28 each | `00 20` (32) | 41 each |
| 7 | Bulk Footer | `0F 0F 00` | 0 | `00 04` | 13 |

  Total = 13 + 51 + 4x41 + 13 = 241 bytes. [OFF DL p.8; XC corpus+MK+GT]
- System block (separate message, not part of a voice): `00 00 00`, N = 32, BC = `00 24` (36). [OFF DL p.8]
- Receive rules (OFF DL p.8): the blocks from Bulk Header to Bulk Footer "can be received regardless of their order", "can be received even if all of them are not transmitted", and "cannot be received if the irrelevant block is included" (do not mix a System block into a voice stream). Whether Header/Footer are mandatory for partial voices is unknown. One corpus file (`DX-00070363-Tiny_Rhod.syx`) is a voice without the Common block (190 bytes). [OFF + open question]
- Device replies use device byte `00` in all 65,163 corpus messages. Ignore `n` on input; do not require a match with your request. [XC corpus + MT (accepts only `00`)]

### 1.5 Checksum

Algorithm (OFF DL p.6: "the value that results in a value of 0 for the lower 7 bits when the Model ID, Start Address, Data and Check sum itself are added"):

```
sum      = model_id + addr_high + addr_mid + addr_low + sum(all data bytes)
checksum = (128 - (sum & 0x7F)) & 0x7F        // equivalent: (-sum) & 0x7F
```

Do NOT include F0, 43, device byte, 7F, 1C, byte count, or F7 in the sum.

Worked examples (real device dump bytes from a CORPUS file, all three verified by the author):

- Header: `F0 43 00 7F 1C 00 04 05 0E 0F 00 5E F7`. Sum = 05+0E+0F+00 = 0x22 (34). (128-34) = 94 = 0x5E. [DEV for header (GT); XC CORPUS]
- Footer: `... 05 0F 0F 00 5D F7`. Sum = 05+0F+0F+00 = 0x23 (35). 128-35 = 93 = 0x5D.
- Operator 1 block, 28 data bytes = `01 76 59 13 48 0C 7F 7F 27 05 00 00 00 03 00 01 01 16 76 7B 00 00 00 4E 41 00 00 00`. Sum of model(05)+address(31 00 00)+data = 1074 = 0x432; `& 0x7F` = 0x32; 128-0x32 = 0x4E. Message checksum byte is `4E`. Matches.

Pitfall (SK `util.checksum`): `((sum ^ 0x7F) & 0x7F) + 1` yields 0x80 (invalid) when `sum & 0x7F == 0`. Use the formula above.

Whether the device validates checksums on received dumps is unknown. Always send a correct one.

### 1.6 Other system messages

| Message | Bytes | Source |
|---|---|---|
| Identity Request (receive only) | `F0 7E 0n 06 01 F7`; device receives "under omni" | OFF DL p.6 |
| Identity Reply | `F0 7E 7F 06 02 43 00 41 53 06 00 00 00 7F F7` | OFF DL p.6 (MK matches the first 9 bytes) |
| Active Sensing | `FE` transmitted every 200 ms. After the device has RECEIVED one `FE`, it clears its MIDI receive buffer and mutes all sound if nothing arrives for about 350 ms | OFF DL p.6 |
| Timing Clock | `F8` is transmitted; if received over MIDI IN or USB it switches to external sync and reverts to internal after 3 s of silence | OFF DL p.6 |

Implementation consequences: input handlers must ignore `FE` and `F8`; never echo `FE`/`F8` back to the device; rtmidi-style libraries must be told to NOT ignore SysEx (SK does `ignore_types(sysex=False)`); Web MIDI needs `{sysex: true}`.

### 1.7 Device number (n) semantics

- DL p.6 defines `n` as "Device Number" for all four SysEx types: parameter change `1n`, bulk dump `0n`, dump request `2n`, parameter request `3n`. [OFF]
- The Data List does not say whether the device matches `n` against anything. The only statement is for Identity Request: "this instrument receives under omni". Every open-source tool uses `n = 0`, and the device's own dumps carry `0x00`. [XC MK/SK/MT/RS/DH + CORPUS]
- Recommendation: always use `n = 0`. Whether other values are accepted or whether `n` must equal the MIDI receive channel is unknown. [open question]
- MIDI transmit/receive channels (System `00 00 00` / `00 00 01`) are separate from the device number. Program Change and CC use the MIDI channel. [OFF DL p.8, MIDI chart]

---

## 2. Address tables

Address = 3 bytes `<High> <Mid> <Low>`. Base addresses (OFF DL p.8):

| Block | Base address | Size |
|---|---|---|
| System | `00 00 00` | 32 bytes |
| Voice Common | `30 00 00` | 38 bytes |
| Voice Operator n (n = 0..3 = OP1..OP4) | `31 0n 00` | 28 bytes each |

Parameter address = base + offset in the Low byte. Examples: Common LFO Speed = `30 00 12`; OP3 output level = `31 02 12`. Operator index `n` goes in the MID byte, Low byte is the offset.

Convention for "Default" columns: "OFF" means the doc states it. "CORPUS-INIT" means the most frequent value across 68 community dumps named `Init Voice` (not official; the instrument's Voice Initialize job produces "a sine wave", OM p.20). Blank means unknown.

### 2.1 System block (base `00 00 00`) [OFF DL p.8, MIDI PARAMETER CHANGE TABLE (SYSTEM)]

| Offset | Address | Size | Name | Raw range | Default | Display mapping |
|---|---|---|---|---|---|---|
| 0x00 | 00 00 00 | 1 | MIDI transmit channel (TR CH) | 00-0F, 7F | 00 = ch 1 (OFF OM p.43) | raw+1 = ch 1..16; 7F = off (no data transmitted, OM p.21) |
| 0x01 | 00 00 01 | 1 | MIDI receive channel (RV CH) | 00-0F, 10 | 10 = ALL (INF from DL MIDI chart "Default 1, 1-16 / Mode 1 OMNI ON") | raw+1 = ch 1..16; 10 = ALL |
| 0x02-0x05 | 00 00 02..05 | 4 | Master Tune | byte1 00-00, byte2 00-07, byte3 00-0F, byte4 00-0F (one nibble each) | center | value = (b2<<8)\|(b3<<4)\|b4, 0x000..0x7FF; cents = (value - 1024) / 10 = -102.4..+102.3. Center = bytes `00 04 00 00` (INF: arithmetic from the stated range; hardware not checked). Panel shows Hz 414.8..466.8 in 0.2 Hz steps (OFF FW130 p.13), 440.0 = default |
| 0x06 | 00 00 06 | 1 | Local Control | 00-01 | 1 = ON (OFF OM p.43) | 0 off, 1 ON |
| 0x07 | 00 00 07 | 1 | Master Transpose | 34-4C | 40 | raw-64 = -12..+12 st |
| 0x08-0x09 | 00 00 08..09 | 2 | Tempo | MSB 00-02, LSB 00-7F | 120 BPM (INF; OM p.23 quotes 120 BPM for looper capacity) | BPM = (MSB<<7)\|LSB, 30..300 (INF from the "bit 13-7 / bit 6-0" note); meaning = Phrase Looper tempo (INF) |
| 0x0A | 00 00 0A | 1 | LCD contrast | 00-3F | | 0..63 |
| 0x0B | 00 00 0B | 1 | Sustain pedal select | 00-01 | 1 = FC4/5 (OFF OM p.43) | 0 = FC3, 1 = FC4/5 |
| 0x0C | 00 00 0C | 1 | Auto Power-Off | 00-01 | 1 = ON, 30 min (OFF OM p.41) | 0 off, 1 ON |
| 0x0D | 00 00 0D | 1 | Speaker output | 00-01 | 1 = ON (OFF OM p.42) | 0 off, 1 ON |
| 0x0E | 00 00 0E | 1 | MIDI Control | 00-01 | 0 = off (OFF OM p.42) | 0 off, 1 ON. Gates the CC messages in section 6.3 |
| 0x0F-0x1F | 00 00 0F..1F | 17 | reserved | | | do not write |

Cross-check: MK reads `data[0]`, `[1]`, `[6]`, `[0x0E]` from the 32-byte system dump and writes `00 00 00`, `00 00 01`, `00 00 06`, `00 00 0E` via parameter change. [XC MK + DL]
Firmware note: Master Tune and Master Transpose were added in firmware 1.30 (FW130 p.13). Older firmware may lack them. The unit's firmware version is unknown. [OFF + open question]
Persistence note: OM p.S-6 ("Saving data") states that MIDI and system settings are lost at power-off "without first changing the screen". It is unknown whether SysEx-written system settings persist. [OFF + open question]

### 2.2 Voice Common block (base `30 00 00`, 38 bytes) [OFF DL p.9, MIDI PARAMETER CHANGE TABLE (VOICE Common)]

| Offset | Address | Name | Raw range | Default (CORPUS-INIT) | Display mapping |
|---|---|---|---|---|---|
| 0x00-0x09 | 30 00 00..09 | Voice name chars 1..10 | 20-7E (printable ASCII) each | `Init Voice` | ASCII, right-padded with 0x20 to 10 chars. Verified: MK/SK/MT read these 10 bytes; GT `"LegendEP  "` |
| 0x0A-0x0B | 30 00 0A..0B | reserved | always 00 in all 9,309 corpus voices | 00 | do not write |
| 0x0C | 30 00 0C | Transpose (TP) | 28-58 | 40 | raw-64 = -24..+24 semitones |
| 0x0D | 30 00 0D | Part mode | 00-02 | 00 | 0 POLY, 1 MONO-FULL (portamento on all notes), 2 MONO-LGATO (portamento only on legato notes) |
| 0x0E | 30 00 0E | Portamento time (PORTA) | 00-7F | 00 | 0..127 |
| 0x0F | 30 00 0F | Pitch bend range (PB) | 28-58 | 42 (= +2) | raw-64 = -24..+24 semitones. OFF DL/OM say "-24 to +24". Negative values presumably invert the bend direction (INF, not documented) |
| 0x10 | 30 00 10 | Algorithm (ALGO) | 00-0B | 00 | raw+1 = ALGO 1..12 (OFF DL p.9). Section 5 |
| 0x11 | 30 00 11 | LFO wave | 00-06 | 00 | 0 SIN, 1 TRI, 2 SAW U (ramp up), 3 SAW D (ramp down), 4 SQ, 5 S&H8 (sample & hold 8 per speed interval), 6 S&H |
| 0x12 | 30 00 12 | LFO speed | 00-7F | 40 | 0..127 (DEV write confirmed) |
| 0x13 | 30 00 13 | LFO delay | 00-7F | 00 | 0..127 |
| 0x14 | 30 00 14 | LFO pitch mod depth (PMD) | 00-7F | 00 | 0..127 (0 = no LFO) |
| 0x15 | 30 00 15 | Pitch EG rate 1 | 00-7F | 40 | 0 (slow) .. 127 (fast) |
| 0x16 | 30 00 16 | Pitch EG rate 2 | 00-7F | 40 | same |
| 0x17 | 30 00 17 | Pitch EG rate 3 | 00-7F | 40 | same |
| 0x18 | 30 00 18 | Pitch EG rate 4 | 00-7F | 40 | same |
| 0x19 | 30 00 19 | Pitch EG level 1 | 10-70 | 40 | raw-64 = -48..+48 (-4..+4 octaves, st units) |
| 0x1A | 30 00 1A | Pitch EG level 2 | 10-70 | 40 | same |
| 0x1B | 30 00 1B | Pitch EG level 3 | 10-70 | 40 | same |
| 0x1C | 30 00 1C | Pitch EG level 4 | 10-70 | 40 | same |
| 0x1D | 30 00 1D | Effect 1 type | 00-07 | mixed in corpus (no reliable default) | Section 4 (GT: raw 03 = CHO) |
| 0x1E | 30 00 1E | Effect 1 param 1 | 00-7F | | meaning per type: Section 4 |
| 0x1F | 30 00 1F | Effect 1 param 2 | 00-7F | | meaning per type: Section 4 |
| 0x20 | 30 00 20 | Effect 2 type | 00-07 | mixed | Section 4 (GT: raw 07 = REV) |
| 0x21 | 30 00 21 | Effect 2 param 1 | 00-7F | | Section 4 |
| 0x22 | 30 00 22 | Effect 2 param 2 | 00-7F | | Section 4 |
| 0x23-0x25 | 30 00 23..25 | reserved (3 bytes) | always 00 | 00 | do not write |

The Pitch EG is common to all operators; each operator has a switch to enable it (operator offset 0x10). [OFF RM p.9]
Observed per-offset min/max across all 9,309 corpus voices is identical to the ranges above (transpose 40..88, PB range 40..88, algorithm 0..11, LFO wave 0..6, PEG level 16..112, effect type 0..7). [XC CORPUS]

### 2.3 Voice Operator block (base `31 0n 00`, n = 0..3, 28 bytes) [OFF DL p.9, MIDI PARAMETER CHANGE TABLE (Operator)]

| Offset | Address (n = op index 0..3) | Name | Raw range | Default (CORPUS-INIT) | Display mapping |
|---|---|---|---|---|---|
| 0x00 | 31 0n 00 | Operator on/off | 00-01 | 01 | 0 off, 1 ON |
| 0x01 | 31 0n 01 | EG rate 1 | 00-7F | 7F | 0 (slow) .. 127 (fast) |
| 0x02 | 31 0n 02 | EG rate 2 | 00-7F | 7F | same |
| 0x03 | 31 0n 03 | EG rate 3 | 00-7F | 7F | same |
| 0x04 | 31 0n 04 | EG rate 4 | 00-7F | 64 (100) | same |
| 0x05 | 31 0n 05 | EG level 1 | 00-7F | 7F | 0 (no output) .. 127 |
| 0x06 | 31 0n 06 | EG level 2 | 00-7F | 7F | same |
| 0x07 | 31 0n 07 | EG level 3 | 00-7F | 7F | same |
| 0x08 | 31 0n 08 | EG level 4 | 00-7F | 00 | same |
| 0x09 | 31 0n 09 | Keyboard rate scaling (KSC-R) | 00-7F | 00 | 0..127 |
| 0x0A | 31 0n 0A | Keyboard level scaling LEFT depth | 00-7F | 00 | 0 (flat) .. 127. Panel shows -127..+127 (RM p.4); the sign is carried by the curve byte (see 0x0C). INF |
| 0x0B | 31 0n 0B | Keyboard level scaling RIGHT depth | 00-7F | 00 | same |
| 0x0C | 31 0n 0C | Keyboard level scaling LEFT curve | 00-03 | 00 | 0 -LIN, 1 -EXP, 2 +EXP, 3 +LIN |
| 0x0D | 31 0n 0D | Keyboard level scaling RIGHT curve | 00-03 | 03 | same |
| 0x0E | 31 0n 0E | LFO amplitude-mod depth (AMD) | 00-7F | 00 | 0 (none) .. 127 |
| 0x0F | 31 0n 0F | LFO pitch-mod enable (LFO PMD on/off) | 00-01 | 01 | 0 off, 1 ON |
| 0x10 | 31 0n 10 | Pitch EG enable (PEG on/off) | 00-01 | 01 | 0 off, 1 ON |
| 0x11 | 31 0n 11 | Level velocity sensitivity (VEL.S) | 00-7F | 00 | 0 (none) .. 127 |
| 0x12 | 31 0n 12 | Output level (LEVEL) | 00-7F | 64 (100) on OP1, 00 on OP2-4 | 0..127. Carrier = volume; modulator = modulation depth |
| 0x13 | 31 0n 13 | Feedback level (FB) | 00-7F | 00 | 0..127 (magnitude; sign comes from 0x14) |
| 0x14 | 31 0n 14 | Feedback type | 00-01 | 00 | 0 sawtooth, 1 square |
| 0x15 | 31 0n 15 | Frequency mode | 00-01 | 00 | 0 Ratio, 1 Fixed (Hz) |
| 0x16 | 31 0n 16 | Frequency coarse | 00-1F | 01 | Section 3 |
| 0x17 | 31 0n 17 | Frequency fine | 00-63 (0..99) | 00 | Section 3 |
| 0x18 | 31 0n 18 | Detune (DTUNE) | 00-7F | 40 | raw-64 = -64..+63 (OFF DL p.9, RM p.3). Unit of one step is undocumented; measured 0.586 cent/step (§2.4) [DEV] |
| 0x19-0x1B | 31 0n 19..1B | reserved (3 bytes) | always 00 | 00 | do not write |

Cross-checks:
- Offsets 0x00-0x18 agree between DL, MK (block parsed as 28 bytes), SK `params_op`, and MT (`cOpon`..`cDetune`). [XC]
- MT and the CORPUS `.txt` files tie display to raw. Example: raw `0x7B` at offset 0x13 displays "FEEDBACK = 123"; raw `0x41` at 0x18 displays "FREQ DETUNE = 1". [XC CORPUS]
- Feedback display (RM p.4): panel value runs -127 (SQUARE) .. 0 .. +127 (SAW). Mapping: `display = (type == 0 ? +level : -level)`. Inverse on write: positive -> type 0 (saw), negative -> type 1 (square), magnitude -> level. [OFF RM + INF for the exact split]
- KSC display: panel shows depth -127..+127 and curve LIN/EXP; raw has depth 0..127 and a 4-value curve that includes the sign. INF mapping: curve 0 (-LIN) and 1 (-EXP) = negative depth; 2 (+EXP) and 3 (+LIN) = positive depth; EXP vs LIN from the curve value. CORPUS `.txt` prints these as `-LIN/-EXP/+EXP/+LIN`. Verify on the device. [INF]
- Break point for keyboard scaling is fixed at C3. [OFF RM p.4]

### 2.4 Measured operator curves [DEV: audio measurements of this unit, 2026-10-18]

Method. Unit: the user's reface DX on CoreMIDI port "reface DX" (its serial is not readable over USB, `iSerialNumber` = 0; read it from the label). Test voices were written to the edit buffer through the editor server; notes were sent with exact velocity from a second CoreMIDI client; DX L/R was recorded on UA Thunderbolt inputs 1/2 at 48 kHz through PortAudio. (ffmpeg's avfoundation input dropped about 8.5% of the samples, in 4096-sample chunks, on that 32-channel device; don't use it for measurements.) Neutral voice: ALGO 8, op1 only, RATIO 1.00, FX THRU, LFO and PEG off, KSC 0, flat EG, A3 = MIDI 57 (measured at 220.36 Hz). Amplitudes come from narrow-band demodulation at the measured frequency. Repeated points agreed within 0.01 dB for levels and 0.1% for rates. Not measured: KSC level-scaling curves, feedback, AMD.

1. **Output level (0x12).** For L ≥ 35: **−0.3762 dB per step = 1/16 octave** (6.02/16; R² = 1.0000000, max deviation 0.006 dB over 35..127). Reference points: 127 = 0, 111 = −6.02, 95 = −12.04, 63 = −24.08 dB. Below 35 the curve steepens: 31 −36.5, 27 −39.5, 23 −42.5, 19 −45.5, 15 −49.3, 11 −55.2, 7 −62.5, 3 −78.1; 0 is below the −100 dB noise floor. A modulator follows the same curve. The modulation index (peak phase deviation, radians) is `log2(I) = 0.06251·L − 4.2937`, with R² = 1.0000000 over L 39..127, and **I(127) = 12.51 ≈ 4π**. The index does not depend on the modulator's frequency: at L 95, ratio 1.5 gives 3.1276 and ratio 14 gives 3.1272 (phase modulation). Output level, EG level and velocity attenuation add in dB (checked on 4 + 3 combinations, within 0.01 dB).
2. **EG level (0x05-0x08)** at op level 127. This curve is **not** the output-level curve. Sustained dB: 127 0, 119 −1.40, 111 −2.88, 103 −4.38, 95 −5.99, 87 −7.71, 79 −9.54, 71 −11.35, 63 −13.32, 55 −15.46, 47 −17.76, 46 −18.03, 39 −20.17, 31 −23.03, 23 −26.55, 15 −30.06, 7 −38.57, 3 −48.08. Levels 1 and 0 are silent. Below 35, values come in equal pairs (33=34, 29=30, 25=26, …, 2=3).
3. **EG rates (0x01-0x04).** Every falling segment is linear in dB, so the decay is exponential. Speed in dB/s at A3 with KSC 0: 4 0.574, 8 0.710, 12 0.960, 16 1.233, 20 1.463, 24 2.015, 28 2.558, 32 3.475, 36 4.570, 40 5.667, 44 7.670, 48 10.23, 52 13.16, 56 18.26, 60 23.37, 64 33.62, 68 43.87, 72 61.34, 76 81.90, 80 117.1, 84 163.3, 88 221.4, 92 329.3, 96 460.5, 100 673, 104 1020, 108 1489, 112 2426, 116 3920. At 120–127 the fall is effectively instant (−40 dB in under 10 ms). Decay (R2) and release (R4) follow the same law within 2% up to 96 (at 81/82/83: 116.7/128.6/139.7 vs 117.0/128.3/140.3). An R2 above about 100 falls in two stages: a fast drop to −20..−35 dB, then a tail at about 200 dB/s. The values from 100 up are therefore release measurements. The speeds fit the DX7 increment law `speed = c·(4+m)·2^e`, `q = 4e+m`, in quarter-q steps: rate 60 = q 0, and each 4 rate steps add about 1.5 q below rate 48, 1.75 q from 48 to 76, and 2 q from 76 to 96.
   - Attack (R1) rise from −40 to −1 dB: 127 1.48 ms, 124 1.54, 120 2.6, 116 3.1, 112 3.4, 108 5.4, 104 7.5, 100 11.5, 96 16.1, 90 25.6, 80 61, 70 143, 60 305 ms.
   - When an instant attack is followed by a decay, the decay starts 0–7 ms after the onset, and the delay varies from note to note.
4. **KSC-R (0x09).** The pivot is **C4 (60)**: no value changes the speed at C4; notes below C4 decay slower and notes above decay faster. The shift is **Δq = KSC/32 per octave** from C4 and is continuous, so 127 doubles the speed per octave (23.4 dB/s at C4 → 46.8 at C5, 93.6 at C6, 187.4 at C7, 2.92 at C1). The scaling is multiplicative for any base rate: with KSC 127, C6/C2 = 16.0 at rate 40 and at rate 76.
5. **VEL.S (0x11).** Velocity only attenuates; it never boosts, and 0 dB is at velocity 127. `dB = −(127 − vel)·S·0.0029405`, i.e. S/128 output-level steps per velocity step (max deviation 0.06 dB over S 16..127, vel 1..127). It is linear in velocity, unlike the DX7's table (Dexed `dx7note.cc` `velocity_data`).
6. **Detune (0x18).** The step is constant in cents: **0.5860 cent per step** (≈ 1/2048 octave) at A1, A3, A5 and A6, so the offset in Hz scales with pitch (A3: +0.0749 Hz per step). Two carriers at +32 vs 0 beat at 2.397 Hz at A3, the same as the single-operator offset.

For DX7 ports (as used for the patch `dx7-epiano1-v2`): the DX7 side is cited from Dexed/msfa (asb2m10/dexed @ fea2f0f, `env.cc` `scaleoutlevel`/`advance`, `dx7note.cc` `ScaleVelocity`/`ScaleRate`/`osc_freq`), which is a well-regarded emulation, not hardware. In short: one DX7 output-level step (0.753 dB) equals two reface steps; full-scale modulation index is 4π on both; the DX7 detune step depends on the note (1.28 cents at A3, 0.73 cents at A5); DX7 RS 3 averages 1.5 q per octave, which matches KSC-R 48.

---

## 3. Frequency display conversion (operator offsets 0x15-0x18)

Official facts [OFF RM p.3]: Ratio mode range "0.500 to 31.99" ("a value with respect to the standard value of 1.00; doubling raises one octave"). Fixed mode range "1.000 to 9,772 Hz". Detune -64..+63. OM p.19 shows frequency screens "2.00 / 6.25 / 5.07 / 10.17" and says a fast flick from 9.29 jumps to 10.00, i.e. the display is `<coarse>.<fine as two decimals>`.

### 3.1 Ratio mode (mode raw = 0)

```
if coarse == 0:  ratio = 0.5 + fine * 0.005      // 0.500 .. 0.995
else:            ratio = coarse + fine / 100     // 1.00 .. 31.99
```

- This is additive. It is NOT the DX7 rule `coarse * (1 + fine/100)`, which would reach 61.69 and contradict the official maximum 31.99. [OFF range + XC]
- Support: the 26,312 operator samples in the CORPUS `.txt` files (generated by M. Tarenskeen's tool) follow this formula exactly (e.g. coarse 2 / fine 50 -> 2.5; coarse 0 / fine 9 -> 0.545; coarse 1 / fine 11 -> 1.11). YamahaSynth's description (first 31 harmonics plus a 0.5 sub-harmonic, fine values lie between whole multiples) agrees. [1S tool + OFF range; confidence: high but not measured on hardware]
- Coarse = 0 branch (0.5 base with a 0.005 step) is the least certain part. It matches the stated minimum 0.500 and the corpus. Verify on the device. [INF/1S]
- Detune is applied on top of this. Its unit is unspecified.

### 3.2 Fixed mode (mode raw = 1)

Hz = `10 ^ (decade + fine / 100)`, giving 1.000 Hz at (decade 0, fine 0) up to 10^3.99 = 9,772.4 Hz (matches the official range). The sources disagree on how `coarse` selects the decade:

| Hypothesis | Rule | Source / status |
|---|---|---|
| A (recommended default) | `decade = coarse >> 3` : coarse 0-7 -> 1 Hz decade, 8-15 -> 10 Hz, 16-23 -> 100 Hz, 24-31 -> 1000 Hz | 1S: CORPUS `.txt` (Tarenskeen tool, e.g. coarse 8/fine 0 -> 10.0, coarse 16/0 -> 100.0, coarse 26/50 -> 3162.2). Monotonic across the 0..31 slider, which suggests intentional design |
| B | `decade = coarse & 3` | DX7 / Dexed (`osc_freq`: `(coarse & 3)*100 + fine`). NOT verified for the reface |

Open question P0: sweep coarse 0..31 in Fixed mode on the device and read the LCD to settle A vs B. Until then show Fixed-mode Hz as "estimated".
Fine in Fixed mode: `10^(fine/100)` multiplier (1.000..9.772). Verified by the corpus examples (fine 50 -> x3.162). [1S]

Safety: OM p.19 warns that a very low carrier frequency in FIXED mode can damage speakers. The editor should warn when a carrier is in Fixed mode at a very low frequency (author's heuristic: below roughly 20 Hz).

### 3.3 Detune

`display = raw - 64`, range -64..+63. [OFF DL p.9 / RM p.3; XC MT/CORPUS]

Step size: 0.586 cent, constant in cents from A1 to A6, so the Hz offset grows with pitch (§2.4 item 6). [DEV]

### 3.4 CC representation (not SysEx)

CC "coarse" takes values 0-31 directly (not scaled to 0-127) and CC "fine" takes 0-99 directly. [OFF DL p.8]

---

## 4. Effects (Common offsets 0x1D-0x22)

Two insert effects in series slots: Effect 1 and Effect 2. [OFF OM p.22]

| Type raw | Name | Param 1 (offset +1) | Param 2 (offset +2) | Range |
|---|---|---|---|---|
| 0 | THRU | not used | not used | |
| 1 | DIST (distortion) | DRIVE | TONE | 0..127 each |
| 2 | T.WAH (touch wah) | SENS | REZ | 0..127 each |
| 3 | CHO (chorus) | DEPTH | RATE | 0..127 each |
| 4 | FLA (flanger) | DEPTH | RATE | 0..127 each |
| 5 | PHA (phaser) | DEPTH | RATE | 0..127 each |
| 6 | DLY (delay) | DEPTH | TIME | 0..127 each |
| 7 | REV (reverb) | DEPTH | TIME | 0..127 each |

Sources: DL p.9 (types 00-07, parameter names and 0-127 ranges), OM p.22 (type list with descriptions). Corpus `.txt` files print "FX1 TYPE = 6 (Delay)... PARAM 1 = 64 (Depth)... PARAM 2 = 96 (Time)" and "FX2 TYPE = 5 (Phaser)", consistent with this table. [OFF + XC]
GT: raw 03 (CHO) and 07 (REV) for the voice "LegendEP". [DEV]
Panel display of the parameter values is presumably 0..127, but this is not stated. The value left in a parameter slot when the type is THRU is retained (not zeroed) in dumps. [INF]

---

## 5. The 12 algorithms

Source summary:
- The official documents contain NO algorithm chart. The Owner's Manual shows only two screens, both with operator numbers: ALGO 8 (OM p.19) and ALGO 4 (OM p.20, voice "DigiChord" at Bank 1-1). [OFF]
- The community chart (bryc gist `!Algorithms.md`, image of all 12, no operator numbers) gives the topology of all 12. The same gist says the reface uses 7 of the 8 DX9 algorithms plus three DX7-derived 4-op algorithms (DX7 #25, #13, #30) and two custom ones. [1S]
- A MOD WIGGLER forum thread (a user reading the front-panel diagrams in text) gives operator numbers for ALGO 1-7. The author could only read it through search-summary snippets (the site blocks automated fetches), so treat it as 1S and partly jumbled. [1S]
- Rules common to all 12 (OFF OM p.19): every operator has its own feedback (self-loop) with a level and a saw/square type, carriers are drawn as squares, modulators as circles, and carriers are summed to the output. Feedback is independent per operator.

Notation: `A>B` means A modulates B. `*` = carrier. Output = sum of carriers. Raw value = ALGO - 1.

| ALGO | Raw | Carriers | Modulation edges | Confidence |
|---|---|---|---|---|
| 1 | 00 | 1 | 4>3, 3>2, 2>1 | 1S forum + community chart agree |
| 2 | 01 | 1 | 4>2, 3>2, 2>1 | 1S forum + chart agree |
| 3 | 02 | 1 | 4>1, 3>2, 2>1 | 1S forum (chart shape agrees; numbering from forum only) |
| 4 | 03 | 1 | 4>2, 4>3, 2>1, 3>1 | OFF OM p.20 screen (DigiChord) + 1S forum |
| 5 | 04 | 1 | 2>1, 3>1, 4>1 | 1S forum + chart |
| 6 | 05 | 1, 2 | 4>3, 3>2 (op1 unmodulated) | INF: topology from chart, numbering from a jumbled forum snippet. Verify |
| 7 | 06 | 1, 2 | 4>3, 3>1, 3>2 | 1S forum + chart |
| 8 | 07 | 1, 3 | 2>1, 4>3 | OFF OM p.19 screen (both carriers 1 and 3, modulators 2 and 4); GT device voice uses raw 07 |
| 9 | 08 | 1, 2, 3 | 4>1, 4>2, 4>3 | INF: topology from chart, numbering by analogy to DX7 #22 |
| 10 | 09 | 1, 2, 3 | 4>2, 4>3 (op1 unmodulated) | INF: same basis (DX7 #25 analog) |
| 11 | 0A | 1, 2, 3 | 4>3 | INF: same basis (DX7 #31 analog) |
| 12 | 0B | 1, 2, 3, 4 | none (four parallel carriers) | topology certain (chart); numbering irrelevant |

Structured form for diagram code (algorithm -> edges as [source, destination] pairs, with carrier list):

```
1  carriers:[1]       edges:[[4,3],[3,2],[2,1]]
2  carriers:[1]       edges:[[4,2],[3,2],[2,1]]
3  carriers:[1]       edges:[[4,1],[3,2],[2,1]]
4  carriers:[1]       edges:[[4,2],[4,3],[2,1],[3,1]]
5  carriers:[1]       edges:[[2,1],[3,1],[4,1]]
6  carriers:[1,2]     edges:[[4,3],[3,2]]                  (INF)
7  carriers:[1,2]     edges:[[4,3],[3,1],[3,2]]
8  carriers:[1,3]     edges:[[2,1],[4,3]]
9  carriers:[1,2,3]   edges:[[4,1],[4,2],[4,3]]            (INF)
10 carriers:[1,2,3]   edges:[[4,2],[4,3]]                  (INF)
11 carriers:[1,2,3]   edges:[[4,3]]                         (INF)
12 carriers:[1,2,3,4] edges:[]
```

ASCII sketches (top = modulators, bottom = carriers; `*` = carrier; every box also has a self-feedback loop):

```
ALGO 1        ALGO 2        ALGO 3        ALGO 4        ALGO 5
 4             4   3          3           4              2   3   4
 |              \ /           |          / \              \  |  /
 3               2        4   2         2   3               \ | /
 |               |         \ /           \ /                  1*
 2               1*         1*            1*
 |
 1*

ALGO 6 (INF)  ALGO 7        ALGO 8        ALGO 9 (INF)  ALGO 10 (INF)  ALGO 11 (INF)  ALGO 12
 4              4            2   4           4              4               4
 |              |            |   |         / | \          / \                |        1* 2* 3* 4*
 3              3            1*  3*       /  |  \        |   |               3*
 |             / \                       1*  2*  3*       2*  3*   1*     1*  2*
 2*   1*      1*  2*                                                  (op1 alone)
```
(ALGO 10: op 4 feeds ops 2 and 3; op 1 is an unmodulated carrier. ALGO 11: op 4 feeds op 3; ops 1 and 2 are unmodulated carriers.)

Verification procedure (cheap, recommended before drawing diagrams): step [ALGO] 1..12 on the device; the LCD draws numbered operators (squares = carriers, circles = modulators), as in the manual's ALGO 8 and ALGO 4 screens. Record 12 photos or sketches. [open question P1]

---

## 6. Behavioural facts for an editor

### 6.1 (a) Does the DX transmit SysEx or CC when the front panel changes?

- Official: when MIDI Control is ON, the reface DX transmits a Control Change message when a setting is changed in the FM section ([FREQ], [LEVEL], [ALGO], [FB] buttons), "but not when any other settings are changed". Volume and octave send nothing. [OFF OM p.42]
- Official: the CC table is "transmitted and recognized ... when MIDI control is on". [OFF DL p.8; MIDI chart note *1]
- Gate: System parameter `00 00 0E` "MIDI Control" (off by default). Panel: [FUNCTION] -> MIDI Settings -> CONTROL ON/off (page 2 on firmware before 1.30, page 3 on firmware 1.30 and later), or the keyboard shortcut in OM p.41. The OM recommends "Local Control off, MIDI Control on" for DAW recording. [OFF OM p.38, p.42; FW130 p.13]
- Nothing in the Data List or Owner's Manual says the DX emits SysEx Parameter Change messages for panel edits. EG, LFO, effect, name, etc. edits made on the panel are therefore NOT announced on MIDI as far as documented. All open-source editors work by pulling a bulk dump on demand (MT "sync" button; MK/SK dump requests). [OFF negative + XC]
- Open question P0: monitor the USB-MIDI input while turning panel controls, with MIDI Control both on and off, to confirm that no SysEx is emitted. Also confirm that SysEx Parameter Change writes work with MIDI Control OFF (GT confirms a write worked but the MIDI Control state was not recorded).
- Design consequence: live sync of FM-section values can use CC when MIDI Control is on; everything else needs polling via `0E 0F 00` dump requests (241 bytes each). Cadence is unknown; tune on the device.

### 6.2 (b) Program Change selects the 32 voice memories

- Official: Program Change 0-31 recognized and transmitted. [OFF DL p.6 (3-1-4), p.9 table, MIDI chart "Prog Change 0-31 / 0-31"]
- Mapping: PC 0-7 = Bank 1-1..1-8, 8-15 = Bank 2-1..2-8, 16-23 = Bank 3-1..3-8, 24-31 = Bank 4-1..4-8. So `PC = (bank-1)*8 + (voice-1)`. [OFF DL p.9]
- Bank Select (CC 0 / CC 32) is NOT recognized (not in the CC list of the MIDI chart). Do not send it. [OFF MIDI chart]
- Sent on the MIDI RECEIVE channel (System 0x01), or any channel when RV CH = ALL. [OFF/INF]
- The select-then-dump backup flow is implemented in production tools: MK `BANK_DUMP` sends `Program Change(elem)` then `F0 43 20 7F 1C 05 0E 0F 00 F7` for each of 32 voices and expects 7 messages each; SK README demonstrates "program change #16" followed by a dump request to read bank 3 slot 1. [XC MK + SK]
- The panel transmits PC when you select a voice (MIDI chart "transmitted: o 0-31"); not verified on the device. [OFF chart; unverified behaviour]
- Caution: PC loads the STORED voice into the edit buffer and discards unsaved edits (OM p.S-6: unsaved voice data is lost; the Job "EDIT RECAL" can bring back the last edited state after switching, OM p.22). Always request a dump before sending PC if unsaved panel edits matter. Whether a PC to the already-selected program reloads the stored voice is unknown. [OFF + open question]
- Rate between PC and dump request: no documented requirement; implement "request, wait for the Footer block `0F 0F 00`, then next PC" with a timeout (SK uses 5 s; DH sleeps 1 s). [XC]

### 6.3 (c) Control Change map [OFF DL p.8; XC midi.guide]

Transmitted AND recognized only when MIDI Control = ON (except the standard controllers below).

| CC | Parameter | Transmitted value(s) | Recognized value ranges |
|---|---|---|---|
| 80 | Algorithm | ALGO 1..12 = 0, 12, 23, 35, 46, 58, 69, 81, 92, 104, 115, 127 | ALGO 1: 0-11, 2: 12-21, 3: 22-32, 4: 33-42, 5: 43-53, 6: 54-64, 7: 65-74, 8: 75-85, 9: 86-95, 10: 96-106, 11: 107-116, 12: 117-127 |
| 85 / 102 / 108 / 114 | OP1 / OP2 / OP3 / OP4 output level | 0-127 | 0-127 |
| 86 / 103 / 109 / 115 | OPn feedback level | 0-127 | 0-127 |
| 87 / 104 / 110 / 116 | OPn feedback type | 0 = sawtooth, 127 = square | 0-63 saw, 64-127 square |
| 88 / 105 / 111 / 117 | OPn frequency mode | 0 = ratio, 127 = fixed | 0-63 ratio, 64-127 fixed |
| 89 / 106 / 112 / 118 | OPn freq coarse | 0-31 | 0-31 |
| 90 / 107 / 113 / 119 | OPn freq fine | 0-99 | 0-99 |

Always-on controllers (MIDI chart): transmitted CC 64 (sustain; with pedal type FC4/5 only values 0 or 127); recognized CC 1 (modulation), 7 (volume), 11 (expression), 64 (sustain). Also recognized: CC 120 (all sound off), 121 (reset all controllers), 123-125 (all notes off / omni), 126/127 (mono/poly). Pitch bend transmitted and recognized; aftertouch neither. [OFF DL p.6/p.10]
Note: for the whole DX the CC set covers only 25 parameters (algorithm + per-op level, feedback level/type, frequency mode/coarse/fine). Everything else is SysEx-only. [OFF DL p.8]

### 6.4 (d) Can a received bulk dump write to a memory slot?

- The Data List defines no slot index and no "store" command. The voice bulk block addresses (`0E 0F 00`, `30 00 00`, `31 0n 00`, `0F 0F 00`) are position-less: they address the EDIT BUFFER of the currently selected voice only. [OFF DL p.8 (absence); INF from the address map]
- Hardware users report the same: RS README: "Sent voices land in the edit buffer, not memory ... you must press Store on the synth to keep the incoming patch"; a blogger (sandsoftwaresound.net) loads patches with MIDI-OX then "hit the Reface STORE button, choose a target voice slot, and confirm". A Yamaha forum thread (via search summary) says the loaded patch appears in the currently selected slot. MK ignores the destination slot when sending. [1S/XC across 3 user reports + MK; not documented officially]
- Consequence for backup/restore: backing up 32 voices is fully automatable (PC + dump request x32). Restoring to specific slots is NOT possible over MIDI. Each voice needs the user to press the STORE flow on the panel (bank 1-1..4-8, optionally rename), 32 times for a full restore. Whether Yamaha's Soundmondo or the iOS "reface Capture" app can write directly into slots is not documented or verified. [open question]
- Open question P1: confirm on the device that no combination (e.g. PC then dump) writes to memory without a panel Store.

### 6.5 (e) Rate limiting and timing

No limit is documented officially. Practical values reported by tool authors:

| Source | Value |
|---|---|
| RS | A voice = 7 messages "sent individually with a gap. The default 20 ms is comfortable; if patches arrive garbled, raise it" (UI slider 2-120 ms). Its DEV.md states the author confirmed sending to a real DX from Chrome |
| SK `get_soundmondo_voice.py` | Delay between SysEx messages: CLI default 10 ms, function default 50 ms |
| MT | Checks one of 5 blocks every 100 ms (each block every 500 ms) and sends parameter changes immediately (no throttle) |
| DH | Waits 1 s after a dump request before reading replies |
| SK `midiio` | 5 s timeout when waiting for the 7 reply messages |
| DL | Active Sensing rule: after receiving `FE`, 350 ms of silence clears the receive buffer (see 1.6) |

Recommendations (INF): 20 ms between messages of a bulk write; for slider drags coalesce to the latest value per parameter (a 11-byte parameter change is about 3.5 ms at DIN speed; USB is faster, but the synth's internal limit is unknown); do not interleave a bulk write with parameter changes; wait for a dump's Footer before issuing the next request. Measure the real limit on the device before shipping (P0).

### 6.6 Other behaviours worth knowing

- Auto Power-Off (default ON, 30 min of inactivity, OM p.41): an editor session can lose the device. Disable with `F0 43 10 7F 1C 05 00 00 0C 00 F7` (RS offers this). It is unknown whether MIDI traffic counts as activity. [OFF + XC RS]
- USB: Yamaha asks for at least six seconds between power on/off and connecting/disconnecting the cable; use a USB cable of 3 m or less (no USB 3.0 cable). [OFF OM p.39]
- Voice settings not stored are lost at power-off. [OFF OM p.S-6]
- Maximum polyphony is 8 notes and there are 32 voices [OFF OM p.48 spec table]. Transmit channel can be set to 1-16 or off; when off, nothing is transmitted. [OFF OM p.21, p.43]
- Parameter change reception of out-of-range values is undocumented (clamp/ignore/corrupt unknown). Clamp in the editor to the raw ranges in section 2 (note the non-zero minimums: transpose/PB 0x28-0x58, PEG level 0x10-0x70, fine max 0x63, curves 0-3, algorithm 0-0x0B, LFO wave 0-6, effect type 0-7).
- Back up all 32 voices (read-only operations) before any write experiment.

---

## 7. Presets, banks, and factory voices

### 7.1 (1) Bank / voice organization

- 32 voice memories = 4 banks x 8 voices. Panel: [BANK] button cycles bank 1-4; buttons [1]-[8] select the voice within the bank; the display shows "Bank 1-1" etc. [OFF OM p.20]
- Program Change: `PC = (bank-1)*8 + (voice-1)`, PC 0-7 = Bank 1, 8-15 = Bank 2, 16-23 = Bank 3, 24-31 = Bank 4. [OFF DL p.9]
- Bank Select CC0/CC32 is not recognized and not needed. [OFF DL MIDI chart]
- In Edit mode the voice buttons [1]-[8] become [OP1]-[OP4], [EG level], [EG rate], [LFO], [Pitch EG]; leave Edit mode with [EDIT]. [OFF RM p.2]
- STORE writes the current voice to any of 1-1..4-8 with a 10-character name; "STORE TO" overwrites the Preset Voice at that location. Restore factory contents with Job "VOICE RECALL" (current slot; loads into the edit buffer, then STORE to keep) or "FCTRY RESET" (all parameters including settings, OM p.22/p.40). VOICE INIT sets a sine-wave voice. EDIT RECAL returns the last edited condition. [OFF OM p.22-23, p.40]
- Destructive actions to keep out of any editor workflow: Voice Initialize, Voice Recall, Factory Reset, Store. Factory Reset overwrites everything.

### 7.2 (2) Factory voice list

Source: single third-party list (Japanese blog "DX7 から reface DX へプリセット音の進化", 2016-03-26, https://pota-run.blogspot.com/2016/03/dx7-reface-dx-preset-sound.html). Cross-checks that raise confidence to medium-high: (i) OM p.20 screenshot shows "Bank 1-1 DigiChord" [OFF]; (ii) Yamaha's own "VOICE RECALL Function" article places "LegendEP" at Bank 1-4 (read via search summary) [1S official-site]; (iii) all 32 names exist in the 9,310-voice Soundmondo corpus; (iv) the GT device edit buffer holds "LegendEP". The official Data List and Owner's Manual do NOT list voice names. Do not treat the table as authoritative for the user's unit: a unit may hold modified voices.

| Bank | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |
|---|---|---|---|---|---|---|---|---|
| Bank 1 (PC 0-7) | DigiChord | WobbleBass | MotionPad | LegendEP | DynaLead | DarkBass | TublarBell | D'n'Beats |
| Bank 2 (PC 8-15) | BeginSweep | MoDemLead | BeepBass | BitTune | TinPerc | BleepClv | FeelIt | BuzzSiren |
| Bank 3 (PC 16-23) | WoodEP | UniLead | AttackBass | CloudPad | AmbiPluck | Marimba | CheezOrgan | FM Brass |
| Bank 4 (PC 24-31) | SolPhase | FlyingKode | AlTiPad | StarPad | WarmPad | FutureBell | GlassHarp | Chopper |

(Names are the 10-character voice names, trailing spaces trimmed.) Not to be confused with a different table at sandsoftwaresound.net (Rhodes, Wurlitzer, ...): that is the blogger's own custom set, not the factory set.
A device-side check that costs nothing: PC 0..31 + dump request, then read the names (only valid if the user has not overwritten the slots).

### 7.3 (3) Official factory voice data / voice packs (URLs only; nothing downloaded or run)

Result: no official Yamaha-published `.syx` factory voice file was found (negative finding from searches; the official Downloads page lists manuals, updaters, USB driver only). Official/semi-official resources:

- Official Downloads page (manuals, Data List, updater v1.30, USB-MIDI driver): https://usa.yamaha.com/products/music_production/synthesizers/reface/dx/downloads.html
- Soundmondo (Yamaha cloud voice sharing and librarian; thousands of user voices; a community thread asks "What happened to soundMondo?", so treat availability as uncertain): https://soundmondo.yamahasynth.com/ and https://yamahasynth.com/community/postid/3177/
- YamahaSynth "Free patches from Soundmondo": https://yamahasynth.com/community/postid/19858/
- Voice List XML for Cubase (official program-name list, attached to a YamahaSynth forum resource; would contain the 32 factory names but could not be fetched): https://yamahasynth.com/learn/reface/installing-reface-dx-voice-list-xml-file-in-cubase/
- Voice Recall article: https://yamahasynth.com/learn/reface/voice-recall-function-reface/
- Yamaha forum thread on sending SysEx / "reface Capture" iOS app: https://yamahasynth.com/community/postid/3216/

Third-party (not Yamaha) voice sets:
- Reface DX Legacy Project (M. Tarenskeen; claims SYX and TXT of the 32 factory presets, a Soundmondo mirror, converted DX21/TX81Z/etc. voices): https://refacedx.martintarenskeen.nl/ (site blocks automated fetching; not read)
- Mirror used by RS: https://soundmondo.martintarenskeen.nl/
- RS repository with ~9,300 `.syx` and ~6,600 `.txt` (the CORPUS used for validation): https://github.com/normaldotcom/refacesender

### 7.4 (4) Store to a specific slot over MIDI

No. See 6.4. A received bulk dump (or per-parameter changes) only affects the edit buffer. Storing into a slot requires the panel [STORE] flow. [1S/XC user reports; not officially documented]

---

## 8. Discrepancies and open questions

### 8.1 Discrepancies between sources

| # | Item | Detail |
|---|---|---|
| D1 | Byte-count wording | DL says "from Model ID onward up to but not including the checksum"; observed value = address+data+checksum. Numerically identical (N+4). No action |
| D2 | Reported "header/footer byte count typo (00 00 vs 00 04)" | Not present in DL revision B0 (lists 4 / 04); CORPUS shows `00 04` on every header/footer. Resolved |
| D3 | SK `params_common` | Pitch EG level range given as 0-127 (official: 0x10-0x70) and op fine as 0-63 (official: 0x00-0x63). SK is wrong on these; do not copy |
| D4 | SK `is_reface_dx_bulk_dump(device=)` | Compares byte 2 with `0x20 \| device`; real dumps carry `0x0n`. Latent bug |
| D5 | SK `checksum()` | Returns 0x80 when `sum & 0x7F == 0`. Use the formula in 1.5 |
| D6 | MT editor | Effect 2 param 1 is read from `mVCOM[cEf1param2]` (should be `cEf2param1`): it will write wrong values. Also checks `'pwg'` instead of `'peg'`. Do not copy MT's polling "diff and write" loop |
| D7 | CC coverage | A YamahaSynth page says every front-panel control sends CC; the Owner's Manual says the DX sends CC only for the FM section. OM governs (other models differ) |
| D8 | Fine frequency rule | DX7 is multiplicative (`coarse*(1+fine/100)`); reface is additive (official max 31.99). Do not reuse Dexed/DX7 formulas for ratio |
| D9 | Fixed-mode decade | CORPUS tool: `coarse >> 3`; DX7/Dexed: `coarse & 3`. Unresolved (P0) |
| D10 | Factory list | sandsoftwaresound.net "bank layout" differs from the factory list; it is the author's custom set |
| D11 | Panel vs raw | Panel shows FB -127..+127, KSC depth -127..+127, detune -64..+63, transpose/PB/PEG level as signed; raw uses level+type, depth+curve, and offset-64 encodings. Inferred mapping in 2.3 |

### 8.2 Open questions (verify on the real device)

Priority P0 (needed before shipping any write path):

1. Rate limit and ordering: maximum safe rate of Parameter Change messages (burst and sustained), and minimum gap between the 7 messages of a bulk write. Start at 20 ms between bulk messages; test 2/5/10 ms.
2. Does the DX emit any SysEx (Parameter Change or dump) or CC when panel controls move, with MIDI Control on and off (USB-MIDI monitor)? Does Parameter Change work with MIDI Control off?
3. Fixed-mode coarse -> decade (hypothesis A vs B in 3.2): sweep coarse 0..31, fine 0, read the LCD Hz.
4. Out-of-range values: does the device clamp, ignore, or store them? Test on a throwaway voice after backing up all 32.
5. Does the device accept a bulk write with a wrong checksum? (Informational; always send a correct one.)

Priority P1:

6. Algorithm operator numbering for ALGO 3, 6, 9, 10, 11 (photograph the LCD for all 12).
7. Parameter Request (`3n`) reply format; whether dump requests for `30 00 00` / `31 0n 00` / `00 00 00` return single blocks (only `00 00 00` and `0E 0F 00` are confirmed by tools).
8. Are Header and Footer required when sending a partial voice (e.g. Common only)? Does a partial voice keep the other blocks from the previous edit buffer?
9. Device-number semantics: are `n != 0` accepted? Is `n` tied to the receive channel?
10. Does selecting a voice on the panel send PC? On which channel? With MIDI Control off?
11. Does PC to the already-selected program discard unsaved edits? Does the edit buffer survive PC (Edit Recall behaviour)?
12. Do SysEx-written System parameters persist after power-off (OM p.S-6 "without first changing the screen")? Which firmware version is the unit (Master Tune/Transpose require 1.30)?
13. KSC depth/curve and FB level/type mapping from raw to panel values (2.3).
14. Master Tune center value (`00 04 00 00` inferred), Tempo bit layout, default RV CH.
15. Panel display ranges of effect parameters (0..127 assumed), and whether THRU retains parameters.
16. Detune step size (cents per unit); Pitch EG level unit (semitones assumed from "-48 = -4 octave"). Detune: answered, 0.586 cent/step (§2.4) [DEV]; Pitch EG unit still open.
17. Does MIDI traffic reset Auto Power-Off?
18. Is the 32-factory-voice list in 7.2 accurate for this unit (names via PC + dump of untouched slots)?

---

## 9. Sources

Official Yamaha:
- reface CS/DX/CP/YC Data List (DL): https://usa.yamaha.com/files/download/other_assets/7/794817/reface_en_dl_b0.pdf (also https://data.yamaha.com/files/download/other_assets/7/794817/reface_en_dl_b0.pdf)
- reface CS/DX/CP/YC Owner's Manual (OM): https://data.yamaha.com/files/download/other_assets/6/438816/ZT92080_reface_En_OM_C0.pdf
- reface Reference Manual (RM): https://data.yamaha.com/files/download/other_assets/7/438827/reface_en_rm_a0.pdf
- reface Version 1.30 Supplementary Manual (FW130): https://data.yamaha.com/files/download/other_assets/0/960060/v130_Manual_en.pdf
- reface DX downloads page: https://usa.yamaha.com/products/music_production/synthesizers/reface/dx/downloads.html

Open-source code and data (read-only inspection):
- MK: https://github.com/christofmuc/MidiKraft-yamaha-refacedx (files `RefaceDX.cpp`, `RefaceDXPatch.cpp`)
- SK: https://github.com/SpotlightKid/reface-dx-lib (files `refacedx/constants.py`, `voiceparams.py`, `midiio.py`, `util.py`, `tools/get_soundmondo_voice.py`)
- MT: https://github.com/mikatahara/RefaceDX and the live app https://mikatahara.github.io/RefaceDX/ (files `myrefacedx.js`, `mysetformop.js`, `mysetformvcom.js`)
- RS: https://github.com/normaldotcom/refacesender (README, DEV.md, `index.html`, `assets/DX/`)
- DH: https://github.com/dmhrpr/reface-dx-sysex-librarian
- Community algorithm chart: https://gist.github.com/bryc/e997954473940ad97a825da4e7a496fa
- midi.guide CC map: https://midi.guide/d/yamaha/reface-dx/

Community / third-party pages (several are bot-protected; content known through search summaries only, marked 1S):
- Factory list blog: https://pota-run.blogspot.com/2016/03/dx7-reface-dx-preset-sound.html
- Algorithm text reading (MOD WIGGLER): https://www.modwiggler.com/forum/viewtopic.php?t=209554 (and https://modwiggler.com/forum/viewtopic.php?p=3004969)
- YamahaSynth forum: https://yamahasynth.com/community/postid/3216/ , https://yamahasynth.com/community/postid/4189/ , https://yamahasynth.com/community/postid/3171/ , https://yamahasynth.com/community/postid/17076/
- YamahaSynth articles: https://yamahasynth.com/learn/reface/midi-control-possibilities-reface/ , https://yamahasynth.com/learn/reface/voice-recall-function-reface/
- Reface DX Legacy Project and Ctrlr panel (not read): https://refacedx.martintarenskeen.nl/ , https://ctrlr.martintarenskeen.nl/
- Sand, Software and Sound blog (custom voice set, shows a MIDI-OX plus STORE workflow): http://sandsoftwaresound.net/category/reface/
- DX7 fixed-frequency math reference (Dexed issue): https://github.com/asb2m10/dexed/issues/34

Author's own verification (not a third-party source): a throwaway script parsed all 9,310 CORPUS `.syx` files: 9,309 are complete 241-byte / 7-message voices, 65,163/65,163 messages have a valid checksum and `byte count = data + 4`, device byte is `00` throughout, per-offset value ranges match section 2, and reserved bytes are always `00`. The 6,578 `.txt` files were used only for the ratio/fixed-frequency display rule.
