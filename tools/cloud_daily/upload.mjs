// Upload only an immutable pair that passed all pre-publication acceptance gates.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { put } from '@vercel/blob';
import { resolve } from 'node:path';

const root = resolve('_cloud_daily_work');
const read = name => JSON.parse(readFileSync(resolve(root, name), 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
try {
  const state = read('state.json');
  const acceptance = read('acceptance.json');
  const current = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  if (date !== state.date || current.getHours() < 2 || current.getHours() * 60 + current.getMinutes() >= 460) throw new Error('OUTSIDE_PUBLISH_WINDOW');
  if (state.stage !== 'validated' || state.fixture || !acceptance.prepublishPassed || !process.env.BLOB_READ_WRITE_TOKEN) throw new Error('PRECONDITION_FAILED');
  const receipt = { date: state.date };
  for (const [kind, filename, contentType] of [['pdf', 'book.pdf', 'application/pdf'], ['cover', 'book.cover.jpg', 'image/jpeg']]) {
    const bytes = readFileSync(resolve(root, filename));
    if (hash(bytes) !== state[kind + 'Sha256']) throw new Error('ACCEPTED_FILE_CHANGED');
    const blob = await put(`daily-books/${state.date.replaceAll('-', '/')}/${kind}-${hash(bytes).slice(0, 16)}.${kind === 'pdf' ? 'pdf' : 'jpg'}`, bytes, { access: 'public', contentType, addRandomSuffix: true });
    const remote = await fetch(blob.url, { signal: AbortSignal.timeout(60000), cache: 'no-store' });
    const remoteBytes = Buffer.from(await remote.arrayBuffer());
    if (!remote.ok || remote.headers.get('content-type')?.split(';')[0] !== contentType || hash(remoteBytes) !== hash(bytes)) throw new Error('BLOB_VERIFICATION_FAILED');
    receipt[kind] = { url: blob.url, sha256: hash(bytes), size: bytes.length };
    writeFileSync(resolve(root, 'upload.json'), JSON.stringify(receipt, null, 2));
  }
  console.log('PDF and cover uploaded and verified.');
} catch {
  // Do not log SDK errors or request headers: they may include credentials.
  console.error('Asset upload failed; publication has stopped.');
  process.exitCode = 1;
}
