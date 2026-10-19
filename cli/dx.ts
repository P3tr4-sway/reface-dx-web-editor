// AI-mode CLI: thin client of the HTTP API. Prints one line of compact JSON; errors go to stderr as
// {"error": ...} with exit code 1 (API error) or 2 (server not reachable).
import { readFileSync } from 'node:fs';
import { DEFAULT_PORT, type AiJob, type PresetScan } from '../shared/protocol.ts';
import type { ParamDef } from '../shared/params.ts';

const BASE = process.env.DX_URL ?? `http://127.0.0.1:${process.env.PORT ?? DEFAULT_PORT}`;

const USAGE = `usage: dx <command>
  status                      device, current slot, dirty flag, undo/redo availability
  params [group]              parameter schema (groups: voice lfo pitchEg fx op1..op4)
  get [--raw]                 current voice values + derived info (algorithm, frequencies, fx param names)
  set id=value ...            e.g. dx set op1.level=100 algorithm=5 partMode=MONO-LEGATO "name=My Bell"
  put <file.json|->           write a whole voice ({id: value} for every param, or {"values": {...}})
  refresh                     re-read the edit buffer from the DX
  undo | redo
  presets [--scan]            cached 32 preset names; --scan re-reads all 32 slots (~8 s) and writes a backup
  load <bank-voice>           load stored voice, e.g. dx load 2-3 (or 0..31)
  play [preset|notes] [--vel N] [--dur S]   presets: chord arp bass lead pad keys; notes: C4,E4,G4 (C4 = MIDI 60)
  thru ["<port>"|off]         MIDI thru: show state and inputs; play a controller into the DX
                              (keys, sustain, bend, mod; saved across restarts), e.g. dx thru "Keystation 49 MK3 (USB MIDI)"
  patches                     list local patches (data/patches)
  save <name>                 save the current voice as a local patch
  open <name>                 load a local patch into the edit buffer
  ai "<prompt>"               Claude designs a voice (e.g. dx ai "glassy 80s e-piano"), writes it as one undo step,
                              plays a phrase; waits and prints the result (Ctrl-C cancels while designing)`;

function fail(code: number, error: string): never {
  console.error(JSON.stringify({ error }));
  process.exit(code);
}

async function api(method: string, path: string, body?: unknown): Promise<any> {
  let res: Response;
  try {
    res = await fetch(BASE + path, {
      method, headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    return fail(2, `server not running at ${BASE}: start it with "npm start" (in the project root)`);
  }
  const data = await res.json();
  if (!res.ok) fail(1, data.error ?? `HTTP ${res.status}`);
  return data;
}

function option(args: string[], name: string): number | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const [, value] = args.splice(i, 2);
  if (value === undefined || Number.isNaN(Number(value))) fail(1, `${name} needs a number`);
  return Number(value);
}

function describe(p: ParamDef) {
  const range = p.kind === 'int' ? `${p.min}..${p.max}` : p.kind === 'enum' ? p.options.join('|')
    : p.kind === 'bool' ? 'true|false' : `text<=${p.length}`;
  return { id: p.id, range, desc: p.description };
}

const byBank = (scan: PresetScan) => Object.fromEntries([1, 2, 3, 4].map((b) =>
  [`bank${b}`, scan.presets.filter((p) => p.slot >> 3 === b - 1).map((p) => `${p.label} ${p.name}`)]));

async function main(argv: string[]): Promise<unknown> {
  const [cmd, ...args] = argv;
  switch (cmd) {
    case 'status': return api('GET', '/api/status');
    case 'params': {
      const params: ParamDef[] = await api('GET', '/api/params');
      const list = params.filter((p) => !args[0] || p.group === args[0]);
      if (!list.length) fail(1, `no group "${args[0]}"; groups: ${[...new Set(params.map((p) => p.group))].join(' ')}`);
      return list.map(describe);
    }
    case 'get': return api('GET', `/api/voice${args.includes('--raw') ? '?raw=1' : ''}`);
    case 'set': {
      if (!args.length) fail(1, 'usage: dx set id=value ...');
      const body = Object.fromEntries(args.map((a) => {
        const eq = a.indexOf('=');
        if (eq < 1) fail(1, `expected id=value, got "${a}"`);
        return [a.slice(0, eq), a.slice(eq + 1)];
      }));
      return api('PATCH', '/api/voice', body);
    }
    case 'put': {
      if (!args[0]) fail(1, 'usage: dx put <file.json|->');
      const text = readFileSync(args[0] === '-' ? 0 : args[0], 'utf8');
      return api('PUT', '/api/voice', JSON.parse(text));
    }
    case 'refresh': return api('POST', '/api/voice/refresh');
    case 'undo': return api('POST', '/api/undo');
    case 'redo': return api('POST', '/api/redo');
    case 'presets': {
      const scan = await api(args.includes('--scan') ? 'POST' : 'GET', args.includes('--scan') ? '/api/presets/scan' : '/api/presets');
      if (!scan.presets) return scan;
      const { presets, ...meta } = scan as PresetScan;
      return { ...meta, ...byBank(scan) };
    }
    case 'load': {
      if (!args[0]) fail(1, 'usage: dx load <bank-voice>, e.g. dx load 1-4');
      return api('POST', `/api/presets/${encodeURIComponent(args[0])}/load`);
    }
    case 'play': {
      const velocity = option(args, '--vel');
      const duration = option(args, '--dur');
      return api('POST', '/api/audition', { what: args[0], velocity, duration });
    }
    case 'thru': {
      if (!args.length) return api('GET', '/api/thru');
      const port = args.join(' ');
      return api('PUT', '/api/thru', { port: port === 'off' ? null : port });
    }
    case 'patches': return api('GET', '/api/patches');
    case 'save': return args[0] ? api('POST', '/api/patches', { name: args[0] }) : fail(1, 'usage: dx save <name>');
    case 'open': return args[0] ? api('POST', `/api/patches/${encodeURIComponent(args[0])}/load`) : fail(1, 'usage: dx open <name>');
    case 'ai': {
      if (!args.join(' ').trim()) fail(1, 'usage: dx ai "<prompt>"');
      const { jobId } = await api('POST', '/api/ai/generate', { prompt: args.join(' ') });
      process.once('SIGINT', () => void api('POST', '/api/ai/cancel').finally(() => process.exit(130)));
      for (;;) { // the server bounds a job at 90 s, so this always ends
        await new Promise((resolve) => setTimeout(resolve, 500));
        const job: AiJob = await api('GET', '/api/ai');
        if (job.jobId !== jobId || job.state === 'designing' || job.state === 'writing') continue;
        if (job.state !== 'done') fail(1, `AI ${job.state}${job.error ? `: ${job.error.kind} · ${job.error.message}` : ''}`);
        return { ...job.result, usage: job.usage, seconds: Math.round((Date.now() - Date.parse(job.startedAt)) / 100) / 10 };
      }
    }
    default:
      console.log(USAGE);
      process.exit(cmd && cmd !== 'help' ? 1 : 0);
  }
}

console.log(JSON.stringify(await main(process.argv.slice(2))));
