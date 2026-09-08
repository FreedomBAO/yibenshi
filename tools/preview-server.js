// Loopback-only frontend preview. AI requests go to the existing deployment;
// no production credentials, admin routes, or arbitrary proxy targets are exposed.
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const ROOT = path.resolve(__dirname, '..');
const AI_URL = 'https://dailybooks-three.vercel.app/api/companion';
const PUBLIC_FILES = new Set(['index.html', 'library.html', 'landing.css', 'landing.js', 'library.css', 'style.css', 'main.js', 'data.json', 'admin.html', 'admin.js', 'admin.css']);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.pdf': 'application/pdf', '.mp3': 'audio/mpeg' };
function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function createPreviewServer(fetchAI = fetch) {
  return http.createServer(async (req, res) => {
    try {
      const expectedHosts = [`127.0.0.1:${req.socket.localPort}`, `localhost:${req.socket.localPort}`];
      if (!expectedHosts.includes(req.headers.host)) return json(res, 403, { error: '只允许本机预览' });
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (url.pathname === '/api/companion') {
        if (req.method !== 'POST') return json(res, 405, { code: 'METHOD_NOT_ALLOWED', error: '仅支持 POST 请求' });
        if (req.headers.origin && req.headers.origin !== url.origin) return json(res, 403, { error: '不允许跨站请求' });
        if (!String(req.headers['content-type']).startsWith('application/json')) return json(res, 415, { error: '需要 JSON 请求' });
        let size = 0;
        const chunks = [];
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 32 * 1024) return json(res, 413, { error: '请求内容过大' });
          chunks.push(chunk);
        }
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { return json(res, 400, { error: '请求内容不是有效 JSON' }); }
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 90000);
        const cancel = () => controller.abort();
        res.on('close', cancel);
        try {
          const upstream = await fetchAI(AI_URL, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ bookId: body.bookId, question: body.question, history: body.history }),
            signal: controller.signal,
          });
          res.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') || 'application/json', 'Cache-Control': 'no-cache, no-transform' });
          if (upstream.body) await pipeline(Readable.fromWeb(upstream.body), res);
          else res.end();
        } finally {
          clearTimeout(timeout);
          res.off('close', cancel);
        }
        return;
      }
      if (!['GET', 'HEAD'].includes(req.method)) return json(res, 405, { error: '不支持的方法' });
      const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
      const extension = path.extname(relative).toLowerCase();
      if (!PUBLIC_FILES.has(relative) && !(relative.startsWith('assets/') && TYPES[extension] && !['.js', '.html', '.json'].includes(extension))) return json(res, 404, { error: '文件不存在' });
      const file = await fs.promises.realpath(path.join(ROOT, relative));
      const resolvedRelative = path.relative(ROOT, file).split(path.sep).join('/');
      if (resolvedRelative !== relative) return json(res, 403, { error: '路径不可访问' });
      const stat = await fs.promises.stat(file);
      if (!stat.isFile()) return json(res, 404, { error: '文件不存在' });
      res.writeHead(200, { 'Content-Type': TYPES[extension] || 'application/octet-stream', 'Content-Length': stat.size, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
      if (req.method === 'HEAD') return res.end();
      await pipeline(fs.createReadStream(file), res);
    } catch (error) {
      if (res.destroyed) return;
      if (res.headersSent) return res.destroy();
      json(res, error.code === 'ENOENT' ? 404 : 502, { error: error.code === 'ENOENT' ? '文件不存在' : '本地预览暂时无法连接服务，请检查网络后重试。' });
    }
  });
}

if (require.main === module) {
  const port = Number(process.env.PREVIEW_PORT || 8765);
  const server = createPreviewServer();
  server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? `端口 ${port} 已占用，请先关闭旧的静态预览服务。` : error.message); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`官网预览：http://127.0.0.1:${port}/\nAI 伴读连接已有线上服务；不会读取或暴露 API 密钥。`));
}
module.exports = { createPreviewServer };
