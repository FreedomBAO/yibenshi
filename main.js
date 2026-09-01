/* ──────────────────────────────────────────────────
   每天精读一本书 - 主脚本 v2
   功能：今日推荐 / 搜索筛选 / 音频播放 / 换一本 / 分享卡片
        / 详情弹窗 / 主题切换 / 键盘快捷键
   ────────────────────────────────────────────────── */

/* ── 主题定义 ── */
const THEMES = {
  default: {
    name: '晨读·米色',
    '--bg':            '#F4EFE6',
    '--card-bg':       '#FFFFFF',
    '--header-bg':     '#141410',
    '--accent':        '#8B1A1A',
    '--accent-light':  '#B52828',
    '--text-primary':  '#1C1C1A',
    '--text-secondary':'#6B6560',
    '--text-light':    '#9B9590',
    '--border':        '#E0D9CF',
  },
  forest: {
    name: '林间·森绿',
    '--bg':            '#E8EFE5',
    '--card-bg':       '#FFFFFF',
    '--header-bg':     '#1A2E1F',
    '--accent':        '#2D5A3D',
    '--accent-light':  '#3E7A52',
    '--text-primary':  '#1A2418',
    '--text-secondary':'#5A6358',
    '--text-light':    '#8A938A',
    '--border':        '#D0D9CD',
  },
  ocean: {
    name: '夜读·深蓝',
    '--bg':            '#EEF2F7',
    '--card-bg':       '#FFFFFF',
    '--header-bg':     '#0F1A2E',
    '--accent':        '#1E4A8C',
    '--accent-light':  '#2A6BC2',
    '--text-primary':  '#0F1A2E',
    '--text-secondary':'#5A6378',
    '--text-light':    '#8A93A8',
    '--border':        '#D2D9E4',
  },
  sunset: {
    name: '活力·暖橙',
    '--bg':            '#FDF3EC',
    '--card-bg':       '#FFFFFF',
    '--header-bg':     '#2E1A14',
    '--accent':        '#D9542C',
    '--accent-light':  '#F26A3A',
    '--text-primary':  '#1F1410',
    '--text-secondary':'#6B554E',
    '--text-light':    '#9A847C',
    '--border':        '#E8D8CC',
  },
};

const PALETTE = [
  '#5C3D2E', '#2C4A3E', '#2E3A5C', '#4A2C4E',
  '#3E2C2C', '#2C3E2C', '#3C3528', '#1E3A4A',
];

const CATEGORY_ORDER = [
  '认知与心理', '个人成长', '学习方法', '商业与创新', '金融与经济',
  '决策与系统', '沟通与关系', '科技与未来', '历史与文明', '哲学与思辨',
];

function colorForId(id) {
  return PALETTE[(id - 1) % PALETTE.length];
}

function formatDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });
}

function tagsHtml(tags, cls = 'tag-chip') {
  return (tags || []).map(t => `<span class="${cls}">${t}</span>`).join('');
}

function categoryTags(book) {
  return book.category ? [book.category] : [];
}

function coverBackground(book, fallbackColor) {
  const coverUrl = book.cover || book.coverUrl;
  return coverUrl
    ? `${fallbackColor} url('${coverUrl}') center / contain no-repeat`
    : fallbackColor;
}

/* ── 主题切换 ── */
function applyTheme(themeName) {
  const theme = THEMES[themeName] || THEMES.default;
  const root = document.documentElement;
  Object.entries(theme).forEach(([k, v]) => {
    if (k !== 'name') root.style.setProperty(k, v);
  });
  localStorage.setItem('yibenshi-theme', themeName);
  // 更新按钮状态
  document.querySelectorAll('.theme-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.theme === themeName);
  });
}

function initTheme() {
  const saved = localStorage.getItem('yibenshi-theme') || 'default';
  applyTheme(saved);
}

function renderThemeSwitcher() {
  const container = document.getElementById('themeSwitcher');
  if (!container) return;
  container.innerHTML = Object.entries(THEMES).map(([key, t]) =>
    `<button class="theme-btn ${key === 'default' ? 'active' : ''}" data-theme="${key}" onclick="applyTheme('${key}')" aria-label="${t.name}" title="${t.name}">
      <span class="theme-swatch" style="background:${t['--accent']}"></span>
      <span class="theme-name">${t.name}</span>
    </button>`
  ).join('');
}

