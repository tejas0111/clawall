import 'dotenv/config';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DASHBOARD_DIR = path.resolve(__dirname, '../local/dashboard');

const DASHBOARD_PORT = Number(process.env.CLAWALL_DASHBOARD_PORT || 3020);
const DASHBOARD_HOST = String(process.env.CLAWALL_DASHBOARD_HOST || '127.0.0.1');
const GATEWAY_BASE = String(process.env.CLAWALL_DASHBOARD_GATEWAY || 'http://127.0.0.1:3011').replace(/\/$/, '');
const PLUGIN_KEY = String(process.env.CLAWALL_PLUGIN_KEY || process.env.OPENCLAW_PLUGIN_KEY || '').trim();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.vtt': 'text/vtt; charset=utf-8',
  '.mmd': 'text/plain; charset=utf-8',
  '.mp4': 'video/mp4',
};

function send(res, code, body, type = 'text/plain; charset=utf-8') {
  const data = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  res.writeHead(code, {
    'content-type': type,
    'content-length': data.length,
    'cache-control': 'no-store',
  });
  res.end(data);
}

function sanitizePath(urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0]);
  const isDashboardAlias = clean === '/' || clean === '/dashboard' || clean === '/dashboard/' || clean === '/index.html';
  const rel = isDashboardAlias ? '/dashboard.html' : clean;
  const full = path.resolve(DASHBOARD_DIR, `.${rel}`);
  if (!full.startsWith(DASHBOARD_DIR)) return null;
  return full;
}

async function proxyApi(req, res) {
  const upstreamPath = req.url.replace(/^\/api/, '') || '/';
  const upstreamUrl = `${GATEWAY_BASE}${upstreamPath}`;
  const headers = { accept: 'application/json', 'x-clawall-source': 'dashboard-local' };
  if (PLUGIN_KEY) headers['x-clawall-plugin-key'] = PLUGIN_KEY;
  const method = String(req.method || 'GET').toUpperCase();

  try {
    let body;
    if (!['GET', 'HEAD'].includes(method)) {
      body = await new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
      });
      if (String(req.headers['content-type'] || '').trim()) {
        headers['content-type'] = String(req.headers['content-type']).trim();
      }
    }

    const upstream = await fetch(upstreamUrl, { method, headers, body });
    const text = await upstream.text();
    res.writeHead(upstream.status, {
      'content-type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(text);
  } catch (err) {
    send(res, 502, JSON.stringify({ ok: false, error: `proxy_error: ${err.message}` }, null, 2), MIME['.json']);
  }
}

const server = http.createServer(async (req, res) => {
  const reqUrl = req.url || '/';

  if (reqUrl.startsWith('/api/')) {
    await proxyApi(req, res);
    return;
  }

  const fullPath = sanitizePath(reqUrl);
  if (!fullPath) {
    send(res, 400, 'bad path');
    return;
  }

  try {
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      send(res, 403, 'forbidden');
      return;
    }
    const ext = path.extname(fullPath).toLowerCase();
    const body = fs.readFileSync(fullPath);
    send(res, 200, body, MIME[ext] || 'application/octet-stream');
  } catch {
    // Browser path fallback for legacy/typed dashboard URLs.
    if ((req.method || 'GET') === 'GET' && !path.extname(decodeURIComponent(reqUrl.split('?')[0] || ''))) {
      try {
        const dashboardFile = path.resolve(DASHBOARD_DIR, './dashboard.html');
        const body = fs.readFileSync(dashboardFile);
        send(res, 200, body, MIME['.html']);
        return;
      } catch {
        // fall through to 404 below
      }
    }
    send(res, 404, 'dashboard not found. open /dashboard.html');
  }
});

server.listen(DASHBOARD_PORT, DASHBOARD_HOST, () => {
  console.log(`[dashboard-local] serving http://${DASHBOARD_HOST}:${DASHBOARD_PORT}/dashboard.html`);
  console.log(`[dashboard-local] proxy /api/* -> ${GATEWAY_BASE} (plugin_key=${PLUGIN_KEY ? 'set' : 'missing'})`);
  console.log(`[dashboard-local] static root: ${DASHBOARD_DIR}`);
});
