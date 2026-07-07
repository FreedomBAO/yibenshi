/* ──────────────────────────────────────────────────
   每天精读一本书 - 管理后台脚本
   通过 GitHub Contents API 实现书籍 CRUD + 资源上传
   ────────────────────────────────────────────────── */

const STORAGE_TOKEN = 'yibenshi-admin-token';
const STORAGE_REPO = 'yibenshi-admin-repo';
const DATA_FILE = 'data.json';

const state = {
  token: null,
  repo: null,
  branch: 'main',
  user: null,
  books: [],
  dataSha: null,
  currentBook: null,
  isNewBook: false,
  pendingFiles: { cover: null, pdf: null, audio: null },
  uploadedUrls: { cover: '', pdf: '', audio: '' },
  currentTags: [],
  currentHighlights: [],
  filterKeyword: '',
  filterCategory: '',
};

/* ── 工具 ── */
function $(id) { return document.getElementById(id); }
function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}
function showToast(msg, type = 'info', duration = 3000) {
  const t = $('toast');
  t.innerHTML = msg;
  t.className = `toast visible ${type}`;
  setTimeout(() => t.classList.remove('visible'), duration);
}
function showSaveStatus(msg, type = 'saving') {
  const s = $('saveStatus');
  s.className = `save-status visible ${type}`;
  s.innerHTML = type === 'saving'
    ? '<div class="spinner"></div><span>' + msg + '</span>'
    : '<span>' + msg + '</span>';
  if (type !== 'saving') setTimeout(() => s.classList.remove('visible'), 2500);
}
function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });
}
function showConfirm(title, desc, onConfirm, confirmText = '确认', danger = false) {
  const old = document.querySelector('.modal-overlay');
  if (old) old.remove();
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-card">
      <div class="modal-title">${title}</div>
      <div class="modal-desc">${desc}</div>
      <div class="modal-actions">
        <button class="btn btn-secondary" onclick="this.closest('.modal-overlay').remove()">取消</button>
        <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" id="confirmBtn">${confirmText}</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  $('confirmBtn').onclick = () => { overlay.remove(); onConfirm(); };
}

/* ── GitHub API 错误码翻译 ── */
function interpretGitHubError(status, body, action) {
  const head = body && body.message ? body.message : `HTTP ${status}`;
  const link = (text, href) => `<a href="${href}" target="_blank" rel="noopener">${text}</a>`;
  switch (status) {
    case 401:
      return `Token 无效或已过期（${head}）。请重新创建 Personal Access Token：${link('→ 设置', 'https://github.com/settings/tokens/new')}`;
    case 403:
      if (body && /rate limit/i.test(body.message || '')) {
        return `GitHub API 限流（${head}）。匿名请求每小时 60 次，等 1 分钟后重试。`;
      }
      return `权限不足（${head}）。Token 需要 Contents: Read and write 权限：${link('→ 检查 Token', 'https://github.com/settings/tokens')}`;
    case 404:
      return `找不到文件或仓库（${head}）。检查仓库路径是否正确（当前："${state.repo}"）。`;
    case 422:
      return `请求格式错误（${head}）。通常是 SHA 不匹配——刷新页面后重试。`;
    case 429:
      return `请求过于频繁（${head}）。稍等 1 分钟再试。`;
    default:
      return `${action}失败（${status}）：${head}`;
  }
}

/* ── Markdown（自实现极简版） ── */
function renderMarkdown(src) {
  if (!src) return '';
  const escape = s => s.replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
  const lines = src.split('\n');
  const out = [];
  let inList = false;
  const closeList = () => { if (inList) { out.push('</ul>'); inList = false; } };
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line) { closeList(); continue; }
    if (/^[-*]\s+/.test(line)) {
      if (!inList) { out.push('<ul>'); inList = true; }
      out.push('<li>' + escape(line.replace(/^[-*]\s+/, ''))
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.+?)\*/g, '<em>$1</em>')
        .replace(/\[(.+?)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
        + '</li>');
      continue;
    }
    closeList();
    let html = escape(line)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/\[(.+?)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    out.push('<p>' + html + '</p>');
  }
  closeList();
  return out.join('');
}
function refreshMdPreview(textareaId, previewId) {
  const ta = $(textareaId);
  const pv = $(previewId);
  if (!ta || !pv) return;
  pv.innerHTML = renderMarkdown(ta.value) || '<span class="md-empty">（空）</span>';
}

