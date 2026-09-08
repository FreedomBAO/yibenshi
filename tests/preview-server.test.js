const test = require('node:test');
const assert = require('node:assert/strict');
const { createPreviewServer } = require('../tools/preview-server');

async function preview(t, upstream) {
  const server = createPreviewServer(upstream);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}

test('preview serves public pages but not credentials, source APIs, or traversal paths', async t => {
  const base = await preview(t, () => { throw new Error('Unexpected upstream request'); });
  assert.match(await (await fetch(base)).text(), /把一本书/);
  assert.equal((await fetch(`${base}/library.html`, { method: 'HEAD' })).status, 200);
  for (const file of ['.env', '.git/config', 'knowledge/books.json', 'api/companion.js', 'assets/%2e%2e%2fpackage.json']) {
    assert.ok([403, 404].includes((await fetch(`${base}/${file}`)).status), file);
  }
});

test('preview forwards only companion payload to the fixed production endpoint and streams SSE', async t => {
  let received;
  const sse = 'data: {"choices":[{"delta":{"content":"测试回答"}}]}\n\ndata: [DONE]\n\n';
  const base = await preview(t, async (url, options) => {
    received = { url, options };
    return new Response(sse, { headers: { 'content-type': 'text/event-stream' } });
  });
  const response = await fetch(`${base}/api/companion`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ bookId: 3, question: '测试', history: [], arbitrary: 'not forwarded' }),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  assert.equal(await response.text(), sse);
  assert.equal(received.url, 'https://dailybooks-three.vercel.app/api/companion');
  assert.deepEqual(JSON.parse(received.options.body), { bookId: 3, question: '测试', history: [] });
  assert.equal(received.options.headers.Authorization, undefined);
});

test('preview preserves upstream errors and rejects invalid local requests before forwarding', async t => {
  let requests = 0;
  const base = await preview(t, async () => {
    requests++;
    return new Response(JSON.stringify({ code: 'AI_NOT_CONFIGURED', error: '服务未配置' }), { status: 503, headers: { 'content-type': 'application/json' } });
  });
  const post = (body, headers = {}) => fetch(`${base}/api/companion`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
  assert.equal((await fetch(`${base}/api/companion`)).status, 405);
  assert.equal((await post('{}', { origin: 'https://unrelated.example' })).status, 403);
  assert.equal((await post('invalid-json')).status, 400);
  assert.equal((await post(JSON.stringify({ question: 'x'.repeat(34000) }))).status, 413);
  assert.equal(requests, 0);
  const response = await post(JSON.stringify({ bookId: 3, question: 'test' }));
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, 'AI_NOT_CONFIGURED');
  assert.equal(requests, 1);
});
