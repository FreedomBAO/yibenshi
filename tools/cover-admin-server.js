'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const HOST = '127.0.0.1';
const PORT = Number(process.env.COVER_ADMIN_PORT || 8765);
const ADMIN_URL = 'http://' + HOST + ':' + PORT + '/admin.html';
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_PDF_ZIP_BYTES = 100 * 1024 * 1024;
const MAX_PDF_BYTES = 20 * 1024 * 1024;
const CANDIDATE_TTL = 30 * 60 * 1000;
const PDF_ARCHIVE_TTL = 2 * 60 * 60 * 1000;
const candidates = new Map();
const pdfArchives = new Map();
const pdfFiles = new Map();

function openAdminPage() {
  if (process.platform === 'win32' && process.env.COVER_ADMIN_NO_OPEN !== '1' && !process.argv.includes('--no-open')) {
    execFile('rundll32', ['url.dll,FileProtocolHandler', ADMIN_URL], () => {});
  }
}

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/123.0 Safari/537.36',
];

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
};

function sendJson(res, status, body) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': data.length,
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

function requestHeaders(referer) {
  return {
    'User-Agent': USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)],
    'Accept': 'text/html,application/xhtml+xml,application/json,image/avif,image/webp,image/*,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.7',
    'Referer': referer || 'https://book.douban.com/',
  };
}

async function fetchWithTimeout(url, options = {}) {
  const { timeout = 20000, ...fetchOptions } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, { ...fetchOptions, signal: controller.signal, redirect: 'follow' });
  } finally {
    clearTimeout(timer);
  }
}

function normalizeText(value) {
  return String(value || '').toLowerCase().replace(/[\s·•，,。:：;；()（）\[\]【】《》]/g, '');
}

function scoreDoubanItem(item, title, author) {
  const wantedTitle = normalizeText(title);
  const foundTitle = normalizeText(item.title);
  const wantedAuthor = normalizeText(author);
  const foundAuthor = normalizeText(item.author_name);
  let score = 0;
  if (foundTitle === wantedTitle) score += 100;
  else if (foundTitle.includes(wantedTitle) || wantedTitle.includes(foundTitle)) score += 50;
  if (wantedAuthor && foundAuthor.includes(wantedAuthor.split('/')[0])) score += 30;
  if (item.year) score += 1;
  return score;
}

function upgradeDoubanCover(url) {
  return String(url || '').replace('/s/public/', '/l/public/').replace('/m/public/', '/l/public/');
}

async function searchDouban(title, author) {
  const query = new URL('https://book.douban.com/j/subject_suggest');
  query.searchParams.set('q', title);
  const response = await fetchWithTimeout(query, {
    headers: requestHeaders('https://book.douban.com/'),
    timeout: 10000,
  });
  if (!response.ok) throw new Error('豆瓣搜索返回 HTTP ' + response.status);
  const items = await response.json();
  if (!Array.isArray(items)) return [];
  return items
    .filter((item) => item && item.pic)
    .map((item) => ({
      title: item.title || title,
      author: item.author_name || author || '',
      year: item.year || '',
      source: '豆瓣读书',
      url: upgradeDoubanCover(item.pic),
      fallbackUrl: item.pic,
      score: scoreDoubanItem(item, title, author),
    }))
    .sort((a, b) => b.score - a.score);
}

async function searchGoogleBooks(title, author, originalTitle) {
  const query = new URL('https://www.googleapis.com/books/v1/volumes');
  const terms = [];
  if (title) terms.push('intitle:' + title);
  if (author) terms.push('inauthor:' + author.split('/')[0].trim());
  if (originalTitle && normalizeText(originalTitle) !== normalizeText(title)) {
    terms.push(originalTitle);
  }
  query.searchParams.set('q', terms.join(' '));
  query.searchParams.set('maxResults', '20');
  query.searchParams.set('printType', 'books');
  const response = await fetchWithTimeout(query, {
    headers: requestHeaders('https://books.google.com/'),
    timeout: 10000,
  });
  if (!response.ok) throw new Error('Google Books 返回 HTTP ' + response.status);
  const data = await response.json();
  return (data.items || []).map((item) => item.volumeInfo || {}).filter((info) =>
    info.imageLinks && (info.imageLinks.large || info.imageLinks.medium || info.imageLinks.thumbnail)
  ).map((info) => ({
    title: info.title || title,
    author: (info.authors || []).join(' / ') || author || '',
    year: String(info.publishedDate || '').slice(0, 4),
    source: 'Google Books',
    url: String(info.imageLinks.large || info.imageLinks.medium || info.imageLinks.thumbnail)
      .replace(/^http:/, 'https:')
      .replace('&zoom=1', '&zoom=2'),
    score: scoreDoubanItem({ title: info.title, author_name: (info.authors || []).join(' '), year: info.publishedDate }, title, author),
  })).sort((a, b) => b.score - a.score);
}

