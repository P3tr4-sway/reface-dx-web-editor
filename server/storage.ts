// Files under data/: preset-scan backups (.syx + presets.json), the local patch library (values JSON) and settings.json.
import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { buildVoiceDump, parseVoiceDump, splitSysex } from '../shared/codec.ts';
import { ParamError, type VoiceData, type VoiceValues } from '../shared/params.ts';
import type { PatchFile, PatchInfo, PresetScan } from '../shared/protocol.ts';

const syx = (voice: VoiceData) => Buffer.from(buildVoiceDump(voice).flat());
const safe = (name: string) => name.replace(/[^A-Za-z0-9._-]+/g, '_') || 'unnamed';

/** Writes data/backups/<timestamp>/{1-1_Name.syx ×32, all.syx, presets.json}; returns the directory. */
export function saveBackup(dataDir: string, scan: Omit<PresetScan, 'backupDir'>, voices: VoiceData[]): string {
  const dir = join(dataDir, 'backups', scan.scannedAt.replace(/[:.]/g, '-'));
  mkdirSync(dir, { recursive: true });
  scan.presets.forEach((p) => writeFileSync(join(dir, `${p.label}_${safe(p.name)}.syx`), syx(voices[p.slot])));
  writeFileSync(join(dir, 'all.syx'), Buffer.concat(voices.map(syx)));
  writeFileSync(join(dir, 'presets.json'), JSON.stringify({ ...scan, backupDir: dir }, null, 2));
  return dir;
}

/** The most recent backup, used to warm the stored-voice cache at startup (so `dirty` works before a scan). */
export function loadLatestScan(dataDir: string): { scan: PresetScan; voices: VoiceData[] } | null {
  const root = join(dataDir, 'backups');
  if (!existsSync(root)) return null;
  for (const name of readdirSync(root).sort().reverse()) {
    const dir = join(root, name);
    if (!existsSync(join(dir, 'presets.json')) || !existsSync(join(dir, 'all.syx'))) continue;
    const msgs = splitSysex(readFileSync(join(dir, 'all.syx')));
    const voices = Array.from({ length: msgs.length / 7 }, (_, i) => parseVoiceDump(msgs.slice(i * 7, i * 7 + 7)));
    return { scan: JSON.parse(readFileSync(join(dir, 'presets.json'), 'utf8')), voices };
  }
  return null;
}

function patchPath(dataDir: string, name: string): string {
  if (!/^[A-Za-z0-9][\w .-]{0,63}$/.test(name)) {
    throw new ParamError(`bad patch name "${name}": 1-64 chars of letters, digits, space, _ . -`);
  }
  return join(dataDir, 'patches', `${name}.json`);
}

export function listPatches(dataDir: string): PatchInfo[] {
  const dir = join(dataDir, 'patches');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => {
    const p: PatchFile = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    return { name: p.name, voiceName: String(p.values.name ?? ''), savedAt: p.savedAt };
  });
}

export function savePatch(dataDir: string, name: string, values: VoiceValues): string {
  const path = patchPath(dataDir, name);
  mkdirSync(join(dataDir, 'patches'), { recursive: true });
  const file: PatchFile = { name, savedAt: new Date().toISOString(), values };
  writeFileSync(path, JSON.stringify(file, null, 2));
  return path;
}

export function readPatch(dataDir: string, name: string): PatchFile | null {
  const path = patchPath(dataDir, name);
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}

/** data/settings.json: server choices that survive a restart. */
export interface Settings {
  /** MIDI thru input port, null = off. */
  thruPort: string | null;
}

const settingsPath = (dataDir: string) => join(dataDir, 'settings.json');

/** Defaults when the file is missing; an unreadable file is reported and ignored rather than stopping the server. */
export function readSettings(dataDir: string): Settings {
  const path = settingsPath(dataDir);
  if (!existsSync(path)) return { thruPort: null };
  try {
    const saved = JSON.parse(readFileSync(path, 'utf8'));
    return { thruPort: typeof saved?.thruPort === 'string' ? saved.thruPort : null };
  } catch (err) {
    console.warn(`[settings] ignoring ${path}: ${(err as Error).message}`);
    return { thruPort: null };
  }
}

export function saveSettings(dataDir: string, settings: Settings): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(settingsPath(dataDir), JSON.stringify(settings, null, 2));
}
