// HTTP API (CLI / AI mode), WebSocket /ws (web panel) and static serving of web/dist.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { PARAMS, ParamError } from '../shared/params.ts';
import type { ClientMessage, ServerMessage } from '../shared/protocol.ts';
import { ApiError, type Editor } from './editor.ts';

type Handler = (match: RegExpMatchArray, body: any, url: URL) => unknown;

function routes(editor: Editor): [string, RegExp, Handler][] {
  return [
    ['GET', /^\/api\/status$/, () => editor.status()],
    ['GET', /^\/api\/voice$/, (_m, _b, url) => editor.voice(url.searchParams.has('raw'))],
    ['PATCH', /^\/api\/voice$/, (_m, body) => editor.set(objectBody(body), 'api')],
    ['PUT', /^\/api\/voice$/, (_m, body) => editor.put(objectBody(body.values ?? body))],
    ['POST', /^\/api\/voice\/refresh$/, () => editor.refresh()],
    ['POST', /^\/api\/undo$/, () => editor.undo()],
    ['POST', /^\/api\/redo$/, () => editor.undo(true)],
    ['GET', /^\/api\/params$/, () => PARAMS],
    ['GET', /^\/api\/presets$/, () => editor.presets ?? { presets: null, hint: 'no scan yet: POST /api/presets/scan' }],
    ['POST', /^\/api\/presets\/scan$/, () => editor.scanPresets()],
    ['POST', /^\/api\/presets\/([^/]+)\/load$/, (m) => editor.loadPreset(decodeURIComponent(m[1]))],
    ['POST', /^\/api\/audition$/, (_m, body) => editor.audition(body ?? {})],
    ['GET', /^\/api\/thru$/, () => editor.status().thru],
    ['PUT', /^\/api\/thru$/, (_m, body) => editor.setThru(body?.port)],
    ['GET', /^\/api\/patches$/, () => editor.patches()],
    ['POST', /^\/api\/patches$/, (_m, body) => editor.savePatch(String(body?.name ?? ''))],
    ['POST', /^\/api\/patches\/([^/]+)\/load$/, (m) => editor.loadPatch(decodeURIComponent(m[1]))],
    ['GET', /^\/api\/ai$/, () => editor.aiJob],
    ['POST', /^\/api\/ai\/generate$/, (_m, body) => editor.generate(body?.prompt)],
    ['POST', /^\/api\/ai\/cancel$/, () => editor.cancelGenerate()],
  ];
}

function objectBody(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError(400, 'body must be a JSON object {id: value}');
  return body as Record<string, unknown>;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let text = '';
  for await (const chunk of req) text += chunk;
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(400, 'body is not valid JSON');
  }
}

function send(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
}

const MIME: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json',
  '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

function serveStatic(res: ServerResponse, dir: string, pathname: string): void {
  let file = normalize(join(dir, decodeURIComponent(pathname)));
  if (!file.startsWith(dir + sep) || !existsSync(file) || statSync(file).isDirectory()) file = join(dir, 'index.html'); // SPA fallback
  if (!existsSync(file)) return send(res, 404, { error: 'web UI not built (web/dist missing); API is under /api' });
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
}

export function createHttpServer(editor: Editor, staticDir: string): Server {
  const table = routes(editor);
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (!url.pathname.startsWith('/api/')) return serveStatic(res, staticDir, url.pathname);
      const pathMatches = table.filter(([, re]) => re.test(url.pathname));
      const route = pathMatches.find(([method]) => method === req.method);
      if (!route) {
        return send(res, pathMatches.length ? 405 : 404, { error: pathMatches.length
          ? `${req.method} not allowed; use ${pathMatches.map(([m]) => m).join('/')}` : `no route ${url.pathname}` });
      }
      const body = await readJson(req);
      send(res, 200, await route[2](url.pathname.match(route[1])!, body, url));
    } catch (err) {
      const status = err instanceof ApiError ? err.status : err instanceof ParamError || err instanceof URIError ? 400 : 500;
      if (status === 500) console.error(err);
      send(res, status, { error: (err as Error).message });
    }
  });

  const wss = new WebSocketServer({ server, path: '/ws' });
  const broadcast = (msg: ServerMessage) => {
    const text = JSON.stringify(msg);
    for (const client of wss.clients) if (client.readyState === WebSocket.OPEN) client.send(text);
  };
  editor.on('message', broadcast);
  wss.on('connection', (ws) => {
    const held = new Set<number>(); // keys this client holds; released if the tab closes mid-note
    ws.send(JSON.stringify(editor.snapshot()));
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(String(data)) as ClientMessage;
        if (msg.type === 'set') editor.set(objectBody(msg.values), 'ui', true);
        else if (msg.type === 'audition') editor.audition(msg.request ?? {});
        else if (msg.type === 'note') {
          editor.note(msg.on, msg.note, msg.velocity);
          if (msg.on) held.add(msg.note);
          else held.delete(msg.note);
        } else if (msg.type === 'thru') editor.setThru(msg.port);
        else throw new ApiError(400, `unknown message type ${(msg as { type: unknown }).type}`);
      } catch (err) {
        ws.send(JSON.stringify({ type: 'error', message: (err as Error).message } satisfies ServerMessage));
      }
    });
    ws.on('close', () => { for (const note of held) editor.note(false, note); });
  });
  return server;
}
