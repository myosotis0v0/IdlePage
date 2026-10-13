import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { QidianAccessProbe } from '../../application/QidianAccessProbe';

interface BridgeOptions {
  port: number;
  token: string;
  origin: string;
  probe: QidianAccessProbe;
  onChanged?: () => void;
  onRejected?: (reason: 'HostMismatch' | 'OriginMissing' | 'OriginMismatch' | 'Unauthorized', method: string) => void;
}
export class LocalBridgeServer {
  private server?: Server;
  private actualPort = 0;
  constructor(private readonly options: BridgeOptions) {
    if (!/^[a-f0-9]{64}$/.test(options.token) || !/^chrome-extension:\/\/[a-p]{32}$/.test(options.origin)) throw new Error('InvalidBridgeConfiguration');
  }
  async start(): Promise<void> {
    if (this.server) throw new Error('BridgeAlreadyStarted');
    const server = createServer((req, res) => { void this.handle(req, res).catch(() => {
      if (!res.headersSent) this.reply(res, 500, { error: 'InternalError' }); else res.destroy();
    }); });
    server.requestTimeout = 10000;
    server.headersTimeout = 10000;
    server.maxHeadersCount = 32;
    server.maxConnections = 16;
    this.server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(this.options.port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('InvalidBridgeAddress');
      this.actualPort = address.port;
    } catch (error) { this.server = undefined; throw error; }
  }
  endpoint(): string { return `http://127.0.0.1:${this.actualPort}`; }
  async close(): Promise<void> {
    const server = this.server; this.server = undefined;
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
  }
  private reply(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  }
  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.headers.host !== `127.0.0.1:${this.actualPort}` || req.headers.origin !== this.options.origin) {
      const reason = req.headers.host !== `127.0.0.1:${this.actualPort}` ? 'HostMismatch' :
        req.headers.origin === undefined ? 'OriginMissing' : 'OriginMismatch';
      this.options.onRejected?.(reason, ['GET', 'POST', 'OPTIONS'].includes(req.method ?? '') ? req.method! : 'other');
      this.reply(res, 403, { error: 'ForbiddenOrigin' }); return;
    }
    res.setHeader('Access-Control-Allow-Origin', this.options.origin);
    res.setHeader('Vary', 'Origin');
    if (req.method === 'OPTIONS') {
      const headers = String(req.headers['access-control-request-headers'] ?? '').toLowerCase().split(',').map(h => h.trim()).filter(Boolean);
      if (!['GET', 'POST'].includes(String(req.headers['access-control-request-method'])) || headers.some(h => !['authorization', 'content-type'].includes(h))) {
        this.reply(res, 403, { error: 'ForbiddenPreflight' }); return;
      }
      res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Authorization, Content-Type' });
      res.end(); return;
    }
    const actual = Buffer.from(req.headers.authorization ?? '');
    const expected = Buffer.from(`Bearer ${this.options.token}`);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      this.options.onRejected?.('Unauthorized', ['GET', 'POST', 'OPTIONS'].includes(req.method ?? '') ? req.method! : 'other');
      this.reply(res, 401, { error: 'Unauthorized' }); return;
    }
    if (req.method === 'GET' && req.url === '/v1/tasks/next') {
      const task = this.options.probe.nextTask(); this.options.onChanged?.();
      this.reply(res, 200, { task, ...this.options.probe.snapshot() }); return;
    }
    if (req.method === 'GET' && req.url === '/v1/status') {
      this.reply(res, 200, this.options.probe.snapshot()); return;
    }
    if (req.method !== 'POST' || !['/v1/tasks/result', '/v1/tasks/next', '/v1/bookshelf/result', '/v1/catalog/result'].includes(req.url ?? '')) {
      this.reply(res, 404, { error: 'UnknownRoute' }); return;
    }
    if ((req.headers['content-type'] ?? '').split(';')[0].trim() !== 'application/json') {
      this.reply(res, 415, { error: 'ExpectedJson' }); return;
    }
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 16384) { this.reply(res, 413, { error: 'PayloadTooLarge' }); return; }
      chunks.push(Buffer.from(chunk));
    }
    let input: { taskId?: unknown; report?: unknown };
    try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { this.reply(res, 400, { error: 'InvalidJson' }); return; }
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['taskId', 'report'].includes(key))) {
      this.reply(res, 400, { error: 'InvalidPayload' }); return;
    }
    if (req.url === '/v1/tasks/next') {
      if (Object.keys(input).length) { this.reply(res, 400, { error: 'ExpectedEmptyPayload' }); return; }
      const task = this.options.probe.nextTask(); this.options.onChanged?.();
      this.reply(res, 200, { task, ...this.options.probe.snapshot() }); return;
    }
    const result = req.url === '/v1/catalog/result' ? this.options.probe.acceptCatalog(input.taskId, input.report) : req.url === '/v1/bookshelf/result' ? this.options.probe.acceptBookshelf(input.taskId, input.report) : this.options.probe.accept(input.taskId, input.report);
    if (result !== 'accepted') {
      this.reply(res, result === 'stale' ? 409 : 400, { error: result === 'stale' ? 'StaleTask' : 'InvalidObservation' }); return;
    }
    this.options.onChanged?.();
    this.reply(res, 200, { accepted: true, ...this.options.probe.snapshot() });
  }
}