/* ── Audio Player ── */
function audioPlayerHtml(book, prefix = '') {
  const id = `player-${prefix}${book.id}`;
  const audioUrl = book.audio || book.audioUrl;
  // 如果有真实音频文件，用真实播放；否则显示 Coming Soon
  const hasReal = audioUrl && !audioUrl.endsWith('.mp3') === false;
  if (hasReal) {
    return `
      <div class="audio-player" id="${id}">
        <button class="play-btn" onclick="togglePlay('${id}', '${audioUrl}', '${book.duration}')" aria-label="播放/暂停">
          <svg class="icon-play" viewBox="0 0 16 16"><polygon points="3,1 15,8 3,15"/></svg>
          <svg class="icon-pause" viewBox="0 0 16 16"><rect x="2" y="1" width="4" height="14"/><rect x="10" y="1" width="4" height="14"/></svg>
        </button>
        <div class="audio-info">
          <div class="audio-label">精读音频</div>
          <div class="audio-progress-bar" onclick="seekAudio(event, '${id}')">
            <div class="audio-progress-fill" id="${id}-fill"></div>
          </div>
        </div>
        <div class="audio-duration" id="${id}-time">${book.duration}</div>
      </div>`;
  }
  return `
    <div class="audio-player" id="${id}">
      <button class="play-btn" onclick="showComingSoon('${book.title} 的精读音频')" aria-label="播放/暂停">
        <svg class="icon-play" viewBox="0 0 16 16"><polygon points="3,1 15,8 3,15"/></svg>
        <svg class="icon-pause" viewBox="0 0 16 16"><rect x="2" y="1" width="4" height="14"/><rect x="10" y="1" width="4" height="14"/></svg>
      </button>
      <div class="audio-info">
        <div class="audio-label">精读音频</div>
        <div class="audio-progress-bar" onclick="showComingSoon('${book.title} 的精读音频')">
          <div class="audio-progress-fill"></div>
        </div>
      </div>
      <div class="audio-duration">${book.duration}</div>
    </div>`;
}

/* ── 详情按钮 ── */
function detailBtnHtml(book) {
  return `
    <button class="detail-btn" onclick="openDetailModal(${book.id})" aria-label="查看详情">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
        <circle cx="8" cy="8" r="6"/>
        <line x1="8" y1="6" x2="8" y2="11"/>
        <circle cx="8" cy="4" r="0.5" fill="currentColor"/>
      </svg>
      查看详情
    </button>`;
}

/* ── 分享按钮 ── */
function shareBtnHtml(book) {
  return `
    <button class="share-btn" onclick="openShareModal(${book.id})" aria-label="生成分享卡片">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M12 2v9M9 5l3-3 3 3"/>
        <path d="M12 11v2H3V4h3"/>
      </svg>
      生成分享卡
    </button>`;
}

/* ── PDF 按钮 ── */
function pdfBtnHtml(book) {
  const pdfUrl = book.pdf || book.pdfUrl;
  if (pdfUrl) {
    return `
      <a class="pdf-btn" href="${pdfUrl}" target="_blank" rel="noopener">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M3 1h7l3 3v11H3V1z"/>
          <path d="M10 1v3h3"/>
          <line x1="6" y1="8" x2="10" y2="8"/>
          <line x1="6" y1="11" x2="10" y2="11"/>
        </svg>
        下载精读笔记
      </a>`;
  }
  return `
    <button class="pdf-btn" onclick="showComingSoon('${book.title} 的精读笔记 PDF')" aria-label="下载精读笔记">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M3 1h7l3 3v11H3V1z"/>
        <path d="M10 1v3h3"/>
        <line x1="6" y1="8" x2="10" y2="8"/>
        <line x1="6" y1="11" x2="10" y2="11"/>
      </svg>
      下载精读笔记
    </button>`;
}

/* ── Hero ── */
function renderHero(book) {
  const section = document.getElementById('heroSection');
  const color = colorForId(book.id);
  section.innerHTML = `
    <div class="hero-eyebrow">
      今日推荐
      <button class="refresh-btn" onclick="refreshToday()" aria-label="换一本">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M14 8a6 6 0 1 1-1.76-4.24"/>
          <path d="M14 3v4h-4"/>
        </svg>
        换一本
      </button>
    </div>
    <div class="hero-card" onclick="openDetailModal(${book.id})" role="button" tabindex="0" onkeydown="if(event.key==='Enter')openDetailModal(${book.id})">
      <div class="hero-color-block" style="background:${coverBackground(book, color)}">
        <div class="hero-book-number">${String(book.id).padStart(2, '0')}</div>
        <div class="hero-tag">今日精读</div>
        <div class="hero-title-block">
          <div class="hero-book-title">${book.title}</div>
          <div class="hero-book-author">${book.originalTitle} · ${book.author}</div>
        </div>
      </div>
      <div class="hero-content">
        <div>
          <div class="hero-section-label">每日书评</div>
          <div class="hero-description"><p>${book.description}</p></div>
          <div class="hero-meta">
            <span class="hero-date">${formatDate(book.date)}</span>
            <div class="tag-chips">${tagsHtml(categoryTags(book))}</div>
          </div>
        </div>
        <div class="hero-actions" onclick="event.stopPropagation()">
          ${audioPlayerHtml(book, 'hero-')}
          ${pdfBtnHtml(book)}
          ${shareBtnHtml(book)}
        </div>
      </div>
    </div>`;
  const card = section.querySelector('.hero-card');
  if (card) {
    card.style.animation = 'none';
    card.offsetHeight;
    card.style.animation = '';
  }
}