/* ── GitHub API ── */
const gh = {
  headers() {
    return {
      'Authorization': `Bearer ${state.token}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
  },
  async verifyUser() {
    const resp = await fetch('https://api.github.com/user', { headers: this.headers() });
    if (!resp.ok) throw new Error('Token 无效或已过期');
    return resp.json();
  },
  async checkRepo() {
    const resp = await fetch(`https://api.github.com/repos/${state.repo}`, { headers: this.headers() });
    if (!resp.ok) {
      if (resp.status === 404) throw new Error('仓库不存在或 Token 无访问权限');
      if (resp.status === 401) throw new Error('Token 无效');
      throw new Error('GitHub API 错误：' + resp.status);
    }
    const data = await resp.json();
    if (!data.permissions || !data.permissions.push) {
      throw new Error('Token 没有 push 权限（需要 Contents: Read and write）');
    }
    return data;
  },
  async getFile(path) {
    const resp = await fetch(
      `https://api.github.com/repos/${state.repo}/contents/${path}?ref=${state.branch}`,
      { headers: this.headers() }
    );
    if (resp.status === 404) return null;
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}));
      throw new Error(interpretGitHubError(resp.status, body, '读取 ' + path));
    }
    return resp.json();
  },
  async putFile(path, contentBase64, message, sha = null) {
    const body = { message, branch: state.branch, content: contentBase64 };
    if (sha) body.sha = sha;
    const resp = await fetch(
      `https://api.github.com/repos/${state.repo}/contents/${path}`,
      {
        method: 'PUT',
        headers: { ...this.headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }
    );
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(interpretGitHubError(resp.status, err, '写入 ' + path));
    }
    return resp.json();
  },
  async deleteFile(path, sha, message) {
    const resp = await fetch(
      `https://api.github.com/repos/${state.repo}/contents/${path}`,
      {
        method: 'DELETE',
        headers: { ...this.headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, sha, branch: state.branch }),
      }
    );
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(interpretGitHubError(resp.status, err, '删除 ' + path));
    }
    return resp.json();
  },
  async loadBooks() {
    const file = await this.getFile(DATA_FILE);
    if (!file) throw new Error('data.json 不存在');
    state.dataSha = file.sha;
    // GitHub returns base64; decode bytes then UTF-8 decode to preserve Chinese.
    const bytes = Uint8Array.from(atob(file.content), c => c.charCodeAt(0));
    const content = JSON.parse(new TextDecoder('utf-8').decode(bytes));
    return content.books || [];
  },
  async saveBooks(books, commitMsg) {
    const content = JSON.stringify({ books }, null, 2);
    const encoded = btoa(unescape(encodeURIComponent(content)));
    await this.putFile(DATA_FILE, encoded, commitMsg, state.dataSha);
    const updated = await this.getFile(DATA_FILE);
    state.dataSha = updated.sha;
  },
};

/* ── 登录 ── */
function tryAutoLogin() {
  const token = localStorage.getItem(STORAGE_TOKEN);
  const repo = localStorage.getItem(STORAGE_REPO) || 'FreedomBAO/yibenshi';
  if (token) {
    state.token = token;
    state.repo = repo;
    $('tokenInput').value = token;
    $('repoInput').value = repo;
    return true;
  }
  return false;
}

$('loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  const btn = $('loginBtn');
  const errEl = $('loginError');
  errEl.classList.remove('visible');
  btn.disabled = true;
  btn.textContent = '验证中…';
  try {
    state.token = $('tokenInput').value.trim();
    state.repo = $('repoInput').value.trim();
    if (!state.token || !state.repo) throw new Error('Token 和仓库路径必填');
    state.user = await gh.verifyUser();
    await gh.checkRepo();
    localStorage.setItem(STORAGE_TOKEN, state.token);
    localStorage.setItem(STORAGE_REPO, state.repo);
    $('loginPage').classList.add('hidden');
    $('mainApp').classList.remove('hidden');
    $('userInfo').textContent = `👤 ${state.user.login}`;
    await loadBookList();
  } catch (err) {
    errEl.textContent = '✗ ' + err.message;
    errEl.classList.add('visible');
    btn.disabled = false;
    btn.textContent = '登录';
  }
});

