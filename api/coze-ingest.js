const crypto = require('node:crypto');

const MIN_PDF_BYTES = 50 * 1024;
const MAX_PDF_BYTES = 10 * 1024 * 1024;
const MAX_LISTED_JOBS = 20;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const JOB_ID_RE = /^[a-f0-9]{20}$/;
const DEFAULT_CATALOG_URL = 'https://dailybooks-three.vercel.app/data.json';

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function readHeader(req, name) {
  if (typeof req.headers?.get === 'function') return req.headers.get(name) || '';
  const key = Object.keys(req.headers || {}).find(item => item.toLowerCase() === name.toLowerCase());
  return key ? String(req.headers[key]) : '';
}

function safeTokenEqual(actual, expected) {
  if (!actual || !expected) return false;
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length
    && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function authenticate(req, expectedToken) {
  const authorization = readHeader(req, 'authorization');
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
  return safeTokenEqual(token, expectedToken);
}

function parseBody(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  if (Buffer.isBuffer(req.body)) return JSON.parse(req.body.toString('utf8'));
  if (typeof req.body === 'string') return JSON.parse(req.body);
  return {};
}

function stringField(body, key, min, max, errors) {
  const value = typeof body[key] === 'string' ? body[key].trim() : '';
  if (value.length < min || value.length > max) {
    errors.push(`${key} 长度必须在 ${min}-${max} 个字符之间`);
  }
  return value;
}

function stringArrayField(body, key, minItems, maxItems, maxLength, errors) {
  if (!Array.isArray(body[key])) {
    errors.push(`${key} 必须是字符串数组`);
    return [];
  }
  const values = body[key].map(item => typeof item === 'string' ? item.trim() : '');
  if (values.length < minItems || values.length > maxItems) {
    errors.push(`${key} 必须包含 ${minItems}-${maxItems} 项`);
  }
  if (values.some(item => !item || item.length > maxLength)) {
    errors.push(`${key} 每一项必须是 1-${maxLength} 个字符的非空字符串`);
  }
  return values;
}

function decodePdfBase64(value, errors) {
  if (typeof value !== 'string' || !value.trim()) {
    errors.push('file_base64 为必填字段');
    return null;
  }

  const base64 = value
    .trim()
    .replace(/^data:application\/pdf;base64,/i, '')
    .replace(/\s+/g, '');

  if (!base64 || base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
    errors.push('file_base64 不是有效的 Base64');
    return null;
  }

  const buffer = Buffer.from(base64, 'base64');
  if (buffer.length < MIN_PDF_BYTES || buffer.length > MAX_PDF_BYTES) {
    errors.push(`PDF 大小必须在 ${MIN_PDF_BYTES}-${MAX_PDF_BYTES} 字节之间`);
    return null;
  }
  if (buffer.subarray(0, 5).toString('ascii') !== '%PDF-') {
    errors.push('文件头不是有效的 PDF');
    return null;
  }
  if (!buffer.subarray(Math.max(0, buffer.length - 4096)).includes(Buffer.from('%%EOF'))) {
    errors.push('PDF 缺少结束标记，文件可能不完整');
    return null;
  }
  return buffer;
}

function validateCover(value, errors) {
  if (value == null || value === '') return '';
  if (typeof value !== 'string') {
    errors.push('cover 必须是 http(s) URL 或空字符串');
    return '';
  }
  try {
    const url = new URL(value.trim());
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('invalid protocol');
    return url.toString();
  } catch (_error) {
    errors.push('cover 必须是有效的 http(s) URL 或空字符串');
    return '';
  }
}

function validatePayload(body) {
  const errors = [];
  const metadata = {
    bookName: stringField(body, 'book_name', 1, 100, errors),
    bookNameEn: typeof body.book_name_en === 'string' ? body.book_name_en.trim().slice(0, 160) : '',
    author: stringField(body, 'author', 1, 100, errors),
    intro: stringField(body, 'intro', 40, 1000, errors),
    tags: stringArrayField(body, 'tags', 2, 5, 20, errors),
    highlights: stringArrayField(body, 'highlights', 3, 3, 120, errors),
    actionAdvice: stringField(body, 'action_advice', 10, 500, errors),
    category: stringField(body, 'category', 1, 30, errors),
    cover: validateCover(body.cover, errors),
  };

  const readMinutes = Number(body.read_minutes);
  if (!Number.isInteger(readMinutes) || readMinutes < 5 || readMinutes > 120) {
    errors.push('read_minutes 必须是 5-120 之间的整数');
  }
  metadata.readMinutes = readMinutes;

  const fileName = stringField(body, 'file_name', 5, 180, errors);
  if (fileName && !fileName.toLowerCase().endsWith('.pdf')) {
    errors.push('file_name 必须以 .pdf 结尾');
  }

  const pdf = decodePdfBase64(body.file_base64, errors);
  return { errors, fileName, metadata, pdf };
}

function businessDate(date) {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function slugify(value) {
  const slug = String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || 'book';
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function datePath(date) {
  return date.replaceAll('-', '/');
}

async function findExact(blobClient, pathname) {
  const result = await blobClient.list({ prefix: pathname, limit: 10 });
  return (result.blobs || []).find(blob => blob.pathname === pathname) || null;
}

async function readManifest(blob, fetchImpl) {
  const response = await fetchImpl(blob.url, { cache: 'no-store' });
  return response.ok ? response.json() : null;
}

function validPendingPdfPath(manifest) {
  const pathname = manifest?.pdf?.pathname;
  if (typeof pathname !== 'string' || !JOB_ID_RE.test(manifest?.jobId || '')) return false;
  const folder = datePath(manifest.businessDate || '');
  return pathname.startsWith(`daily-books/${folder}/`)
    && pathname.endsWith(`-${manifest.jobId}.pdf`);
}

async function publishedPdfUrls(fetchImpl, catalogUrl) {
  const response = await fetchImpl(catalogUrl, { cache: 'no-store' });
  if (!response.ok) throw new Error('catalog unavailable');
  const catalog = await response.json();
  const books = Array.isArray(catalog)
    ? catalog
    : (Array.isArray(catalog?.books) ? catalog.books : []);
  const urls = books.flatMap(book => [book?.pdf, book?.pdfUrl]).filter(Boolean);
  return new Set(urls);
}

function publicJob(manifest) {
  return {
    jobId: manifest.jobId,
    status: manifest.status,
    businessDate: manifest.businessDate,
    receivedAt: manifest.receivedAt,
    pdf: manifest.pdf,
    metadata: manifest.metadata,
  };
}

function createHandler({
  env = process.env,
  now = () => new Date(),
  fetchImpl = (...args) => fetch(...args),
  getBlobClient = () => require('@vercel/blob'),
} = {}) {
  return async function handler(req, res) {
    if (req.method === 'GET') {
      if (!env.CODEX_MANAGER_TOKEN || !env.BLOB_READ_WRITE_TOKEN) {
        return sendJson(res, 503, { code: 'SERVICE_NOT_CONFIGURED', error: '管理接口尚未配置' });
      }
      if (!authenticate(req, env.CODEX_MANAGER_TOKEN)) {
        return sendJson(res, 401, { code: 'UNAUTHORIZED', error: '管理令牌无效' });
      }

      const requestUrl = new URL(req.url || '/api/coze-ingest', 'http://localhost');
      const requestedDate = requestUrl.searchParams.get('date') || businessDate(now());
      if (!DATE_RE.test(requestedDate)) {
        return sendJson(res, 400, { code: 'INVALID_DATE', error: 'date 必须是 YYYY-MM-DD' });
      }

      try {
        const blobClient = getBlobClient();
        const prefix = `daily-books/_pending/${datePath(requestedDate)}/`;
        const result = await blobClient.list({ prefix, limit: MAX_LISTED_JOBS });
        const jobs = [];
        for (const blob of result.blobs || []) {
          if (!blob.pathname.endsWith('.json')) continue;
          const response = await fetchImpl(blob.url, { cache: 'no-store' });
          if (response.ok) jobs.push(publicJob(await response.json()));
        }
        jobs.sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
        return sendJson(res, 200, { ok: true, date: requestedDate, count: jobs.length, jobs });
      } catch (_error) {
        return sendJson(res, 502, { code: 'BLOB_READ_FAILED', error: '暂时无法读取待发布任务' });
      }
    }

    if (req.method === 'DELETE') {
      if (!env.COZE_INGEST_TOKEN || !env.BLOB_READ_WRITE_TOKEN) {
        return sendJson(res, 503, { code: 'SERVICE_NOT_CONFIGURED', error: '清理接口尚未配置' });
      }
      if (!authenticate(req, env.COZE_INGEST_TOKEN)) {
        return sendJson(res, 401, { code: 'UNAUTHORIZED', error: '接收令牌无效' });
      }
      if (!readHeader(req, 'content-type').toLowerCase().includes('application/json')) {
        return sendJson(res, 415, { code: 'JSON_REQUIRED', error: 'Content-Type 必须是 application/json' });
      }

      let body;
      try {
        body = parseBody(req);
      } catch (_error) {
        return sendJson(res, 400, { code: 'INVALID_JSON', error: '请求体不是有效 JSON' });
      }

      const jobId = typeof body.job_id === 'string' ? body.job_id.trim() : '';
      const requestedDate = typeof body.business_date === 'string' ? body.business_date.trim() : '';
      const bookName = typeof body.book_name === 'string' ? body.book_name.trim() : '';
      if (!JOB_ID_RE.test(jobId) || !DATE_RE.test(requestedDate) || !bookName || bookName.length > 100) {
        return sendJson(res, 422, {
          code: 'VALIDATION_FAILED',
          error: 'job_id、business_date 或 book_name 无效',
        });
      }

      try {
        const blobClient = getBlobClient();
        const prefix = `daily-books/_pending/${datePath(requestedDate)}/`;
        const currentPath = `${prefix}${jobId}.json`;
        const result = await blobClient.list({ prefix, limit: MAX_LISTED_JOBS });
        const manifests = [];
        for (const blob of result.blobs || []) {
          if (!blob.pathname.endsWith('.json')) continue;
          const manifest = await readManifest(blob, fetchImpl);
          if (manifest) manifests.push({ blob, manifest });
        }

        const current = manifests.find(item => item.blob.pathname === currentPath)?.manifest;
        if (!current || current.status !== 'pending' || current.metadata?.bookName !== bookName) {
          return sendJson(res, 404, { code: 'CURRENT_JOB_NOT_FOUND', error: '当前待发布任务不存在或书名不匹配' });
        }

        const sameBook = manifests.filter(item => (
          item.manifest.status === 'pending'
          && item.manifest.businessDate === requestedDate
          && item.manifest.metadata?.bookName === bookName
        ));
        if (sameBook.some(item => item.manifest.receivedAt > current.receivedAt)) {
          return sendJson(res, 409, { code: 'CURRENT_JOB_NOT_NEWEST', error: '只能使用同书最新任务发起清理' });
        }

        const protectedUrls = await publishedPdfUrls(
          fetchImpl,
          env.PUBLIC_CATALOG_URL || DEFAULT_CATALOG_URL,
        );
        const deletedJobIds = [];
        const protectedJobIds = [];
        for (const item of sameBook) {
          if (item.manifest.jobId === jobId || !validPendingPdfPath(item.manifest)) continue;
          if (protectedUrls.has(item.manifest.pdf.url)) {
            protectedJobIds.push(item.manifest.jobId);
            continue;
          }
          await blobClient.del([item.blob.pathname, item.manifest.pdf.pathname]);
          deletedJobIds.push(item.manifest.jobId);
        }
        return sendJson(res, 200, {
          ok: true,
          currentJobId: jobId,
          deletedCount: deletedJobIds.length,
          deletedJobIds,
          protectedJobIds,
        });
      } catch (_error) {
        return sendJson(res, 502, { code: 'BLOB_DELETE_FAILED', error: '旧待发布版本清理失败，当前版本未删除' });
      }
    }

    if (req.method !== 'POST') {
      res.setHeader('Allow', 'GET, POST, DELETE');
      return sendJson(res, 405, { code: 'METHOD_NOT_ALLOWED', error: '仅支持 GET、POST 和 DELETE 请求' });
    }

    if (!env.COZE_INGEST_TOKEN || !env.BLOB_READ_WRITE_TOKEN) {
      return sendJson(res, 503, { code: 'SERVICE_NOT_CONFIGURED', error: '接收接口尚未配置' });
    }
    if (!authenticate(req, env.COZE_INGEST_TOKEN)) {
      return sendJson(res, 401, { code: 'UNAUTHORIZED', error: '接收令牌无效' });
    }
    if (!readHeader(req, 'content-type').toLowerCase().includes('application/json')) {
      return sendJson(res, 415, { code: 'JSON_REQUIRED', error: 'Content-Type 必须是 application/json' });
    }

    let body;
    try {
      body = parseBody(req);
    } catch (_error) {
      return sendJson(res, 400, { code: 'INVALID_JSON', error: '请求体不是有效 JSON' });
    }

    const validated = validatePayload(body);
    if (validated.errors.length) {
      return sendJson(res, 422, {
        code: 'VALIDATION_FAILED',
        error: '字段或 PDF 校验失败',
        details: validated.errors,
      });
    }

    const receivedAt = now().toISOString();
    const date = businessDate(new Date(receivedAt));
    const canonicalMetadata = JSON.stringify(validated.metadata);
    const pdfSha256 = sha256(validated.pdf);
    const jobId = sha256(Buffer.concat([
      validated.pdf,
      Buffer.from(canonicalMetadata),
      Buffer.from(date),
    ])).slice(0, 20);
    const slug = slugify(validated.metadata.bookNameEn || validated.metadata.bookName);
    const folder = datePath(date);
    const pdfPath = `daily-books/${folder}/${slug}-${jobId}.pdf`;
    const manifestPath = `daily-books/_pending/${folder}/${jobId}.json`;

    try {
      const blobClient = getBlobClient();
      const existingManifest = await findExact(blobClient, manifestPath);
      if (existingManifest) {
        const response = await fetchImpl(existingManifest.url, { cache: 'no-store' });
        const manifest = response.ok ? await response.json() : null;
        return sendJson(res, 200, {
          ok: true,
          duplicate: true,
          job: manifest ? publicJob(manifest) : { jobId, status: 'pending', businessDate: date },
        });
      }

      let pdfBlob = await findExact(blobClient, pdfPath);
      if (!pdfBlob) {
        pdfBlob = await blobClient.put(pdfPath, validated.pdf, {
          access: 'public',
          contentType: 'application/pdf',
          addRandomSuffix: false,
          allowOverwrite: false,
          multipart: validated.pdf.length > 4 * 1024 * 1024,
        });
      }

      const manifest = {
        schemaVersion: '1.0',
        jobId,
        idempotencyKey: `daily-book:${date}:${jobId}`,
        status: 'pending',
        businessDate: date,
        timezone: 'Asia/Shanghai',
        receivedAt,
        provider: 'local-agent',
        originalFileName: validated.fileName,
        pdf: {
          url: pdfBlob.url,
          pathname: pdfBlob.pathname,
          size: validated.pdf.length,
          sha256: pdfSha256,
          contentType: 'application/pdf',
        },
        metadata: validated.metadata,
      };

      const manifestBlob = await blobClient.put(manifestPath, JSON.stringify(manifest, null, 2), {
        access: 'public',
        contentType: 'application/json',
        addRandomSuffix: false,
        allowOverwrite: false,
      });

      return sendJson(res, 201, {
        ok: true,
        duplicate: false,
        job: publicJob(manifest),
        manifestUrl: manifestBlob.url,
      });
    } catch (_error) {
      return sendJson(res, 502, {
        code: 'BLOB_WRITE_FAILED',
        error: 'PDF 或待发布任务写入失败，可使用相同请求安全重试',
      });
    }
  };
}

const handler = createHandler();

module.exports = handler;
module.exports._test = {
  businessDate,
  createHandler,
  decodePdfBase64,
  publishedPdfUrls,
  slugify,
  validatePayload,
};