/* ── 卡片（卡片本身也可点击展开详情） ── */
function bookCardHtml(book, i) {
  const color = colorForId(book.id);
  const delay = (i * 0.08).toFixed(2);
  return `
    <div class="book-card" style="animation-delay:${delay}s" onclick="openDetailModal(${book.id})" role="button" tabindex="0" onkeydown="if(event.key==='Enter')openDetailModal(${book.id})">
      <div class="card-color-block" style="background:${coverBackground(book, color)}">
        <div class="card-book-index">${String(book.id).padStart(2, '0')}</div>
        <div class="card-title-in-block">
          <div class="card-book-title">${book.title}</div>
          <div class="card-book-author">${book.author}</div>
        </div>
      </div>
      <div class="card-body">
        <div class="card-date">${formatDate(book.date)}</div>
        <div class="card-description">${book.description}</div>
        <div class="card-tags">${tagsHtml(categoryTags(book), 'tag-chip')}</div>
        <div class="card-actions" onclick="event.stopPropagation()">
          ${audioPlayerHtml(book)}
          ${pdfBtnHtml(book)}
          ${shareBtnHtml(book)}
          ${detailBtnHtml(book)}
        </div>
      </div>
    </div>`;
}

/* ── 列表渲染 ── */
const ARCHIVE_PAGE_SIZE = 20;
function renderChunked(container, items, renderItem, opts = {}) {
  const size = opts.pageSize || ARCHIVE_PAGE_SIZE;
  let shown = Math.min(size, items.length);
  const draw = () => {
    const html = items.slice(0, shown).map(renderItem).join('');
    const remaining = items.length - shown;
    const btnHtml = remaining > 0
      ? `<button type="button" class="chunk-toggle-btn" id="chunkToggle">▼ 显示下 ${Math.min(size, remaining)} 本（剩 ${remaining}）</button>`
      : '';
    container.innerHTML = html + btnHtml;
    const btn = document.getElementById('chunkToggle');
    if (btn) btn.onclick = () => { shown = Math.min(shown + size, items.length); draw(); };
  };
  draw();
}

function renderArchive(books) {
  const grid = document.getElementById('booksGrid');
  if (!books.length) {
    grid.innerHTML = `
      <div class="empty-archive-state" style="grid-column:1/-1;text-align:center;padding:60px 20px;">
        <div style="font-size:48px;margin-bottom:16px;opacity:0.4;">📚</div>
        <p style="font-family:var(--font-serif);font-size:16px;color:var(--text-secondary);margin-bottom:8px;">暂无匹配的书籍</p>
        <p style="font-size:13px;color:var(--text-light);">试试其他关键词或分类</p>
      </div>`;
    return;
  }
  renderChunked(grid, books, (book, i) => bookCardHtml(book, i));
}

/* ── 固定分类筛选 ── */
function renderFilterChips(books) {
  const present = new Set(books.map(book => book.category).filter(Boolean));
  const categories = CATEGORY_ORDER.filter(category => present.has(category));
  const container = document.getElementById('filterChips');
  container.innerHTML = `
    <button class="filter-chip active" data-category="" aria-pressed="true">全部</button>
    ${categories.map(category => `<button class="filter-chip" data-category="${category}" aria-pressed="false">${category}</button>`).join('')}
  `;
  container.addEventListener('click', e => {
    const chip = e.target.closest('.filter-chip');
    if (!chip) return;
    container.querySelectorAll('.filter-chip').forEach(c => {
      c.classList.remove('active');
      c.setAttribute('aria-pressed', 'false');
    });
    chip.classList.add('active');
    chip.setAttribute('aria-pressed', 'true');
    applyFilter();
  });
}

/* ── 全局状态 ── */
let _allBooks = [];
let _todayBook = null;
let _archiveBooks = [];
let _activeCategory = '';
let _searchQuery = '';