function logout() {
  if (!confirm('确定要退出登录吗？')) return;
  localStorage.removeItem(STORAGE_TOKEN);
  localStorage.removeItem(STORAGE_REPO);
  location.reload();
}

/* ── 书籍列表 ── */
async function loadBookList() {
  const listEl = $('bookList');
  listEl.innerHTML = '<div style="text-align:center;padding:60px;color:var(--admin-text-light);">正在从 GitHub 加载 data.json…</div>';
  try {
    state.books = await gh.loadBooks();
    renderBookList();
  } catch (err) {
    listEl.innerHTML = `<div style="text-align:center;padding:60px;color:var(--admin-error);">加载失败：${err.message}<br><br><button class="btn btn-secondary" onclick="loadBookList()">重试</button></div>`;
  }
}

function renderBookList() {
  const total = state.books.length;
  const withCover = state.books.filter(b => b.cover || b.coverUrl).length;
  const withPdf = state.books.filter(b => b.pdf || b.pdfUrl).length;
  const withAudio = state.books.filter(b => b.audio || b.audioUrl).length;

  $('statsRow').innerHTML = `
    <div class="stat-card"><div class="stat-value">${total}</div><div class="stat-label">总书籍数</div></div>
    <div class="stat-card" style="border-left-color:#2D5A3D;"><div class="stat-value">${withCover}</div><div class="stat-label">有封面</div></div>
    <div class="stat-card" style="border-left-color:#D9542C;"><div class="stat-value">${withPdf}</div><div class="stat-label">有 PDF</div></div>
    <div class="stat-card" style="border-left-color:#1E4A8C;"><div class="stat-value">${withAudio}</div><div class="stat-label">有音频</div></div>
  `;

  if (!state.books.length) {
    $('bookList').innerHTML = '<div style="text-align:center;padding:60px;color:var(--admin-text-light);">还没有书籍。点击右上角"新增书籍"开始添加。</div>';
    return;
  }

  const sorted = state.books.slice().sort((a, b) => (a.id || 999) - (b.id || 999));

  $('bookList').innerHTML = sorted.map(book => {
    const coverUrl = book.cover || book.coverUrl;
    const hasCover = coverUrl ? `<img src="${coverUrl}" alt="${escapeHtml(book.title)}">` : `<span>${escapeHtml((book.title || '?')[0])}</span>`;
    const tagsHtml = (book.tags || []).slice(0, 3).map(t => `<span style="color:var(--admin-text-light);">#${escapeHtml(t)}</span>`).join(' ');
    const titleText = (book.title || '').toLowerCase();
    const authorText = (book.author || '').toLowerCase();
    const kw = state.filterKeyword.toLowerCase();
    const matchKw = !kw || titleText.includes(kw) || authorText.includes(kw) ||
      (book.tags || []).some(t => t.toLowerCase().includes(kw));
    const matchCat = !state.filterCategory || book.category === state.filterCategory;
    const hidden = !(matchKw && matchCat);
    return `
      <div class="book-row${hidden ? ' hidden' : ''}" data-id="${book.id}" onclick="editBook('${book.id}')">
        <div class="book-row-cover">${hasCover}</div>
        <div class="book-row-info">
          <div class="book-row-title">${escapeHtml(book.title)}</div>
          <div class="book-row-meta">
            <span>${escapeHtml(book.author || '未知作者')}</span>
            <span class="category">${escapeHtml(book.category || '未分类')}</span>
            <span style="color:var(--admin-text-light);">${formatDate(book.date)}</span>
            ${tagsHtml ? `<span>${tagsHtml}</span>` : ''}
          </div>
          <div class="book-row-meta" style="margin-top:6px;font-size:11px;">
            ${coverUrl ? '✓ 封面 ' : '○ 封面 '}
            ${(book.pdf || book.pdfUrl) ? '✓ PDF ' : '○ PDF '}
            ${(book.audio || book.audioUrl) ? '✓ 音频 ' : '○ 音频'}
          </div>
        </div>
        <div class="book-row-actions">
          <button class="btn btn-ghost" onclick="event.stopPropagation();editBook('${book.id}')">编辑</button>
        </div>
      </div>
    `;
  }).join('');
  updateFilterCount();
}

