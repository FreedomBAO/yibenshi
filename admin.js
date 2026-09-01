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

const coverFlow = {
  mode: 'single',
  books: [],
  index: 0,
  offset: 0,
  hasMore: false,
  busy: false,
};

const pdfFlow = {
  archiveId: null,
  matches: [],
  unmatched: [],
  duplicates: [],
  busy: false,
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
      `https://api.github.com/repos/${state.repo}/contents/${path}?ref=${state.branch}&_=${Date.now()}`,
      { headers: this.headers(), cache: 'no-store' }
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
      const error = new Error(interpretGitHubError(resp.status, err, '写入 ' + path));
      error.status = resp.status;
      throw error;
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
    const result = await this.putFile(DATA_FILE, encoded, commitMsg, state.dataSha);
    state.dataSha = result.content.sha;
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

/* ── 分页渲染（admin + 主站共用） ── */
const PAGE_SIZE = 20;
function renderChunked(container, items, renderItem, opts = {}) {
  const size = opts.pageSize || PAGE_SIZE;
  let shown = Math.min(size, items.length);
  const draw = () => {
    const html = items.slice(0, shown).map(renderItem).join('');
    const remaining = items.length - shown;
    const btnHtml = remaining > 0
      ? `<button type="button" class="chunk-toggle-btn" id="chunkToggle">▼ 显示下 ${Math.min(size, remaining)} 本（剩 ${remaining}）</button>`
      : '';
    container.innerHTML = html + btnHtml;
    const btn = $('chunkToggle');
    if (btn) btn.onclick = () => { shown = Math.min(shown + size, items.length); draw(); };
  };
  draw();
}

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

  function bookRowHtml(book) {
    const coverUrl = book.cover || book.coverUrl;
    const hasCover = coverUrl ? `<img src="${coverUrl}" alt="${escapeHtml(book.title)}">` : `<span>${escapeHtml((book.title || '?')[0])}</span>`;
    const tagsHtml = (book.tags || []).slice(0, 3).map(t => `<span style="color:var(--admin-text-light);">#${escapeHtml(t)}</span>`).join(' ');
    return `
      <div class="book-row" data-id="${book.id}" onclick="editBook('${book.id}')">
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
  }
  renderChunked($('bookList'), sorted, bookRowHtml);
  updateFilterCount();
}

function applyFilter() {
  state.filterKeyword = $('filterInput').value.trim();
  state.filterCategory = $('filterCategory').value;
  const kw = state.filterKeyword.toLowerCase();
  const filtered = state.books.filter(b => {
    const titleText = (b.title || '').toLowerCase();
    const authorText = (b.author || '').toLowerCase();
    const matchKw = !kw || titleText.includes(kw) || authorText.includes(kw) ||
      (b.tags || []).some(t => t.toLowerCase().includes(kw));
    const matchCat = !state.filterCategory || b.category === state.filterCategory;
    return matchKw && matchCat;
  });
  const sorted = filtered.slice().sort((a, b) => (a.id || 999) - (b.id || 999));
  function bookRowHtml(book) {
    const coverUrl = book.cover || book.coverUrl;
    const hasCover = coverUrl ? `<img src="${coverUrl}" alt="${escapeHtml(book.title)}">` : `<span>${escapeHtml((book.title || '?')[0])}</span>`;
    const tagsHtml = (book.tags || []).slice(0, 3).map(t => `<span style="color:var(--admin-text-light);">#${escapeHtml(t)}</span>`).join(' ');
    return `
      <div class="book-row" data-id="${book.id}" onclick="editBook('${book.id}')">
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
  }
  renderChunked($('bookList'), sorted, bookRowHtml);
  updateFilterCount(filtered.length);
}

function updateFilterCount(filteredTotal) {
  const el = $('filterCount');
  if (!el) return;
  const total = state.books.length;
  if (!state.filterKeyword && !state.filterCategory) {
    el.textContent = total > 20 ? `显示前 20 / 共 ${total}` : `共 ${total}`;
  } else {
    el.textContent = `匹配 ${filteredTotal != null ? filteredTotal : '?'} / 共 ${total}`;
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

/* ── 批量上传 PDF ── */
function canonicalBookTitle(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\.pdf$/i, '')
    .replace(/[\s·•，,。.!！?？:：;；、()（）\[\]【】《》<>“”"'‘’—–_\-]/g, '');
}

function parsePdfFilename(file) {
  let stem = String(file.filename || '').replace(/\.pdf$/i, '');
  const dateMatch = stem.match(/^(\d{8}|\d{6})[\s_-]*/);
  const dateRank = dateMatch ? Number(dateMatch[1]) : 0;
  if (dateMatch) stem = stem.slice(dateMatch[0].length);
  stem = stem.replace(/[\s_-]*(?:读书)?(?:报告|书评|笔记)$/i, '').trim();
  return { ...file, title: stem, key: canonicalBookTitle(stem), dateRank };
}

function matchPdfFiles(files) {
  const groups = new Map();
  files.map(parsePdfFilename).forEach((file) => {
    if (!file.key) return;
    if (!groups.has(file.key)) groups.set(file.key, []);
    groups.get(file.key).push(file);
  });

  const selected = [];
  const duplicates = [];
  for (const group of groups.values()) {
    group.sort((a, b) => b.dateRank - a.dateRank || b.size - a.size);
    selected.push(group[0]);
    duplicates.push(...group.slice(1));
  }

  const booksByTitle = new Map(state.books.map((book) => [canonicalBookTitle(book.title), book]));
  const matches = [];
  const unmatched = [];
  selected.forEach((file) => {
    const book = booksByTitle.get(file.key);
    if (book) matches.push({ file, book });
    else unmatched.push(file);
  });
  matches.sort((a, b) => Number(a.book.id) - Number(b.book.id));
  unmatched.sort((a, b) => a.title.localeCompare(b.title, 'zh-CN'));
  return { matches, unmatched, duplicates };
}

function formatFileSize(bytes) {
  if (bytes < 1024 * 1024) return Math.max(1, Math.round(bytes / 1024)) + ' KB';
  return (bytes / 1024 / 1024).toFixed(2) + ' MB';
}

function openPdfBatchModal(content) {
  document.querySelectorAll('.modal-overlay').forEach((item) => item.remove());
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'pdfBatchOverlay';
  overlay.innerHTML =
    '<div class="modal-card pdf-batch-modal" role="dialog" aria-modal="true" aria-labelledby="pdfBatchTitle">' +
      '<div class="cover-search-head">' +
        '<div><div class="cover-search-kicker">PDF Importer</div>' +
        '<h2 id="pdfBatchTitle">批量匹配 PDF</h2><p id="pdfBatchSubtitle">先预览匹配结果，确认后才会上传到 GitHub</p></div>' +
        '<button class="cover-search-close" id="pdfBatchClose" type="button" aria-label="关闭">×</button>' +
      '</div>' +
      '<div class="pdf-batch-body" id="pdfBatchBody">' + content + '</div>' +
    '</div>';
  document.body.appendChild(overlay);
  $('pdfBatchClose').onclick = closePdfBatchModal;
  overlay.onclick = (event) => {
    if (event.target === overlay && !pdfFlow.busy) closePdfBatchModal();
  };
}

function closePdfBatchModal() {
  if (pdfFlow.busy) return;
  const overlay = $('pdfBatchOverlay');
  if (overlay) overlay.remove();
}

async function startPdfBatchUpload() {
  if (!state.books.length) return showToast('当前没有可匹配的书籍', 'error');
  try {
    await ensureCoverService();
  } catch (error) {
    return showToast(error.message, 'error', 7000);
  }
  const input = $('pdfBatchInput');
  input.value = '';
  input.click();
}

async function preparePdfBatch(file) {
  if (!file) return;
  if (!/\.zip$/i.test(file.name)) return showToast('请选择 ZIP 压缩包', 'error');
  if (file.size > 100 * 1024 * 1024) return showToast('ZIP 超过 100MB，请拆分后重试', 'error');
  pdfFlow.busy = true;
  openPdfBatchModal('<div class="cover-search-status"><div><div class="spinner"></div>正在读取 ZIP 并匹配书名…</div></div>');
  try {
    const result = await coverServiceRequest('/api/pdfs/archive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/zip' },
      body: file,
    });
    const matched = matchPdfFiles(result.files || []);
    pdfFlow.archiveId = result.archiveId;
    pdfFlow.matches = matched.matches;
    pdfFlow.unmatched = matched.unmatched;
    pdfFlow.duplicates = matched.duplicates;
    pdfFlow.busy = false;
    renderPdfBatchPreview();
  } catch (error) {
    pdfFlow.busy = false;
    $('pdfBatchBody').innerHTML =
      '<div class="cover-search-status"><div><strong>读取失败</strong><br><br>' + escapeHtml(error.message) +
      '<br><br><button class="btn btn-secondary" onclick="closePdfBatchModal()">关闭</button></div></div>';
  }
}

function renderPdfBatchPreview() {
  const matches = pdfFlow.matches;
  const unmatched = pdfFlow.unmatched;
  const duplicates = pdfFlow.duplicates;
  const rows = matches.map(({ file, book }) =>
    '<tr id="pdf-row-' + escapeHtml(book.id) + '">' +
      '<td><span class="pdf-status-dot">待上传</span></td>' +
      '<td><strong>《' + escapeHtml(book.title) + '》</strong><small>' + escapeHtml(book.author || '') + '</small></td>' +
      '<td>' + escapeHtml(file.filename) + '<small>' + formatFileSize(file.size) +
        ((book.pdf || book.pdfUrl) ? ' · 将替换当前 PDF 引用' : '') + '</small></td>' +
    '</tr>'
  ).join('');
  const unmatchedHtml = unmatched.length
    ? '<details class="pdf-unmatched"><summary>' + unmatched.length + ' 个文件没有匹配到书籍</summary><p>' +
      unmatched.map((file) => escapeHtml(file.filename)).join('<br>') + '</p></details>'
    : '';
  $('pdfBatchBody').innerHTML =
    '<div class="pdf-summary-grid">' +
      '<div><strong>' + matches.length + '</strong><span>成功匹配</span></div>' +
      '<div><strong>' + unmatched.length + '</strong><span>未匹配</span></div>' +
      '<div><strong>' + duplicates.length + '</strong><span>重复已去除</span></div>' +
    '</div>' +
    (matches.length
      ? '<div class="pdf-table-wrap"><table class="pdf-match-table"><thead><tr><th>状态</th><th>后台书籍</th><th>ZIP 文件</th></tr></thead><tbody>' + rows + '</tbody></table></div>'
      : '<div class="cover-search-status"><div>没有找到可上传的匹配项。</div></div>') +
    unmatchedHtml +
    '<div class="pdf-batch-footer"><p>确认后将逐本上传 PDF，全部完成时统一更新 data.json。旧 PDF 文件不会删除。</p>' +
      '<div><button class="btn btn-secondary" id="pdfCancelBtn">取消</button>' +
      (matches.length ? '<button class="btn btn-primary" id="pdfConfirmBtn">确认上传 ' + matches.length + ' 本</button>' : '') + '</div></div>';
  $('pdfCancelBtn').onclick = closePdfBatchModal;
  if ($('pdfConfirmBtn')) $('pdfConfirmBtn').onclick = uploadMatchedPdfs;
}

function updatePdfRow(bookId, status, type) {
  const row = $('pdf-row-' + bookId);
  if (!row) return;
  const dot = row.querySelector('.pdf-status-dot');
  dot.textContent = status;
  dot.className = 'pdf-status-dot ' + (type || '');
}

async function fetchTemporaryPdf(fileMeta) {
  const response = await fetch('/api/pdfs/file?id=' + encodeURIComponent(fileMeta.id), { cache: 'no-store' });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || '读取 PDF 失败：HTTP ' + response.status);
  }
  return new File([await response.blob()], fileMeta.filename, { type: 'application/pdf' });
}

async function uploadPdfForBook(fileMeta, book) {
  const file = await fetchTemporaryPdf(fileMeta);
  const assetPath = 'assets/pdfs/book-' + book.id + '-pdf-' + Date.now() + '.pdf';
  await gh.putFile(assetPath, await fileToBase64(file), '上传 pdf: ' + book.title);
  return 'https://raw.githubusercontent.com/' + state.repo + '/' + state.branch + '/' + assetPath;
}

async function savePdfReferences(completed) {
  if (!completed.length) return;
  const urls = new Map(completed.map((item) => [String(item.book.id), item.url]));
  const mergePdfs = (books) => books.map((book) => {
    const url = urls.get(String(book.id));
    return url ? { ...book, pdf: url, pdfUrl: url } : book;
  });
  state.books = mergePdfs(state.books);
  try {
    await gh.saveBooks(state.books, '批量更新 ' + completed.length + ' 本书的 PDF');
  } catch (error) {
    if (error.status !== 409) throw error;
    state.books = mergePdfs(await gh.loadBooks());
    await gh.saveBooks(state.books, '批量更新 ' + completed.length + ' 本书的 PDF');
  }
}

async function uploadMatchedPdfs() {
  if (pdfFlow.busy || !pdfFlow.matches.length) return;
  pdfFlow.busy = true;
  $('pdfBatchClose').disabled = true;
  $('pdfCancelBtn').disabled = true;
  $('pdfConfirmBtn').disabled = true;
  const completed = [];
  let failure = null;
  for (let index = 0; index < pdfFlow.matches.length; index += 1) {
    const item = pdfFlow.matches[index];
    updatePdfRow(item.book.id, '上传中 ' + (index + 1) + '/' + pdfFlow.matches.length, 'working');
    showSaveStatus('正在上传《' + item.book.title + '》的 PDF（' + (index + 1) + '/' + pdfFlow.matches.length + '）…');
    try {
      const url = await uploadPdfForBook(item.file, item.book);
      completed.push({ book: item.book, url });
      updatePdfRow(item.book.id, '已上传', 'success');
    } catch (error) {
      failure = { item, error };
      updatePdfRow(item.book.id, '失败', 'error');
      break;
    }
  }

  try {
    if (completed.length) {
      showSaveStatus('正在统一更新 data.json…');
      await savePdfReferences(completed);
      await loadBookList();
    }
    pdfFlow.busy = false;
    $('pdfBatchClose').disabled = false;
    const footer = document.querySelector('.pdf-batch-footer');
    if (footer) {
      footer.innerHTML = failure
        ? '<p>已成功保存 ' + completed.length + ' 本；《' + escapeHtml(failure.item.book.title) + '》上传失败：' + escapeHtml(failure.error.message) + '</p><div><button class="btn btn-secondary" id="pdfDoneBtn">关闭后可重新选择 ZIP 继续</button></div>'
        : '<p>✓ 已上传并保存 ' + completed.length + ' 本书的 PDF，Vercel 将自动部署。</p><div><button class="btn btn-primary" id="pdfDoneBtn">完成</button></div>';
      $('pdfDoneBtn').onclick = closePdfBatchModal;
    }
    showSaveStatus(failure ? '部分 PDF 已保存' : '✓ PDF 批量上传完成', failure ? 'error' : 'success');
    showToast(failure ? '上传中断，已保存成功的部分' : '✓ PDF 批量上传完成', failure ? 'error' : 'success', 6000);
  } catch (error) {
    pdfFlow.busy = false;
    $('pdfBatchClose').disabled = false;
    showSaveStatus('✗ data.json 更新失败', 'error');
    showToast('PDF 已上传，但引用保存失败：' + error.message, 'error', 8000);
  }
}

/* ── 自动搜索封面 ── */
async function coverServiceRequest(path, options) {
  let response;
  try {
    response = await fetch(path, { cache: 'no-store', ...(options || {}) });
  } catch {
    throw new Error('封面服务未启动。请关闭当前页面，双击“启动管理后台.cmd”后再试。');
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || ('封面服务错误：HTTP ' + response.status));
  return body;
}

async function ensureCoverService() {
  if (location.protocol === 'file:') {
    throw new Error('自动封面功能不能在 file:// 页面运行。请双击“启动管理后台.cmd”打开后台。');
  }
  await coverServiceRequest('/api/covers/health');
}

function searchCoverForCurrentBook() {
  const title = $('field-title').value.trim();
  const author = $('field-author').value.trim();
  if (!title) return showToast('请先填写书名', 'error');
  openCoverSearch('single', [{
    ...(state.currentBook || {}),
    id: parseInt($('field-id').value) || (state.currentBook && state.currentBook.id),
    title,
    author,
    originalTitle: $('field-originalTitle').value.trim(),
    cover: state.uploadedUrls.cover || (state.currentBook && (state.currentBook.cover || state.currentBook.coverUrl)) || '',
  }]);
}

function startCoverBatch() {
  if (!state.books.length) return showToast('当前没有可处理的书籍', 'error');
  const books = state.books.slice().sort((a, b) => (a.id || 999) - (b.id || 999));
  openCoverSearch('batch', books);
}

async function openCoverSearch(mode, books) {
  try {
    await ensureCoverService();
  } catch (error) {
    return showToast(error.message, 'error', 7000);
  }
  document.querySelectorAll('.modal-overlay').forEach((item) => item.remove());
  coverFlow.mode = mode;
  coverFlow.books = books;
  coverFlow.index = 0;
  coverFlow.offset = 0;
  coverFlow.hasMore = false;
  coverFlow.busy = false;

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'coverSearchOverlay';
  overlay.innerHTML =
    '<div class="modal-card cover-search-modal" role="dialog" aria-modal="true" aria-labelledby="coverSearchTitle">' +
      '<div class="cover-search-head">' +
        '<div><div class="cover-search-kicker" id="coverSearchKicker">Cover Finder</div>' +
        '<h2 id="coverSearchTitle">自动搜索封面</h2><p id="coverSearchSubtitle"></p></div>' +
        '<button class="cover-search-close" type="button" aria-label="关闭">×</button>' +
      '</div>' +
      '<div class="cover-search-body" id="coverSearchBody"></div>' +
    '</div>';
  document.body.appendChild(overlay);
  overlay.querySelector('.cover-search-close').onclick = closeCoverSearch;
  overlay.onclick = (event) => {
    if (event.target === overlay && !coverFlow.busy) closeCoverSearch();
  };
  await loadCoverCandidates();
}

function closeCoverSearch() {
  if (coverFlow.busy) return;
  const overlay = $('coverSearchOverlay');
  if (overlay) overlay.remove();
}

function currentCoverBook() {
  return coverFlow.books[coverFlow.index];
}

function renderCoverFooter() {
  const batch = coverFlow.mode === 'batch';
  const total = coverFlow.books.length;
  const done = batch ? coverFlow.index : 0;
  const progress = batch ? Math.round((done / total) * 100) : 0;
  return '<div class="cover-search-footer">' +
    (batch
      ? '<div class="cover-search-progress" title="已完成 ' + done + ' / ' + total + '"><span style="width:' + progress + '%"></span></div>'
      : '<span></span>') +
    '<div class="cover-search-footer-actions">' +
      '<button class="btn btn-secondary" type="button" id="coverSkipBtn">' + (batch ? '跳过这本' : '取消') + '</button>' +
      '<button class="btn btn-secondary" type="button" id="coverMoreBtn"' + (coverFlow.hasMore ? '' : ' disabled') + '>换一批</button>' +
    '</div></div>';
}

function bindCoverFooter() {
  const skip = $('coverSkipBtn');
  const more = $('coverMoreBtn');
  if (skip) skip.onclick = skipCurrentCover;
  if (more) more.onclick = nextCoverPage;
}

async function loadCoverCandidates() {
  const book = currentCoverBook();
  if (!book) return finishCoverBatch();
  coverFlow.busy = true;
  $('coverSearchKicker').textContent = coverFlow.mode === 'batch'
    ? 'Cover Finder · ' + (coverFlow.index + 1) + ' / ' + coverFlow.books.length
    : 'Cover Finder';
  $('coverSearchTitle').textContent = '为《' + book.title + '》选择封面';
  $('coverSearchSubtitle').textContent = book.author || '未填写作者';
  $('coverSearchBody').innerHTML =
    '<div class="cover-search-status"><div><div class="spinner"></div>正在从豆瓣和百度搜索候选封面…</div></div>';

  try {
    const params = new URLSearchParams({
      title: book.title || '',
      author: book.author || '',
      originalTitle: book.originalTitle || '',
      offset: String(coverFlow.offset),
    });
    const result = await coverServiceRequest('/api/covers/search?' + params);
    coverFlow.hasMore = Boolean(result.hasMore);
    renderCoverCandidates(result.candidates || [], book);
  } catch (error) {
    $('coverSearchBody').innerHTML =
      '<div class="cover-search-status"><div><strong>搜索失败</strong><br><br>' +
      escapeHtml(error.message) +
      '<br><br><button class="btn btn-secondary" id="coverRetryBtn">重试</button></div></div>' +
      renderCoverFooter();
    $('coverRetryBtn').onclick = loadCoverCandidates;
    bindCoverFooter();
  } finally {
    coverFlow.busy = false;
  }
}

function renderCoverCandidates(items, book) {
  const currentUrl = book.cover || book.coverUrl || '';
  const currentNote = currentUrl
    ? '<div class="cover-current-note"><img src="' + escapeHtml(currentUrl) + '" alt=""><span>当前已有封面。确认新封面后只更新引用，旧文件仍保留。</span></div>'
    : '<div class="cover-current-note"><span>当前没有封面，请从候选结果中选择一张。</span></div>';
  const cards = items.map((item) =>
    '<button class="cover-candidate" type="button" data-cover-id="' + escapeHtml(item.id) + '">' +
      '<img src="' + escapeHtml(item.previewUrl) + '" alt="' + escapeHtml(item.title || book.title) + '" loading="lazy">' +
      '<div class="cover-candidate-meta">' +
        '<div class="cover-candidate-title">' + escapeHtml(item.title || book.title) + '</div>' +
        '<div class="cover-candidate-source">' +
          escapeHtml([item.author, item.year, item.source].filter(Boolean).join(' · ')) +
        '</div>' +
      '</div>' +
    '</button>'
  ).join('');
  const content = items.length
    ? '<div class="cover-candidate-grid">' + cards + '</div>'
    : '<div class="cover-search-status"><div>这一批没有找到可用封面。<br><br>' +
      '<button class="btn btn-secondary" id="coverRetryEmptyBtn">重新搜索</button></div></div>';
  $('coverSearchBody').innerHTML = currentNote + content + renderCoverFooter();
  document.querySelectorAll('.cover-candidate').forEach((button) => {
    button.onclick = () => chooseCoverCandidate(button.dataset.coverId);
  });
  const retry = $('coverRetryEmptyBtn');
  if (retry) retry.onclick = loadCoverCandidates;
  bindCoverFooter();
}

async function nextCoverPage() {
  if (coverFlow.busy || !coverFlow.hasMore) return;
  coverFlow.offset += 5;
  await loadCoverCandidates();
}

async function skipCurrentCover() {
  if (coverFlow.busy) return;
  if (coverFlow.mode === 'single') return closeCoverSearch();
  coverFlow.index += 1;
  coverFlow.offset = 0;
  if (coverFlow.index >= coverFlow.books.length) return finishCoverBatch();
  await loadCoverCandidates();
}

function base64ToFile(base64, filename, mime) {
  const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  return new File([bytes], filename, { type: mime });
}

async function chooseCoverCandidate(candidateId) {
  if (coverFlow.busy) return;
  coverFlow.busy = true;
  const book = currentCoverBook();
  $('coverSearchBody').innerHTML =
    '<div class="cover-search-status"><div><div class="spinner"></div>' +
    (coverFlow.mode === 'batch' ? '正在上传封面并更新 data.json…' : '正在准备封面预览…') +
    '</div></div>';
  try {
    const result = await coverServiceRequest('/api/covers/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: candidateId }),
    });
    const filename = 'book-' + (book.id || 'new') + '-cover.' + result.extension;
    const file = base64ToFile(result.data, filename, result.mime);

    if (coverFlow.mode === 'single') {
      handleFile(file, 'cover');
      coverFlow.busy = false;
      closeCoverSearch();
      showToast('已选择封面，保存书籍时会上传到 GitHub', 'success', 4500);
      return;
    }

    showSaveStatus('正在上传《' + book.title + '》的封面…');
    const coverUrl = await uploadCoverForBook(file, book);
    const updatedBook = await saveCoverReference(book, coverUrl);
    coverFlow.books[coverFlow.index] = updatedBook;
    showSaveStatus('✓ 已更新《' + book.title + '》', 'success');
    coverFlow.index += 1;
    coverFlow.offset = 0;
    coverFlow.busy = false;
    if (coverFlow.index >= coverFlow.books.length) return finishCoverBatch();
    await loadCoverCandidates();
  } catch (error) {
    coverFlow.busy = false;
    $('coverSearchBody').innerHTML =
      '<div class="cover-search-status"><div><strong>处理失败</strong><br><br>' +
      escapeHtml(error.message) +
      '<br><br><button class="btn btn-secondary" id="coverRetryCurrentBtn">重新搜索</button></div></div>';
    $('coverRetryCurrentBtn').onclick = loadCoverCandidates;
    showSaveStatus('✗ 封面更新失败', 'error');
  }
}

async function uploadCoverForBook(file, book) {
  const extension = file.name.split('.').pop().toLowerCase();
  const filename = 'book-' + book.id + '-cover-' + Date.now() + '.' + extension;
  const assetPath = 'assets/covers/' + filename;
  await gh.putFile(
    assetPath,
    await fileToBase64(file),
    '上传 cover: ' + book.title
  );
  return 'https://raw.githubusercontent.com/' + state.repo + '/' + state.branch + '/' + assetPath;
}

async function saveCoverReference(book, coverUrl) {
  const mergeCover = (books) => {
    let updatedBook = null;
    const mergedBooks = books.map((item) => {
      if (String(item.id) !== String(book.id)) return item;
      updatedBook = { ...item, cover: coverUrl };
      return updatedBook;
    });
    if (!updatedBook) {
      updatedBook = { ...book, cover: coverUrl };
      mergedBooks.push(updatedBook);
    }
    return { mergedBooks, updatedBook };
  };

  let merged = mergeCover(state.books);
  state.books = merged.mergedBooks;
  try {
    await gh.saveBooks(state.books, '更新封面：' + book.title);
    return merged.updatedBook;
  } catch (error) {
    if (error.status !== 409) throw error;
    const latestBooks = await gh.loadBooks();
    merged = mergeCover(latestBooks);
    state.books = merged.mergedBooks;
    await gh.saveBooks(state.books, '更新封面：' + book.title);
    return merged.updatedBook;
  }
}

function finishCoverBatch() {
  coverFlow.busy = false;
  const overlay = $('coverSearchOverlay');
  if (overlay) overlay.remove();
  renderBookList();
  showToast('封面队列已处理完成', 'success', 4500);
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
$('pdfBatchInput').addEventListener('change', (event) => preparePdfBatch(event.target.files[0]));

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