function applyFilter() {
  const chip = document.querySelector('.filter-chip.active');
  _activeCategory = chip ? chip.dataset.category : '';
  _searchQuery = document.getElementById('searchInput').value.trim().toLowerCase();

  let filtered = _archiveBooks;
  if (_activeCategory) {
    filtered = filtered.filter(b => b.category === _activeCategory);
  }
  if (_searchQuery) {
    filtered = filtered.filter(b =>
      b.title.toLowerCase().includes(_searchQuery) ||
      (b.originalTitle || '').toLowerCase().includes(_searchQuery) ||
      b.author.toLowerCase().includes(_searchQuery) ||
      b.description.toLowerCase().includes(_searchQuery) ||
      (b.category || '').toLowerCase().includes(_searchQuery)
    );
  }

  renderArchive(filtered);
  document.getElementById('archiveCount').textContent = `${filtered.length} 本`;
  document.getElementById('emptySearch').style.display = 'none';
  document.getElementById('booksGrid').style.display = '';
}

function initSearch() {
  const input = document.getElementById('searchInput');
  const clearBtn = document.getElementById('searchClear');
  input.addEventListener('input', () => {
    clearBtn.classList.toggle('visible', input.value.length > 0);
    applyFilter();
  });
  clearBtn.addEventListener('click', () => {
    input.value = '';
    clearBtn.classList.remove('visible');
    applyFilter();
    input.focus();
  });
}

