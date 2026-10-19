// Entry point: `npm start` (loads ./.env if present). Env: PORT (7777), DX_MIDI_PORT ("reface DX"),
// DX_DATA_DIR (./data), ANTHROPIC_API_KEY (enables AI sound design; never logged or sent to clients).
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { DEFAULT_PORT } from '../shared/protocol.ts';
import { InputPort, MidiTransport } from './midi.ts';
import { DxDevice } from './device.ts';
import { Editor } from './editor.ts';
import { createHttpServer } from './http.ts';

const root = resolve(fileURLToPath(import.meta.url), '../..');
const port = Number(process.env.PORT ?? DEFAULT_PORT);
const midiPort = process.env.DX_MIDI_PORT ?? 'reface DX';
const dataDir = resolve(process.env.DX_DATA_DIR ?? resolve(root, 'data'));

// Timing measured on the device (docs/architecture.md "Device timing"): 272 param changes in a 0.5 ms burst
// all landed; bulk writes read back intact at 0..20 ms gaps; a dump round-trip takes 18-25 ms.
const transport = new MidiTransport(midiPort);
const device = new DxDevice(transport, { paramGapMs: 1, bulkGapMs: 20, dumpTimeoutMs: 2000 });
// The SDK reads ANTHROPIC_API_KEY from the environment itself; the key is not passed around in this code.
// MIDI thru source (a controller keyboard), rescanned like the DX port; the selection lives in data/settings.json.
const thruInput = new InputPort();
const editor = new Editor(device, thruInput, dataDir, process.env.ANTHROPIC_API_KEY ? new Anthropic() : null);
const server = createHttpServer(editor, resolve(root, 'web/dist'));

transport.on('connected', () => console.log(`[midi] connected to "${midiPort}"`));
transport.on('disconnected', () => console.log(`[midi] "${midiPort}" disconnected`));
server.listen(port, '127.0.0.1', () => {
  console.log(`reface DX editor on http://127.0.0.1:${port} (MIDI port "${midiPort}", data ${dataDir}, AI ${editor.status().ai.configured ? 'on' : 'off: no ANTHROPIC_API_KEY'})`);
  editor.start();
  if (!transport.connected) console.log(`[midi] "${midiPort}" not found; waiting for it (rescan every 2 s)`);
});

function stop(): void {
  editor.shutdown(); // all notes off before the port closes
  server.close();
  setTimeout(() => process.exit(0), 100).unref();
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