function applyFilter() {
  state.filterKeyword = $('filterInput').value.trim();
  state.filterCategory = $('filterCategory').value;
  const rows = $('bookList').querySelectorAll('.book-row');
  rows.forEach(row => {
    const book = state.books.find(b => String(b.id) === String(row.dataset.id));
    if (!book) return;
    const titleText = (book.title || '').toLowerCase();
    const authorText = (book.author || '').toLowerCase();
    const kw = state.filterKeyword.toLowerCase();
    const matchKw = !kw || titleText.includes(kw) || authorText.includes(kw) ||
      (book.tags || []).some(t => t.toLowerCase().includes(kw));
    const matchCat = !state.filterCategory || book.category === state.filterCategory;
    row.classList.toggle('hidden', !(matchKw && matchCat));
  });
  updateFilterCount();
}

function updateFilterCount() {
  const el = $('filterCount');
  if (!el) return;
  const total = $('bookList').querySelectorAll('.book-row').length;
  const visible = $('bookList').querySelectorAll('.book-row:not(.hidden)').length;
  if (!state.filterKeyword && !state.filterCategory) {
    el.textContent = '';
  } else {
    el.textContent = `显示 ${visible} / ${total}`;
  }
}

/* ── 新增/编辑/删除 ── */
function showAddBook() {
  const maxId = state.books.reduce((m, b) => Math.max(m, b.id || 0), 0);
  const newBook = {
    id: maxId + 1,
    date: new Date().toISOString().slice(0, 10),
    title: '', originalTitle: '', author: '', description: '',
    tags: [], highlights: [], action: '', duration: '', rating: '8.5', category: '',
    cover: '', pdf: '', audio: '', audioUrl: '', pdfUrl: '',
  };
  state.currentBook = newBook;
  state.isNewBook = true;
  state.pendingFiles = { cover: null, pdf: null, audio: null };
  state.uploadedUrls = { cover: '', pdf: '', audio: '' };
  showEditView();
  $('editTitle').textContent = '新增书籍';
  $('editSubtitle').textContent = '填写完后点"保存到 GitHub"';
  fillForm(newBook);
}

function editBook(id) {
  const book = state.books.find(b => String(b.id) === String(id));
  if (!book) return showToast('找不到这本书', 'error');
  state.currentBook = JSON.parse(JSON.stringify(book));
  state.isNewBook = false;
  state.pendingFiles = { cover: null, pdf: null, audio: null };
  state.uploadedUrls = {
    cover: book.cover || book.coverUrl || '',
    pdf: book.pdf || book.pdfUrl || '',
    audio: book.audio || book.audioUrl || '',
  };
  showEditView();
  $('editTitle').textContent = `编辑：${book.title || '(无标题)'}`;
  $('editSubtitle').textContent = `编号 ${book.id}`;
  fillForm(book);
}

function showEditView() {
  $('listView').classList.add('hidden');
  $('editView').classList.remove('hidden');
  window.scrollTo(0, 0);
}

function showList() {
  $('editView').classList.add('hidden');
  $('listView').classList.remove('hidden');
  resetUploadUI();
}

function fillForm(book) {
  $('editBookId').value = book.id || '';
  $('field-id').value = book.id || '';
  $('field-title').value = book.title || '';
  $('field-originalTitle').value = book.originalTitle || '';
  $('field-author').value = book.author || '';
  $('field-date').value = book.date || '';
  $('field-category').value = book.category || '';
  $('field-rating').value = book.rating || '';
  $('field-duration').value = book.duration || '';
  $('field-description').value = book.description || '';
  $('field-action').value = book.action || '';
  state.currentTags = (book.tags || []).slice();
  renderTags();
  state.currentHighlights = (book.highlights || []).slice();
  renderHighlights();
  renderExistingResources(book);
  refreshMdPreview('field-description', 'preview-description');
  refreshMdPreview('field-action', 'preview-action');
}

/* ── Tags ── */
function renderTags() {
  const container = $('tagsInput');
  container.querySelectorAll('.tag-pill').forEach(el => el.remove());
  (state.currentTags || []).forEach((tag, idx) => {
    const pill = document.createElement('span');
    pill.className = 'tag-pill';
    pill.innerHTML = `${escapeHtml(tag)}<button type="button" data-idx="${idx}">✕</button>`;
    container.insertBefore(pill, $('tagInput'));
  });
}

$('tagInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    e.preventDefault();
    const val = e.target.value.trim();
    if (val && !state.currentTags.includes(val)) {
      state.currentTags.push(val);
      renderTags();
    }
    e.target.value = '';
  }
});