/* ── 换一本 ── */
function refreshToday() {
  if (!_allBooks.length) return;
  const candidates = _allBooks.filter(b => b.id !== (_todayBook && _todayBook.id));
  if (!candidates.length) return;
  const pick = candidates[Math.floor(Math.random() * candidates.length)];
  _todayBook = pick;
  renderHero(pick);
  bindKeyboardShortcuts();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ──────────────────────────────────────
   详情弹窗（Detail Modal）
   ────────────────────────────────────── */
function openDetailModal(bookId) {
  const book = _allBooks.find(b => b.id === bookId);
  if (!book) return;
  closeAllModals();

  const color = colorForId(book.id);
  const modal = document.createElement('div');
  modal.id = 'detailModal';
  modal.className = 'share-modal';
  modal.innerHTML = `
    <div class="share-modal-backdrop" onclick="closeAllModals()"></div>
    <div class="detail-modal-content" role="dialog" aria-modal="true">
      <button class="share-modal-close" onclick="closeAllModals()" aria-label="关闭">✕</button>
      <div class="detail-header" style="background:${color}">
        <div class="detail-header-no">No.${String(book.id).padStart(2, '0')}</div>
        <div class="detail-header-cat">${book.category || ''}</div>
        <h2 class="detail-title">${book.title}</h2>
        <div class="detail-original">${book.originalTitle || ''}</div>
        <div class="detail-author">— ${book.author}</div>
        <div class="detail-meta-row">
          <span class="detail-date">${formatDate(book.date)}</span>
          <span class="detail-rating">★ ${book.rating || '8.5'}</span>
          <span class="detail-duration">🕐 ${book.duration}</span>
        </div>
      </div>
      <div class="detail-body">
        <section class="detail-section">
          <h3 class="detail-section-title">深度书评</h3>
          <p class="detail-description">${book.description}</p>
        </section>

        <section class="detail-section">
          <h3 class="detail-section-title">核心要点</h3>
          <ul class="detail-highlights">
            ${(book.highlights || []).map(h => `<li>${h}</li>`).join('')}
          </ul>
        </section>

        <section class="detail-section detail-action-section">
          <h3 class="detail-section-title">行动建议</h3>
          <p class="detail-action">${book.action || '读完后，问自己：哪一点我今天就可以开始用？'}</p>
        </section>

        <section class="detail-section">
          <h3 class="detail-section-title">书籍分类</h3>
          <div class="detail-tags">${tagsHtml(categoryTags(book), 'detail-tag')}</div>
        </section>

        <div class="detail-actions">
          ${audioPlayerHtml(book, 'detail-')}
          ${pdfBtnHtml(book)}
          ${shareBtnHtml(book)}
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  document.body.style.overflow = 'hidden';
  setTimeout(() => modal.classList.add('visible'), 10);
}

function closeAllModals() {
  document.querySelectorAll('.share-modal').forEach(m => {
    m.classList.remove('visible');
    setTimeout(() => m.remove(), 200);
  });
  document.body.style.overflow = '';
}

/* ──────────────────────────────────────
   分享卡片（Share Card）
   ────────────────────────────────────── */
function openShareModal(bookId) {
  const book = _allBooks.find(b => b.id === bookId);
  if (!book) return;
  closeAllModals();

  const modal = document.createElement('div');
  modal.id = 'shareModal';
  modal.className = 'share-modal';
  modal.innerHTML = `
    <div class="share-modal-backdrop" onclick="closeAllModals()"></div>
    <div class="share-modal-content">
      <button class="share-modal-close" onclick="closeAllModals()" aria-label="关闭">✕</button>
      <h3 class="share-modal-title">生成分享卡片</h3>
      <p class="share-modal-sub">点击下方按钮生成精美卡片，可保存或分享给朋友</p>
      <div class="share-card-preview" id="shareCardPreview" style="background:${colorForId(book.id)}">
        <div class="share-card-inner">
          <div class="share-card-brand">每天精读一本书</div>
          <div class="share-card-no">No.${String(book.id).padStart(2, '0')}</div>
          <div class="share-card-title">${book.title}</div>
          <div class="share-card-original">${book.originalTitle || ''}</div>
          <div class="share-card-author">— ${book.author}</div>
          <div class="share-card-tags">${tagsHtml(categoryTags(book), 'share-card-tag')}</div>
          <div class="share-card-footer">
            <span class="share-card-date">${formatDate(book.date)}</span>
            <span class="share-card-rating">★ ${book.rating || '8.5'}</span>
          </div>
        </div>
      </div>
      <button class="share-modal-btn" onclick="generateShareImage(${book.id})">
        ⬇ 下载为图片
      </button>
    </div>
  `;
  document.body.appendChild(modal);
}

function generateShareImage(bookId) {
  const book = _allBooks.find(b => b.id === bookId);
  if (!book) return;

  const node = document.getElementById('shareCardPreview');
  if (!node || typeof html2canvas === 'undefined') {
    alert('分享图库未加载，请刷新页面重试');
    return;
  }

  const btn = document.querySelector('.share-modal-btn');
  const originalText = btn.textContent;
  btn.textContent = '生成中...';
  btn.disabled = true;

  html2canvas(node, {
    backgroundColor: null,
    scale: 2,
    useCORS: true,
    logging: false
  }).then(canvas => {
    const link = document.createElement('a');
    link.download = `${book.title}-分享卡.png`;
    link.href = canvas.toDataURL('image/png');
    link.click();
    btn.textContent = '✓ 已下载';
    setTimeout(() => {
      btn.textContent = originalText;
      btn.disabled = false;
    }, 1500);
  }).catch(err => {
    console.error('生成分享图失败:', err);
    btn.textContent = originalText;
    btn.disabled = false;
    alert('生成失败，请重试');
  });
}

/* ── Coming Soon Toast ── */
function showComingSoon(resourceName) {
  const old = document.getElementById('comingSoonToast');
  if (old) old.remove();
  const toast = document.createElement('div');
  toast.id = 'comingSoonToast';
  toast.className = 'coming-soon-toast';
  toast.innerHTML = `
    <div class="toast-icon">✦</div>
    <div class="toast-text">
      <div class="toast-title">${resourceName || '资源'} 正在整理中</div>
      <div class="toast-sub">公众号「每天精读一本书」回复书名优先获取</div>
    </div>
  `;
  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('visible'));
  setTimeout(() => {
    toast.classList.remove('visible');
    setTimeout(() => toast.remove(), 300);
  }, 2600);
}

/* ── 键盘快捷键 ── */
function bindKeyboardShortcuts() {
  document.removeEventListener('keydown', _keyboardHandler);
  document.addEventListener('keydown', _keyboardHandler);
}

function _keyboardHandler(e) {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if (e.key === 'Escape') {
    closeAllModals();
    return;
  }
  if (e.key === ' ' || e.code === 'Space') {
    e.preventDefault();
    const player = document.querySelector('#heroSection .audio-player');
    if (player) {
      const btn = player.querySelector('.play-btn');
      if (btn) btn.click();
    }
  }
  if (e.key === 'r' || e.key === 'R') {
    refreshToday();
  }
}

/* ──────────────────────────────────────
   内置数据（file:// 下 fetch 会被拦截）
   ────────────────────────────────────── */
const BOOKS_DATA = [
  {
    "id": 1,
    "date": "2026-05-29",
    "title": "思考，快与慢",
    "originalTitle": "Thinking, Fast and Slow",
    "author": "丹尼尔·卡尼曼",
    "description": "诺贝尔经济学奖得主卡尼曼将毕生研究成果浓缩于此，深刻揭示了人类思维的两套系统：快速直觉的系统一与缓慢理性的系统二。书中列举了锚定效应、可得性启发、确认偏误等认知偏差，以及损失厌恶、框架效应等前景理论的核心概念。从决策清单到环境设计，每一章都教你识别并矫正自己思维中的陷阱。",
    "tags": [
      "认知心理",
      "决策系统",
      "行为经济学"
    ],
    "audioUrl": "audio/book-001.mp3",
    "pdfUrl": "pdf/book-001.pdf",
    "duration": "45:23",
    "rating": "9.0",
    "category": "认知与心理",
    "highlights": [
      "人类95%的决策依赖系统1（直觉），理性思考是稀缺资源",
      "过度依赖系统1会引发大量认知偏差",
      "刻意引入慢思考的标准化流程反而能降低错误率"
    ],
    "action": "本周做 1 个小决定时，刻意启动「慢思考」：列出 3 个支持/反对点再下结论。"
  },
  {
    "id": 2,
    "date": "2026-05-28",
    "title": "原则",
    "originalTitle": "Principles",
    "author": "瑞·达利欧",
    "description": "桥水基金创始人达利欧分享了他在生活和工作中总结的 500+ 条原则体系。核心是「极度求真 + 极度透明 + 系统化决策」。从「拥抱现实、应对现实」到「进化是宇宙中最强大的力量」，这些原则既是世界观，也是方法论——他用这套方法在四十年间打造出全球最大的对冲基金。",
    "tags": [
      "个人成长",
      "商业创新",
      "人生哲学"
    ],
    "audioUrl": "audio/book-002.mp3",
    "pdfUrl": "pdf/book-002.pdf",
    "duration": "52:10",
    "rating": "8.7",
    "category": "个人成长",
    "highlights": [
      "梦想 + 现实 + 决心 = 成功",
      "痛苦 + 反思 = 进步",
      "极度求真、极度透明的决策文化"
    ],
    "action": "从今天开始记录你做重大决策时的「原则」，一周后回看，沉淀你自己的判断框架。"
  },
  {
    "id": 3,
    "date": "2026-05-27",
    "title": "原子习惯",
    "originalTitle": "Atomic Habits",
    "author": "詹姆斯·克利尔",
    "description": "豆瓣 8.7 分的习惯养成方法论。作者克利尔提出「微小改变 × 时间复利 = 惊人结果」的核心理念。书中拆解了习惯形成的四大法则（提示、渴求、反应、奖励），并给出可直接落地的实操清单。这不是一本讲自律的书，而是一本教你「设计环境、让好习惯自然发生」的工具书。",
    "tags": [
      "个人成长",
      "认知心理",
      "方法论"
    ],
    "audioUrl": "audio/book-003.mp3",
    "pdfUrl": "pdf/book-003.pdf",
    "duration": "39:18",
    "rating": "8.7",
    "category": "个人成长",
    "highlights": [
      "身份认同驱动习惯，而非目标驱动",
      "环境设计 > 意志力消耗",
      "1% 的微小改进 × 365 天 = 37 倍提升"
    ],
    "action": "选 1 个你想养成的微习惯，把它绑定到已有习惯后面（提示-渴求-反应-奖励）。"
  },
  {
    "id": 4,
    "date": "2026-05-26",
    "title": "纳瓦尔宝典",
    "originalTitle": "The Almanack of Naval Ravikant",
    "author": "埃里克·乔根森 编",
    "description": "硅谷顶级天使投资人纳瓦尔的智慧合集。在不损害他人的前提下，为自己和社会创造持续的财富与幸福——这是全书的核心命题。15 个核心知识点拆解了财富篇（杠杆、判断力、复利）与幸福篇（欲望、习惯、内心富足）的底层逻辑。读完之后你会重新理解「时间复利」与「内在自由」的关系。",
    "tags": [
      "金融经济",
      "个人成长",
      "哲学思辨"
    ],
    "audioUrl": "audio/book-004.mp3",
    "pdfUrl": "pdf/book-004.pdf",
    "duration": "44:55",
    "rating": "8.6",
    "category": "金融与经济",
    "highlights": [
      "财富是睡着时仍能为你赚钱的资产",
      "代码和媒体是新一代「无需许可」的杠杆",
      "幸福是减去所有痛苦后的产物"
    ],
    "action": "列出你最擅长的 3 件事，找到「杠杆点」——怎样用更少的努力换更大的复利。"
  },
  {
    "id": 5,
    "date": "2026-05-25",
    "title": "深度工作",
    "originalTitle": "Deep Work",
    "author": "卡尔·纽波特",
    "description": "在注意力被全面肢解的时代，深度工作是你对抗平庸最锋利的武器。MIT 计算机博士、乔治城大学教授纽波特提出：深度工作不是苦行僧式的自我剥削，而是让你的每一份脑力都创造出不可替代的价值。书中给出大量可操作的方法——从时间块管理、仪式感建立到数字化断舍离。",
    "tags": [
      "个人成长",
      "学习方法",
      "效率"
    ],
    "audioUrl": "audio/book-005.mp3",
    "pdfUrl": "pdf/book-005.pdf",
    "duration": "41:30",
    "rating": "8.5",
    "category": "个人成长",
    "highlights": [
      "高质量工作产出 = 时间 × 专注度²",
      "深度工作能力越来越稀缺，越来越有价值",
      "无聊不是敌人，而是深度思考的入口"
    ],
    "action": "本周每天留 90 分钟「深度工作时间」：关微信、单任务、写下来要解决的问题。"
  },
  {
    "id": 6,
    "date": "2026-05-24",
    "title": "系统之美",
    "originalTitle": "Thinking in Systems",
    "author": "德内拉·梅多斯",
    "description": "系统思考领域的入门圣经，写给普通人的「看懂复杂世界」指南。作者梅多斯把生态学、系统工程的思维方式，转化为个人决策、职业发展、社会洞察都能用的「透视眼镜」。核心理念：事件是表面的、偶然的；结构是内在的、必然的——结构决定行为，行为引发事件。读完此书，你会从「被问题推着走」变成「看见系统的底层结构」。",
    "tags": [
      "决策系统",
      "认知心理",
      "方法论"
    ],
    "audioUrl": "audio/book-006.mp3",
    "pdfUrl": "pdf/book-006.pdf",
    "duration": "37:42",
    "rating": "8.9",
    "category": "决策与系统",
    "highlights": [
      "系统三大构件：要素、连接、目标",
      "12 种系统反馈回路，决定长期行为",
      "找到杠杆点：以小博大改变系统"
    ],
    "action": "找一个你正在解决的问题，画出它的反馈回路：谁是增强回路？谁是调节回路？"
  },
  {
    "id": 7,
    "date": "2026-05-23",
    "title": "从零到一",
    "originalTitle": "Zero to One",
    "author": "彼得·蒂尔",
    "description": "PayPal 创始人、硅谷顶级投资人彼得·蒂尔的创业哲学。核心理念：「从 0 到 1」（创新、创造垄断）远比「从 1 到 N」（复制、竞争）重要。书中拆解了「幂次法则」「最后生存者」「Definite Optimism」等创业思维，揭示了科技、创新、商业的本质规律。读完后你会重新审视「竞争」和「差异化」这两个词。",
    "tags": [
      "商业创新",
      "科技未来",
      "创业"
    ],
    "audioUrl": "audio/book-007.mp3",
    "pdfUrl": "pdf/book-007.pdf",
    "duration": "36:18",
    "rating": "8.4",
    "category": "商业与创新",
    "highlights": [
      "竞争是失败者的游戏，垄断是成功者的目标",
      "幂次法则：少数关键决策决定大部分结果",
      "Definite Optimism vs Indefinite Optimism"
    ],
    "action": "思考你所在的领域，「从 0 到 1」的机会是什么？写下 3 个别人没看到的差异化。"
  },
  {
    "id": 8,
    "date": "2026-05-22",
    "title": "黑天鹅",
    "originalTitle": "The Black Swan",
    "author": "纳西姆·塔勒布",
    "description": "理解极端事件的不确定性指南。「黑天鹅」指那些极少数发生却影响巨大的事件——2008 金融危机、9·11、新冠疫情。塔勒布颠覆了「正常 vs 异常」的二分法，提出我们生活在一个「极端斯坦」而非「平均斯坦」的世界。本书会彻底改变你看待风险、预测、规划的方式。",
    "tags": [
      "金融经济",
      "哲学思辨",
      "决策系统"
    ],
    "audioUrl": "audio/book-008.mp3",
    "pdfUrl": "pdf/book-008.pdf",
    "duration": "47:25",
    "rating": "8.2",
    "category": "金融与经济",
    "highlights": [
      "历史不是「爬行」，而是「跳跃」",
      "不要预测，要对冲（杠铃策略）",
      "我们永远低估了未知的未知"
    ],
    "action": "在你的生活/工作里，找出「最脆弱」的环节，给它加一道冗余（杠铃策略）。"
  },
  {
    "id": 9,
    "date": "2026-05-21",
    "title": "被讨厌的勇气",
    "originalTitle": "嫌われる勇気",
    "author": "岸见一郎 / 古贺史健",
    "description": "阿德勒心理学在人生幸福与自由上的实践指南。以哲人与青年对话的形式，拆解了「课题分离」「目的论」「共同体感觉」等核心概念。核心理念：一切的烦恼都来自人际关系，而自由就是被别人讨厌。这本书不是鸡汤，而是一套可以立刻开始练习的「人生重构」方法。",
    "tags": [
      "哲学思辨",
      "个人成长",
      "沟通关系"
    ],
    "audioUrl": "audio/book-009.mp3",
    "pdfUrl": "pdf/book-009.pdf",
    "duration": "33:48",
    "rating": "8.6",
    "category": "哲学与思辨",
    "highlights": [
      "课题分离：分清你的事 vs 别人的事",
      "重要的不是被给予了什么，而是如何利用",
      "人生不是一条线，而是连续刹那的舞蹈"
    ],
    "action": "列出最近让你烦恼的 1 件事，问自己：「这到底是谁的事？」练习课题分离。"
  },
  {
    "id": 10,
    "date": "2026-05-20",
    "title": "心流",
    "originalTitle": "Flow: The Psychology of Optimal Experience",
    "author": "米哈里·契克森米哈赖",
    "description": "积极心理学奠基之作。契克森米哈赖通过 30 年研究提出：心流是人类能体验到的最高质量的精神状态；幸福不是追求来的，而是当你全身心投入一件事时自然产生的副产品。书中给出了进入心流状态的 7 大条件——从清晰目标到即时反馈——以及如何在日常工作中刻意设计心流体验。",
    "tags": [
      "认知心理",
      "个人成长",
      "心理学"
    ],
    "audioUrl": "audio/book-010.mp3",
    "pdfUrl": "pdf/book-010.pdf",
    "duration": "42:08",
    "rating": "8.5",
    "category": "认知与心理",
    "highlights": [
      "精神熵：内心混乱、注意力涣散 = 痛苦",
      "心流 = 技能与挑战的黄金平衡点",
      "幸福是副产品，不是目标"
    ],
    "action": "本周找一个挑战略高于你技能的任务，全身投入 90 分钟，体验心流。"
  },
  {
    "id": 11,
    "date": "2026-05-19",
    "title": "反脆弱",
    "originalTitle": "Antifragile",
    "author": "纳西姆·塔勒布",
    "description": "塔勒布「不确定性三部曲」的巅峰之作。教你在充满不确定性的世界里，如何从混乱、压力和波动中获益——而不是被它们摧毁。他创造了「反脆弱」一词：有些事物不仅能抵抗冲击，还能从中成长。从「杠铃策略」到「可选项理论」，本书给你一套逆势决策的思维框架。",
    "tags": [
      "金融经济",
      "哲学思辨",
      "决策系统"
    ],
    "audioUrl": "audio/book-011.mp3",
    "pdfUrl": "pdf/book-011.pdf",
    "duration": "48:55",
    "rating": "8.3",
    "category": "金融与经济",
    "highlights": [
      "反脆弱性 > 强韧性 > 脆弱性",
      "过度优化反而增加脆弱性",
      "主动试错：可选项是不对称收益的来源"
    ],
    "action": "主动制造一次「可控的小失败」——做一件明知可能搞砸的事，记录你从中学到什么。"
  },
  {
    "id": 12,
    "date": "2026-05-18",
    "title": "未来简史",
    "originalTitle": "Homo Deus",
    "author": "尤瓦尔·赫拉利",
    "description": "《人类简史》作者赫拉利的第二部巨著。21 世纪人类将从追求「生存」转向追求「永生、幸福、神性」——而 AI 与大数据将颠覆自由意志，创造前所未有的社会变革。本书大胆预测：当算法比我们更了解自己，宗教、人文主义、自由意志都将被重新定义。读完后你会重新审视「人」这个物种的未来。",
    "tags": [
      "历史文明",
      "科技未来",
      "哲学思辨"
    ],
    "audioUrl": "audio/book-012.mp3",
    "pdfUrl": "pdf/book-012.pdf",
    "duration": "51:12",
    "rating": "8.6",
    "category": "历史与文明",
    "highlights": [
      "21 世纪三大新议题：永生、幸福、神性",
      "AI 可能比我们更了解自己",
      "人文主义是宗教，自由意志是幻觉？"
    ],
    "action": "想象 2050 年你最期待的科技，思考：你今天该学什么、做什么准备，才能搭上这班车？"
  }
];;

/* ──────────────────────────────────────
   初始化
   ────────────────────────────────────── */
async function init() {
  initTheme();
  renderThemeSwitcher();

  document.getElementById('headerDate').textContent =
    new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
  document.getElementById('footerYear').textContent = new Date().getFullYear();

  // 后台直接写入 GitHub；前端优先读取最新书库，部署内快照作为备用。
  let books = null;
  const dataSources = [
    'https://raw.githubusercontent.com/FreedomBAO/yibenshi/main/data.json?_=' + Date.now(),
    'data.json?_=' + Date.now(),
  ];
  for (const source of dataSources) {
    try {
      const resp = await fetch(source, { cache: 'no-store' });
      if (!resp.ok) continue;
      const json = await resp.json();
      if (json.books && json.books.length) {
        books = json.books;
        break;
      }
    } catch (err) {
      console.warn('加载书籍数据失败，尝试备用来源:', source, err);
    }
  }

  if (!books) books = BOOKS_DATA;

  _allBooks = books;
  const sorted = books.slice().sort((a, b) => b.date.localeCompare(a.date));
  const today = new Date().toISOString().slice(0, 10);
  _todayBook = sorted.find(b => b.date === today) || sorted[0];
  _archiveBooks = sorted.filter(b => b.id !== _todayBook.id);

  renderHero(_todayBook);
  renderFilterChips(_allBooks);
  initSearch();
  applyFilter();
  bindKeyboardShortcuts();
}

init();