async function searchOpenLibrary(title, author) {
  const query = new URL('https://openlibrary.org/search.json');
  query.searchParams.set('title', title);
  if (author) query.searchParams.set('author', author.split('/')[0].trim());
  query.searchParams.set('limit', '20');
  query.searchParams.set('fields', 'title,author_name,first_publish_year,cover_i');
  const response = await fetchWithTimeout(query, {
    headers: requestHeaders('https://openlibrary.org/'),
    timeout: 10000,
  });
  if (!response.ok) throw new Error('Open Library 返回 HTTP ' + response.status);
  const data = await response.json();
  return (data.docs || []).filter((item) => item.cover_i).map((item) => ({
    title: item.title || title,
    author: (item.author_name || []).join(' / ') || author || '',
    year: item.first_publish_year || '',
    source: 'Open Library',
    url: 'https://covers.openlibrary.org/b/id/' + item.cover_i + '-L.jpg',
    score: scoreDoubanItem({ title: item.title, author_name: (item.author_name || []).join(' '), year: item.first_publish_year }, title, author),
  })).sort((a, b) => b.score - a.score);
}

function decodeEscapedUrl(value) {
  return value
    .replace(/\\\//g, '/')
    .replace(/\\u002F/gi, '/')
    .replace(/\\u003A/gi, ':')
    .replace(/&amp;/g, '&');
}

async function searchBaidu(title, author) {
  const query = new URL('https://image.baidu.com/search/index');
  query.searchParams.set('tn', 'baiduimage');
  query.searchParams.set('word', [title, author, '书籍 封面'].filter(Boolean).join(' '));
  const response = await fetchWithTimeout(query, {
    headers: requestHeaders('https://image.baidu.com/'),
    timeout: 8000,
  });
  if (!response.ok) return [];
  const html = await response.text();
  const urls = [];
  const patterns = [
    /"(?:objURL|firstURL|hoverURL|oriURL)"\s*:\s*"([^"]+)"/g,
    /(?:data-src|data-original|data-thumburl)=["'](https?:\/\/[^"']+)["']/g,
  ];
  for (const pattern of patterns) {
    for (const match of html.matchAll(pattern)) {
      const imageUrl = decodeEscapedUrl(match[1]);
      if (imageUrl.startsWith('http') && !urls.includes(imageUrl)) urls.push(imageUrl);
      if (urls.length >= 12) break;
    }
    if (urls.length >= 12) break;
  }
  return urls.map((url) => ({
    title,
    author,
    year: '',
    source: '百度图片',
    url,
    score: 0,
  }));
}

function isPrivateHost(hostname) {
  const host = hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local')) return true;
  const family = net.isIP(host);
  if (!family) return false;
  if (family === 6) return host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:');
  const octets = host.split('.').map(Number);
  return octets[0] === 10 || octets[0] === 127 ||
    (octets[0] === 169 && octets[1] === 254) ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168);
}

function isSafeRemoteUrl(value) {
  try {
    const parsed = new URL(value);
    return ['http:', 'https:'].includes(parsed.protocol) && !isPrivateHost(parsed.hostname);
  } catch {
    return false;
  }
}

function rememberCandidates(items) {
  const now = Date.now();
  for (const [id, item] of candidates) {
    if (now - item.createdAt > CANDIDATE_TTL) candidates.delete(id);
  }
  return items.filter((item) => isSafeRemoteUrl(item.url)).map((item) => {
    const id = randomUUID();
    candidates.set(id, { ...item, createdAt: now });
    return {
      id,
      title: item.title,
      author: item.author,
      year: item.year,
      source: item.source,
      previewUrl: '/api/covers/image?id=' + encodeURIComponent(id),
    };
  });
}

function imageVariants(candidate) {
  const urls = [candidate.url];
  try {
    const parsed = new URL(candidate.url);
    if (/^img\d+\.doubanio\.com$/i.test(parsed.hostname)) {
      for (let i = 1; i <= 9; i += 1) {
        const copy = new URL(parsed);
        copy.hostname = 'img' + i + '.doubanio.com';
        urls.push(copy.toString());
      }
    }
  } catch {}
  if (candidate.fallbackUrl) urls.push(candidate.fallbackUrl);
  return [...new Set(urls)];
}

function detectImage(buffer, contentType) {
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: 'image/png', ext: 'png' };
  if (buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
  if (buffer.subarray(0, 4).toString() === 'GIF8') return { mime: 'image/gif', ext: 'gif' };
  if (String(contentType).startsWith('image/')) {
    const mime = String(contentType).split(';')[0];
    return { mime, ext: mime.split('/')[1].replace('jpeg', 'jpg') };
  }
  return null;
}

