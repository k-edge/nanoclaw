/**
 * HTTP Dashboard Server for NanoClaw
 * Provides REST API for task submission, agent monitoring, and a web dashboard.
 * Also serves as the communication layer for the web UI via SSE.
 */
import { createServer, IncomingMessage, ServerResponse, Server } from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { logger } from '../logger.js';

export interface DashboardDeps {
  getAllAgentTasks: () => unknown[];
  getAgentTaskById: (id: string) => unknown | undefined;
  getAllAgents: () => unknown[];
  getAgentById: (id: string) => unknown | undefined;
  getAgentRatings: (agentId: string) => unknown[];
  getConversations: () => unknown[];
  getDashboardStats: () => unknown;
  submitTask: (prompt: string) => Promise<{ taskId: string }>;
}

type SseClient = { res: ServerResponse; id: number };

let sseClients: SseClient[] = [];
let nextSseId = 1;

export function broadcastEvent(event: string, data: unknown): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try {
      client.res.write(payload);
    } catch {
      /* client disconnected */
    }
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function json(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(data));
}

function cors(res: ServerResponse): void {
  res.writeHead(204, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end();
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = path.join(__dirname, '..', '..', 'src', 'dashboard', 'static');

function serveStatic(res: ServerResponse, urlPath: string): void {
  const safePath = urlPath === '/' ? '/index.html' : urlPath;
  const filePath = path.join(STATIC_DIR, safePath);

  const normalized = path.normalize(filePath);
  if (!normalized.startsWith(STATIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  if (!fs.existsSync(filePath)) {
    res.writeHead(404);
    res.end('Not Found');
    return;
  }

  const ext = path.extname(filePath);
  const mimeTypes: Record<string, string> = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
  };

  res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'text/plain' });
  fs.createReadStream(filePath).pipe(res);
}

export function startDashboardServer(
  port: number,
  deps: DashboardDeps,
): Server {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://localhost:${port}`);
    const method = req.method || 'GET';
    const pathname = url.pathname;

    if (method === 'OPTIONS') {
      cors(res);
      return;
    }

    try {
      // --- REST API ---
      if (pathname === '/api/tasks' && method === 'GET') {
        json(res, deps.getAllAgentTasks());
        return;
      }

      if (pathname === '/api/tasks' && method === 'POST') {
        const body = JSON.parse(await readBody(req));
        const result = await deps.submitTask(body.prompt);
        json(res, result, 201);
        return;
      }

      if (pathname.startsWith('/api/tasks/') && method === 'GET') {
        const id = pathname.slice('/api/tasks/'.length);
        const task = deps.getAgentTaskById(id);
        if (!task) {
          json(res, { error: 'Task not found' }, 404);
          return;
        }
        json(res, task);
        return;
      }

      if (pathname === '/api/agents' && method === 'GET') {
        json(res, deps.getAllAgents());
        return;
      }

      if (
        pathname.startsWith('/api/agents/') &&
        pathname.endsWith('/ratings') &&
        method === 'GET'
      ) {
        const id = pathname.slice('/api/agents/'.length, -'/ratings'.length);
        json(res, deps.getAgentRatings(id));
        return;
      }

      if (pathname.startsWith('/api/agents/') && method === 'GET') {
        const id = pathname.slice('/api/agents/'.length);
        const agent = deps.getAgentById(id);
        if (!agent) {
          json(res, { error: 'Agent not found' }, 404);
          return;
        }
        json(res, agent);
        return;
      }

      if (pathname === '/api/conversations' && method === 'GET') {
        json(res, deps.getConversations());
        return;
      }

      if (pathname === '/api/dashboard/stats' && method === 'GET') {
        json(res, deps.getDashboardStats());
        return;
      }

      // --- SSE ---
      if (pathname === '/api/events' && method === 'GET') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'Access-Control-Allow-Origin': '*',
        });

        const client: SseClient = { res, id: nextSseId++ };
        sseClients.push(client);
        res.write(`event: connected\ndata: ${JSON.stringify({ id: client.id })}\n\n`);

        req.on('close', () => {
          sseClients = sseClients.filter((c) => c.id !== client.id);
        });
        return;
      }

      // --- Static files (dashboard) ---
      if (!pathname.startsWith('/api/')) {
        serveStatic(res, pathname);
        return;
      }

      json(res, { error: 'Not Found' }, 404);
    } catch (err) {
      logger.error({ err, path: pathname }, 'Dashboard request error');
      json(res, { error: 'Internal Server Error' }, 500);
    }
  });

  server.listen(port, () => {
    logger.info({ port }, 'Dashboard server started');
  });

  return server;
}
