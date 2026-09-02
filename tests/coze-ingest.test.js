const assert = require('node:assert/strict');
const test = require('node:test');

const { createHandler, businessDate, slugify } = require('../api/coze-ingest')._test;

function makePdf() {
  const content = Buffer.alloc(55 * 1024, 32);
  Buffer.from('%PDF-1.7\n').copy(content, 0);
  Buffer.from('\n%%EOF\n').copy(content, content.length - 7);
  return content;
}

function validBody() {
  return {
    file_base64: makePdf().toString('base64'),
    file_name: 'underlying-logic.pdf',
    book_name: '底层逻辑',
    book_name_en: 'Underlying Logic',
    author: '刘润',
    intro: '这是一本帮助普通读者理解复杂问题、建立判断框架并将核心知识落实为行动步骤的精读报告。',
    tags: ['认知', '思维模型', '方法论'],
    highlights: ['先找到问题背后的基本事实', '区分观点、事实与立场', '用可检查的行动验证判断'],
    action_advice: '选择今天的一项判断，分别写下事实、观点与立场，再决定下一步行动。',
    category: '认知提升',
    read_minutes: 20,
    cover: '',
  };
}

function responseRecorder() {
  return {
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    end(value) { this.body = value; },
    json() { return JSON.parse(this.body); },
  };
}

function memoryBlobClient() {
  const blobs = new Map();
  let writes = 0;
  let deletes = 0;
  return {
    get writes() { return writes; },
    get deletes() { return deletes; },
    async list({ prefix, limit }) {
      return { blobs: [...blobs.values()].filter(blob => blob.pathname.startsWith(prefix)).slice(0, limit) };
    },
    async put(pathname, body, options) {
      if (blobs.has(pathname) && !options.allowOverwrite) throw new Error('exists');
      writes += 1;
      const value = typeof body === 'string' ? body : Buffer.from(body);
      const blob = {
        pathname,
        url: `https://blob.example/${pathname}`,
        contentType: options.contentType,
        value,
      };
      blobs.set(pathname, blob);
      return blob;
    },
    async del(paths) {
      for (const pathname of Array.isArray(paths) ? paths : [paths]) {
        if (blobs.delete(pathname)) deletes += 1;
      }
    },
    async fetch(url) {
      const pathname = url.replace('https://blob.example/', '');
      const blob = blobs.get(pathname);
      return {
        ok: Boolean(blob),
        async json() { return JSON.parse(String(blob.value)); },
      };
    },
  };
}

function buildHandler(blob, publishedUrls = new Set()) {
  let tick = 0;
  return createHandler({
    env: {
      COZE_INGEST_TOKEN: 'coze-secret',
      CODEX_MANAGER_TOKEN: 'manager-secret',
      BLOB_READ_WRITE_TOKEN: 'blob-secret',
    },
    now: () => new Date(Date.parse('2026-09-02T18:15:00.000Z') + (tick++ * 1000)),
    getBlobClient: () => blob,
    fetchImpl: url => {
      if (url === 'https://dailybooks-three.vercel.app/data.json') {
        return Promise.resolve({
          ok: true,
          async json() { return { books: [...publishedUrls].map(pdfUrl => ({ pdfUrl })) }; },
        });
      }
      return blob.fetch(url);
    },
  });
}

function deleteRequest(body, token = 'coze-secret') {
  return {
    method: 'DELETE',
    url: '/api/coze-ingest',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body,
  };
}

function postRequest(body, token = 'coze-secret') {
  return {
    method: 'POST',
    url: '/api/coze-ingest',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body,
  };
}

test('uses the Asia/Shanghai business date and stable slugs', () => {
  assert.equal(businessDate(new Date('2026-09-02T18:15:00.000Z')), '2026-09-03');
  assert.equal(slugify('Thinking, Fast and Slow'), 'thinking-fast-and-slow');
  assert.equal(slugify('底层逻辑'), 'book');
});

test('rejects invalid authorization before writing', async () => {
  const blob = memoryBlobClient();
  const res = responseRecorder();
  await buildHandler(blob)(postRequest(validBody(), 'wrong'), res);
  assert.equal(res.statusCode, 401);
  assert.equal(blob.writes, 0);
});

test('rejects unauthorized cleanup before deleting', async () => {
  const blob = memoryBlobClient();
  const handler = buildHandler(blob);
  const uploaded = responseRecorder();
  await handler(postRequest(validBody()), uploaded);

  const cleanup = responseRecorder();
  await handler(deleteRequest({
    job_id: uploaded.json().job.jobId,
    business_date: uploaded.json().job.businessDate,
    book_name: validBody().book_name,
  }, 'wrong'), cleanup);

  assert.equal(cleanup.statusCode, 401);
  assert.equal(blob.deletes, 0);
});

test('rejects malformed metadata with details', async () => {
  const blob = memoryBlobClient();
  const body = validBody();
  body.highlights = ['只有一条'];
  const res = responseRecorder();
  await buildHandler(blob)(postRequest(body), res);
  assert.equal(res.statusCode, 422);
  assert.equal(res.json().code, 'VALIDATION_FAILED');
  assert.match(res.json().details.join(' '), /highlights/);
  assert.equal(blob.writes, 0);
});