$('tagsInput').addEventListener('click', e => {
  if (e.target.tagName === 'BUTTON') {
    const idx = parseInt(e.target.dataset.idx, 10);
    state.currentTags.splice(idx, 1);
    renderTags();
  }
});

/* ── Highlights ── */
function renderHighlights() {
  $('highlightsList').innerHTML = (state.currentHighlights || []).map((h, idx) => `
    <div class="list-input-row">
      <input type="text" value="${escapeHtml(h)}" data-idx="${idx}" oninput="updateHighlight(${idx}, this.value)" placeholder="核心要点">
      <button class="btn btn-ghost" onclick="removeHighlight(${idx})">✕</button>
    </div>
  `).join('');
}

function addHighlightRow() {
  state.currentHighlights.push('');
  renderHighlights();
  const inputs = $('highlightsList').querySelectorAll('input');
  if (inputs.length) inputs[inputs.length - 1].focus();
}

function updateHighlight(idx, value) {
  state.currentHighlights[idx] = value;
}

function removeHighlight(idx) {
  state.currentHighlights.splice(idx, 1);
  renderHighlights();
}

/* ── 上传 ── */
function setupUpload(zoneId, inputId, type) {
  const zone = $(zoneId);
  const input = $(inputId);
  if (!zone || !input) return;
  zone.onclick = e => { if (e.target.tagName !== 'BUTTON') input.click(); };
  zone.ondragover = e => { e.preventDefault(); zone.classList.add('dragover'); };
  zone.ondragleave = () => zone.classList.remove('dragover');
  zone.ondrop = e => {
    e.preventDefault();
    zone.classList.remove('dragover');
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file, type);
  };
  input.onchange = e => {
    const file = e.target.files[0];
    if (file) handleFile(file, type);
  };
}

function handleFile(file, type) {
  const limits = { cover: 5 * 1024 * 1024, pdf: 20 * 1024 * 1024, audio: 50 * 1024 * 1024 };
  if (file.size > limits[type]) {
    showToast(type + ' 文件超过限制', 'error');
    return;
  }
  state.pendingFiles[type] = file;
  const zone = $(type === 'cover' ? 'coverZone' : type === 'pdf' ? 'pdfZone' : 'audioZone');
  zone.classList.add('has-file');
  const sizeStr = (file.size / 1024).toFixed(0) + ' KB';
  const inner = type === 'cover'
    ? `<img src="${URL.createObjectURL(file)}" class="upload-preview"><div class="upload-file-info">${escapeHtml(file.name)} · ${sizeStr}</div><button class="upload-remove" type="button" onclick="removeFile('${type}')">移除</button>`
    : `<div style="font-size:24px;margin-bottom:6px;">${type === 'pdf' ? '📄' : '🎙'}</div><div class="upload-file-info">${escapeHtml(file.name)}<br>${sizeStr}</div><button class="upload-remove" type="button" onclick="removeFile('${type}')">移除</button>`;
  zone.innerHTML = inner + `<input type="file" id="${type === 'cover' ? 'coverInput' : type === 'pdf' ? 'pdfInput' : 'audioInput'}" accept="${type === 'cover' ? 'image/*' : type === 'pdf' ? '.pdf' : 'audio/*'}" style="display:none">`;
  setupUpload(zone.id, type === 'cover' ? 'coverInput' : type === 'pdf' ? 'pdfInput' : 'audioInput', type);
}

function removeFile(type) {
  state.pendingFiles[type] = null;
  resetUploadUI();
  showToast('已移除', 'info', 1500);
}

function resetUploadUI() {
  const zones = [
    { id: 'coverZone', inputId: 'coverInput', accept: 'image/*', label: '拖拽图片或点击选择' },
    { id: 'pdfZone', inputId: 'pdfInput', accept: '.pdf', label: '拖拽 PDF 或点击选择' },
    { id: 'audioZone', inputId: 'audioInput', accept: 'audio/*', label: '拖拽音频或点击选择' },
  ];
  zones.forEach(({ id, inputId, accept, label }) => {
    const zone = $(id);
    zone.classList.remove('has-file', 'dragover');
    zone.innerHTML = `<div>${label}</div><input type="file" id="${inputId}" accept="${accept}" style="display:none">`;
    const type = id.startsWith('cover') ? 'cover' : id.startsWith('pdf') ? 'pdf' : 'audio';
    setupUpload(id, inputId, type);
  });
  // 重新显示已有资源
  if (state.currentBook) renderExistingResources(state.currentBook);
}