async function downloadCandidate(candidate) {
  let lastError = new Error('无法下载封面');
  for (const url of imageVariants(candidate)) {
    try {
      const response = await fetchWithTimeout(url, {
        headers: requestHeaders(
          candidate.source === '豆瓣读书' ? 'https://book.douban.com/' :
          candidate.source === 'Google Books' ? 'https://books.google.com/' :
          candidate.source === 'Open Library' ? 'https://openlibrary.org/' :
          'https://image.baidu.com/'
        ),
        timeout: 30000,
      });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length < 2048) throw new Error('图片过小');
      if (buffer.length > MAX_IMAGE_BYTES) throw new Error('图片超过 5MB');
      const image = detectImage(buffer, response.headers.get('content-type'));
      if (!image) throw new Error('响应不是图片');
      return { buffer, ...image };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error('请求内容过大');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

async function readBinaryBody(req, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('ZIP 文件超过 100MB，请拆分后重试');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function runFile(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { windowsHide: true, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        error.message = (stderr || error.message || '').trim();
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

function isSafeArchiveEntry(entry) {
  const portable = String(entry || '').replace(/\\/g, '/');
  if (!portable || portable.startsWith('/') || /^[a-zA-Z]:/.test(portable)) return false;
  return !portable.split('/').some((part) => part === '..');
}

function removePdfArchive(archiveId) {
  const archive = pdfArchives.get(archiveId);
  if (!archive) return;
  for (const fileId of archive.fileIds) pdfFiles.delete(fileId);
  pdfArchives.delete(archiveId);
  const tempBase = path.resolve(os.tmpdir());
  const archiveRoot = path.resolve(archive.root);
  if (archiveRoot.startsWith(tempBase + path.sep) && path.basename(archiveRoot).startsWith('yibenshi-pdf-')) {
    fs.rmSync(archiveRoot, { recursive: true, force: true });
  }
}

function cleanupPdfArchives() {
  const now = Date.now();
  for (const [archiveId, archive] of pdfArchives) {
    if (now - archive.createdAt > PDF_ARCHIVE_TTL) removePdfArchive(archiveId);
  }
}

process.on('exit', () => {
  for (const archiveId of [...pdfArchives.keys()]) removePdfArchive(archiveId);
});

function collectPdfFiles(root) {
  const result = [];
  const rootResolved = path.resolve(root);
  const walk = (folder) => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const fullPath = path.resolve(folder, entry.name);
      if (!fullPath.startsWith(rootResolved + path.sep)) continue;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.pdf') continue;
      const realPath = fs.realpathSync(fullPath);
      if (!realPath.startsWith(rootResolved + path.sep)) continue;
      const stat = fs.statSync(realPath);
      if (stat.size > 0 && stat.size <= MAX_PDF_BYTES) {
        result.push({ path: realPath, filename: entry.name, size: stat.size });
      }
    }
  };
  walk(rootResolved);
  return result;
}

async function unpackPdfArchive(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
    throw new Error('请选择有效的 ZIP 压缩包');
  }
  cleanupPdfArchives();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yibenshi-pdf-'));
  const archivePath = path.join(root, 'archive.zip');
  const extractRoot = path.join(root, 'files');
  fs.mkdirSync(extractRoot);
  try {
    fs.writeFileSync(archivePath, buffer);
    const listing = await runFile('tar', ['-tf', archivePath]);
    const entries = String(listing).split(/\r?\n/).filter(Boolean);
    if (!entries.length || entries.some((entry) => !isSafeArchiveEntry(entry))) {
      throw new Error('ZIP 中包含不安全的文件路径，已拒绝解压');
    }
    await runFile('tar', ['-xf', archivePath, '-C', extractRoot]);
    const files = collectPdfFiles(extractRoot);
    if (!files.length) throw new Error('ZIP 中没有找到可用的 PDF 文件');

    const archiveId = randomUUID();
    const fileIds = [];
    const responseFiles = files.map((file) => {
      const id = randomUUID();
      fileIds.push(id);
      pdfFiles.set(id, { ...file, archiveId });
      return { id, filename: file.filename, size: file.size };
    });
    pdfArchives.set(archiveId, { root, fileIds, createdAt: Date.now() });
    return { archiveId, files: responseFiles };
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

async function handleApi(req, res, requestUrl) {
  if (requestUrl.pathname === '/api/covers/health' && req.method === 'GET') {
    return sendJson(res, 200, { ok: true, service: 'cover-search' });
  }

  if (requestUrl.pathname === '/api/covers/search' && req.method === 'GET') {
    const title = (requestUrl.searchParams.get('title') || '').trim();
    const author = (requestUrl.searchParams.get('author') || '').trim();
    const originalTitle = (requestUrl.searchParams.get('originalTitle') || '').trim();
    const offset = Math.max(0, Number(requestUrl.searchParams.get('offset') || 0));
    if (!title) return sendJson(res, 400, { error: '请先填写书名' });
    const results = [];
    const errors = [];
    const searches = await Promise.allSettled([
      searchDouban(title, author),
      searchGoogleBooks(title, author, originalTitle),
      searchOpenLibrary(title, author),
      searchBaidu(title, author),
    ]);
    for (const result of searches) {
      if (result.status === 'fulfilled') results.push(...result.value);
      else errors.push(result.reason && result.reason.message ? result.reason.message : '搜索来源不可用');
    }
    const seen = new Set();
    const uniqueResults = results.filter((item) => {
      const key = item.url;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const page = rememberCandidates(uniqueResults.slice(offset, offset + 5));
    return sendJson(res, 200, { candidates: page, offset, hasMore: uniqueResults.length > offset + 5, errors });
  }

  if (requestUrl.pathname === '/api/covers/image' && req.method === 'GET') {
    const candidate = candidates.get(requestUrl.searchParams.get('id'));
    if (!candidate) return sendJson(res, 404, { error: '候选封面已过期，请重新搜索' });
    const image = await downloadCandidate(candidate);
    res.writeHead(200, {
      'Content-Type': image.mime,
      'Content-Length': image.buffer.length,
      'Cache-Control': 'private, max-age=300',
    });
    return res.end(image.buffer);
  }

  if (requestUrl.pathname === '/api/covers/download' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const candidate = candidates.get(body.id);
    if (!candidate) return sendJson(res, 404, { error: '候选封面已过期，请重新搜索' });
    const image = await downloadCandidate(candidate);
    return sendJson(res, 200, {
      data: image.buffer.toString('base64'),
      mime: image.mime,
      extension: image.ext,
      source: candidate.source,
    });
  }

  if (requestUrl.pathname === '/api/pdfs/archive' && req.method === 'POST') {
    const archive = await unpackPdfArchive(await readBinaryBody(req, MAX_PDF_ZIP_BYTES));
    return sendJson(res, 200, archive);
  }

  if (requestUrl.pathname === '/api/pdfs/file' && req.method === 'GET') {
    cleanupPdfArchives();
    const file = pdfFiles.get(requestUrl.searchParams.get('id'));
    if (!file || !fs.existsSync(file.path)) {
      return sendJson(res, 404, { error: 'PDF 临时文件已过期，请重新选择 ZIP' });
    }
    const stat = fs.statSync(file.path);
    res.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Length': stat.size,
      'Content-Disposition': "inline; filename*=UTF-8''" + encodeURIComponent(file.filename),
      'Cache-Control': 'private, no-store',
    });
    return fs.createReadStream(file.path).pipe(res);
  }

  return sendJson(res, 404, { error: '接口不存在' });
}

function serveStatic(req, res, requestUrl) {
  const pathname = decodeURIComponent(requestUrl.pathname === '/' ? '/admin.html' : requestUrl.pathname);
  const relative = pathname.replace(/^\/+/, '');
  if (relative.split(/[\\/]/).some((part) => part.startsWith('.')) || relative.startsWith('node_modules')) {
    return sendJson(res, 403, { error: '禁止访问' });
  }
  const filePath = path.resolve(ROOT, relative);
  if (!filePath.startsWith(ROOT + path.sep) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return sendJson(res, 404, { error: '文件不存在' });
  }
  const stat = fs.statSync(filePath);
  res.writeHead(200, {
    'Content-Type': MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': 'no-cache',
  });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url, 'http://' + HOST + ':' + PORT);
    if (requestUrl.pathname.startsWith('/api/')) return await handleApi(req, res, requestUrl);
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: '不支持的方法' });
    return serveStatic(req, res, requestUrl);
  } catch (error) {
    console.error(error);
    return sendJson(res, 500, { error: error.name === 'AbortError' ? '请求超时，请重试' : error.message });
  }
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.log('封面管理后台已经在运行，正在打开：' + ADMIN_URL);
    openAdminPage();
    setTimeout(() => process.exit(0), 500);
    return;
  }
  console.error('管理后台启动失败：', error.message);
  process.exitCode = 1;
});

server.listen(PORT, HOST, () => {
  console.log('封面管理后台已启动：' + ADMIN_URL);
  console.log('请保持此窗口开启；按 Ctrl+C 可停止服务。');
  openAdminPage();
});