test('stores one PDF and one pending manifest, then handles retries idempotently', async () => {
  const blob = memoryBlobClient();
  const handler = buildHandler(blob);

  const first = responseRecorder();
  await handler(postRequest(validBody()), first);
  assert.equal(first.statusCode, 201);
  assert.equal(first.json().job.status, 'pending');
  assert.equal(first.json().job.businessDate, '2026-09-03');
  assert.match(first.json().job.pdf.url, /\.pdf$/);
  assert.equal(blob.writes, 2);

  const retry = responseRecorder();
  await handler(postRequest(validBody()), retry);
  assert.equal(retry.statusCode, 200);
  assert.equal(retry.json().duplicate, true);
  assert.equal(blob.writes, 2);
});

test('lists pending jobs only with the manager token', async () => {
  const blob = memoryBlobClient();
  const handler = buildHandler(blob);
  await handler(postRequest(validBody()), responseRecorder());

  const unauthorized = responseRecorder();
  await handler({ method: 'GET', url: '/api/coze-ingest?date=2026-09-03', headers: {} }, unauthorized);
  assert.equal(unauthorized.statusCode, 401);

  const authorized = responseRecorder();
  await handler({
    method: 'GET',
    url: '/api/coze-ingest?date=2026-09-03',
    headers: { authorization: 'Bearer manager-secret' },
  }, authorized);
  assert.equal(authorized.statusCode, 200);
  assert.equal(authorized.json().count, 1);
  assert.equal(authorized.json().jobs[0].metadata.bookName, '底层逻辑');
});

test('deletes only older pending versions of the same book', async () => {
  const blob = memoryBlobClient();
  const handler = buildHandler(blob);

  const oldResponse = responseRecorder();
  await handler(postRequest(validBody()), oldResponse);

  const currentBody = validBody();
  currentBody.highlights[0] = '新版：先找到问题背后的基本事实';
  const currentResponse = responseRecorder();
  await handler(postRequest(currentBody), currentResponse);

  const otherBook = validBody();
  otherBook.book_name = '另一本文';
  otherBook.book_name_en = 'Another Book';
  const otherResponse = responseRecorder();
  await handler(postRequest(otherBook), otherResponse);

  const cleanup = responseRecorder();
  await handler(deleteRequest({
    job_id: currentResponse.json().job.jobId,
    business_date: currentResponse.json().job.businessDate,
    book_name: currentBody.book_name,
  }), cleanup);

  assert.equal(cleanup.statusCode, 200);
  assert.deepEqual(cleanup.json().deletedJobIds, [oldResponse.json().job.jobId]);
  assert.equal(blob.deletes, 2);

  const list = responseRecorder();
  await handler({
    method: 'GET',
    url: '/api/coze-ingest?date=2026-09-03',
    headers: { authorization: 'Bearer manager-secret' },
  }, list);
  assert.equal(list.json().count, 2);
  assert.deepEqual(
    new Set(list.json().jobs.map(job => job.metadata.bookName)),
    new Set(['底层逻辑', '另一本文']),
  );
});

test('refuses cleanup from an older job', async () => {
  const blob = memoryBlobClient();
  const handler = buildHandler(blob);
  const oldResponse = responseRecorder();
  await handler(postRequest(validBody()), oldResponse);
  const newerBody = validBody();
  newerBody.action_advice = '新版行动：写下事实、观点和立场，并在今天完成一次验证。';
  await handler(postRequest(newerBody), responseRecorder());

  const cleanup = responseRecorder();
  await handler(deleteRequest({
    job_id: oldResponse.json().job.jobId,
    business_date: oldResponse.json().job.businessDate,
    book_name: validBody().book_name,
  }), cleanup);
  assert.equal(cleanup.statusCode, 409);
  assert.equal(cleanup.json().code, 'CURRENT_JOB_NOT_NEWEST');
  assert.equal(blob.deletes, 0);
});

test('protects a pending blob already referenced by the production catalog', async () => {
  const blob = memoryBlobClient();
  const publishedUrls = new Set();
  const handler = buildHandler(blob, publishedUrls);
  const oldResponse = responseRecorder();
  await handler(postRequest(validBody()), oldResponse);
  publishedUrls.add(oldResponse.json().job.pdf.url);

  const newerBody = validBody();
  newerBody.highlights[1] = '新版：区分观点、事实与立场';
  const newerResponse = responseRecorder();
  await handler(postRequest(newerBody), newerResponse);

  const cleanup = responseRecorder();
  await handler(deleteRequest({
    job_id: newerResponse.json().job.jobId,
    business_date: newerResponse.json().job.businessDate,
    book_name: newerBody.book_name,
  }), cleanup);
  assert.equal(cleanup.statusCode, 200);
  assert.deepEqual(cleanup.json().deletedJobIds, []);
  assert.deepEqual(cleanup.json().protectedJobIds, [oldResponse.json().job.jobId]);
  assert.equal(blob.deletes, 0);
});