function renderExistingResources(book) {
  const show = (zoneId, label, url) => {
    if (!url) return;
    const zone = $(zoneId);
    if (!zone || zone.classList.contains('has-file')) return;
    zone.classList.add('has-file');
    zone.innerHTML = `
      <div style="font-size:11px;color:var(--admin-success);">✓ 已上传</div>
      <div class="upload-file-info">${escapeHtml(url.split('/').pop())}</div>
      <button class="upload-remove" type="button" onclick="confirmRemoveExisting('${label}', '${escapeHtml(url)}')">移除</button>
      <input type="file" style="display:none">
    `;
  };
  show('coverZone', '封面', book.cover || book.coverUrl);
  show('pdfZone', 'PDF', book.pdf || book.pdfUrl);
  show('audioZone', '音频', book.audio || book.audioUrl);
}

async function confirmRemoveExisting(label, url) {
  if (!confirm(`确定要删除当前的${label}吗？\n${url}\n\n这会从 GitHub 删除文件（不可恢复）。`)) return;
  try {
    showSaveStatus('正在删除 ' + label + '…');
    const path = url.replace(`https://raw.githubusercontent.com/${state.repo}/${state.branch}/`, '');
    const file = await gh.getFile(path);
    if (file) await gh.deleteFile(path, file.sha, `删除 ${label}：${state.currentBook.title}`);
    state.uploadedUrls[label === '封面' ? 'cover' : label === 'PDF' ? 'pdf' : 'audio'] = '';
    showSaveStatus('✓ 已删除', 'success');
    showToast('已删除' + label + '，记得保存 data.json', 'info', 4000);
    setTimeout(() => { resetUploadUI(); }, 500);
  } catch (err) {
    showSaveStatus('✗ 删除失败', 'error');
    showToast('删除失败：' + err.message, 'error');
  }
}

/* ── 保存 ── */
async function saveCurrentBook() {
  const btn = $('saveBtn');
  btn.disabled = true;
  try {
    const title = $('field-title').value.trim();
    const author = $('field-author').value.trim();
    const description = $('field-description').value.trim();
    if (!title) throw new Error('书名必填');
    if (!author) throw new Error('作者必填');
    if (!description) throw new Error('深度书评必填');

    if (state.pendingFiles.cover) {
      showSaveStatus('正在上传封面…');
      state.uploadedUrls.cover = await uploadAsset(state.pendingFiles.cover, 'cover');
    }
    if (state.pendingFiles.pdf) {
      showSaveStatus('正在上传 PDF…');
      state.uploadedUrls.pdf = await uploadAsset(state.pendingFiles.pdf, 'pdf');
    }
    if (state.pendingFiles.audio) {
      showSaveStatus('正在上传音频…');
      state.uploadedUrls.audio = await uploadAsset(state.pendingFiles.audio, 'audio');
    }

    const bookId = parseInt($('field-id').value) || state.currentBook.id;
    const book = {
      id: bookId,
      date: $('field-date').value || new Date().toISOString().slice(0, 10),
      title,
      originalTitle: $('field-originalTitle').value.trim(),
      author,
      description,
      tags: (state.currentTags || []).filter(t => t.trim()),
      highlights: (state.currentHighlights || []).filter(h => h.trim()),
      action: $('field-action').value.trim(),
      duration: $('field-duration').value.trim(),
      rating: $('field-rating').value,
      category: $('field-category').value,
    };
    if (state.uploadedUrls.cover) book.cover = state.uploadedUrls.cover;
    if (state.uploadedUrls.pdf) { book.pdf = state.uploadedUrls.pdf; book.pdfUrl = state.uploadedUrls.pdf; }
    if (state.uploadedUrls.audio) { book.audio = state.uploadedUrls.audio; book.audioUrl = state.uploadedUrls.audio; }

    let newBooks, commitMsg;
    if (state.isNewBook) {
      newBooks = state.books.slice();
      newBooks.push(book);
      commitMsg = `添加书籍：${book.title}`;
    } else {
      newBooks = state.books.map(b => String(b.id) === String(state.currentBook.id) ? book : b);
      commitMsg = `更新书籍：${book.title}`;
    }

    showSaveStatus('正在保存到 GitHub…');
    await gh.saveBooks(newBooks, commitMsg);

    showSaveStatus('✓ 保存成功！Vercel 将在 1 分钟内自动部署', 'success');
    showToast('✓ 保存成功！Vercel 正在部署…', 'success', 4000);
    state.currentBook = book;
    state.isNewBook = false;
    state.pendingFiles = { cover: null, pdf: null, audio: null };
    await loadBookList();
    setTimeout(showList, 1500);
  } catch (err) {
    showSaveStatus('✗ ' + err.message, 'error');
    showToast('保存失败：' + err.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

async function uploadAsset(file, type) {
  const ext = file.name.split('.').pop();
  const bookId = parseInt($('field-id').value) || state.currentBook.id || 'new';
  const safeTitle = $('field-title').value.trim().replace(/[\\/:*?"<>|]/g, '_').slice(0, 30) || 'untitled';
  const filename = `book-${bookId}-${type}-${Date.now()}.${ext}`;
  const folder = type === 'cover' ? 'assets/covers' : type === 'pdf' ? 'assets/pdfs' : 'assets/audio';
  const path = `${folder}/${filename}`;
  const base64 = await fileToBase64(file);
  const commitMsg = `上传 ${type}: ${safeTitle}`;
  await gh.putFile(path, base64, commitMsg);
  return `https://raw.githubusercontent.com/${state.repo}/${state.branch}/${path}`;
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function deleteCurrentBook() {
  if (!state.currentBook) return;
  showConfirm(
    '删除书籍',
    `<strong>确定要删除《${escapeHtml(state.currentBook.title)}》吗？</strong><br><br>
     这会从 data.json 移除该书。<br>
     关联的资源文件（封面/PDF/音频）需要手动删除。<br><br>
     <em>此操作不可恢复。</em>`,
    async () => {
      try {
        showSaveStatus('正在删除…');
        const newBooks = state.books.filter(b => String(b.id) !== String(state.currentBook.id));
        await gh.saveBooks(newBooks, `删除书籍：${state.currentBook.title}`);
        showSaveStatus('✓ 已删除', 'success');
        showToast('✓ 已删除书籍', 'success');
        await loadBookList();
        setTimeout(showList, 1200);
      } catch (err) {
        showSaveStatus('✗ ' + err.message, 'error');
        showToast('删除失败：' + err.message, 'error');
      }
    },
    '确认删除',
    true
  );
}

/* ── 初始化 ── */
setupUpload('coverZone', 'coverInput', 'cover');
setupUpload('pdfZone', 'pdfInput', 'pdf');
setupUpload('audioZone', 'audioInput', 'audio');

$('filterInput').addEventListener('input', applyFilter);
$('filterCategory').addEventListener('change', applyFilter);

$('field-description').addEventListener('input', () =>
  refreshMdPreview('field-description', 'preview-description'));
$('field-action').addEventListener('input', () =>
  refreshMdPreview('field-action', 'preview-action'));

if (tryAutoLogin()) {
  state.token = localStorage.getItem(STORAGE_TOKEN);
  state.repo = localStorage.getItem(STORAGE_REPO) || 'FreedomBAO/yibenshi';
  $('tokenInput').value = state.token;
  $('repoInput').value = state.repo;
  gh.verifyUser()
    .then(user => {
      state.user = user;
      $('loginPage').classList.add('hidden');
      $('mainApp').classList.remove('hidden');
      $('userInfo').textContent = `👤 ${user.login}`;
      return loadBookList();
    })
    .catch(() => {
      localStorage.removeItem(STORAGE_TOKEN);
      showToast('Token 已失效，请重新登录', 'error', 3000);
    });
}

window.editBook = editBook;
window.showAddBook = showAddBook;
window.showList = showList;
window.saveCurrentBook = saveCurrentBook;
window.deleteCurrentBook = deleteCurrentBook;
window.addHighlightRow = addHighlightRow;
window.updateHighlight = updateHighlight;
window.removeHighlight = removeHighlight;
window.removeFile = removeFile;
window.confirmRemoveExisting = confirmRemoveExisting;
window.loadBookList = loadBookList;
window.logout = logout;
window.applyFilter = applyFilter;
window.renderMarkdown = renderMarkdown;
