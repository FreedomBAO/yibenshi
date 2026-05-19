const PALETTE = [
  '#5C3D2E', '#2C4A3E', '#2E3A5C', '#4A2C4E',
  '#3E2C2C', '#2C3E2C', '#3C3528', '#1E3A4A',
];

function colorForId(id) {
  return PALETTE[(id - 1) % PALETTE.length];
}

function formatDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });
}

function tagsHtml(tags, cls = 'tag-chip') {
  return tags.map(t => `<span class="${cls}">${t}</span>`).join('');
}

function audioPlayerHtml(book, prefix = '') {
  const id = `player-${prefix}${book.id}`;
  return `
    <div class="audio-player" id="${id}">
      <button class="play-btn" onclick="togglePlay('${id}', '${book.audioUrl}', '${book.duration}')" aria-label="播放/暂停">
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

function pdfBtnHtml(book) {
  return `
    <a class="pdf-btn" href="${book.pdfUrl}" target="_blank" rel="noopener">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M3 1h7l3 3v11H3V1z"/>
        <path d="M10 1v3h3"/>
        <line x1="6" y1="8" x2="10" y2="8"/>
        <line x1="6" y1="11" x2="10" y2="11"/>
      </svg>
      下载精读笔记
    </a>`;
}

function renderHero(book) {
  const section = document.getElementById('heroSection');
  const color = colorForId(book.id);
  section.innerHTML = `
    <div class="hero-eyebrow">今日推荐</div>
    <div class="hero-card">
      <div class="hero-color-block" style="background:${color}">
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
            <div class="tag-chips">${tagsHtml(book.tags)}</div>
          </div>
        </div>
        <div class="hero-actions">
          ${audioPlayerHtml(book, 'hero-')}
          ${pdfBtnHtml(book)}
        </div>
      </div>
    </div>`;
}

function renderArchive(books) {
  const grid = document.getElementById('booksGrid');
  if (!books.length) {
    grid.innerHTML = '<p class="empty-archive">暂无往期书单</p>';
    return;
  }
  grid.innerHTML = books.map((book, i) => {
    const color = colorForId(book.id);
    const delay = (i * 0.08).toFixed(2);
    return `
      <div class="book-card" style="animation-delay:${delay}s">
        <div class="card-color-block" style="background:${color}">
          <div class="card-book-index">${String(book.id).padStart(2, '0')}</div>
          <div class="card-title-in-block">
            <div class="card-book-title">${book.title}</div>
            <div class="card-book-author">${book.author}</div>
          </div>
        </div>
        <div class="card-body">
          <div class="card-date">${formatDate(book.date)}</div>
          <div class="card-description">${book.description}</div>
          <div class="card-tags">${tagsHtml(book.tags, 'tag-chip')}</div>
          <div class="card-actions">
            ${audioPlayerHtml(book)}
            ${pdfBtnHtml(book)}
          </div>
        </div>
      </div>`;
  }).join('');
}

// Audio state
const audioState = {};

function togglePlay(playerId, url, duration) {
  const btn = document.querySelector(`#${playerId} .play-btn`);
  const fill = document.getElementById(`${playerId}-fill`);
  const timeEl = document.getElementById(`${playerId}-time`);

  if (!audioState[playerId]) {
    audioState[playerId] = { audio: new Audio(url), duration };
  }
  const state = audioState[playerId];
  const audio = state.audio;

  if (audio.paused) {
    Object.values(audioState).forEach(s => {
      if (s !== state && !s.audio.paused) s.audio.pause();
    });
    document.querySelectorAll('.play-btn').forEach(b => b.classList.remove('playing'));
    audio.play().catch(() => {});
    btn.classList.add('playing');
    audio.ontimeupdate = () => {
      const pct = audio.duration ? (audio.currentTime / audio.duration) * 100 : 0;
      fill.style.width = pct + '%';
      timeEl.textContent = fmtTime(audio.currentTime);
    };
    audio.onended = () => {
      btn.classList.remove('playing');
      fill.style.width = '0%';
      timeEl.textContent = duration;
    };
  } else {
    audio.pause();
    btn.classList.remove('playing');
  }
}

function seekAudio(e, playerId) {
  const state = audioState[playerId];
  if (!state || !state.audio.duration) return;
  const bar = e.currentTarget;
  const ratio = e.offsetX / bar.offsetWidth;
  state.audio.currentTime = ratio * state.audio.duration;
}

function fmtTime(s) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

const BOOKS_DATA = [
  {
    "id": 1,
    "date": "2026-05-19",
    "title": "思考，快与慢",
    "originalTitle": "Thinking, Fast and Slow",
    "author": "丹尼尔·卡尼曼",
    "description": "诺贝尔经济学奖得主卡尼曼将毕生研究成果浓缩于此，深刻揭示了人类思维的两套系统：快速直觉的系统一与缓慢理性的系统二。这本书改变了人们对理性决策的认知，也让我们更清醒地看见自身的认知偏误。从启发式偏差到前景理论，每一章都是对「我们以为自己理性」这一幻觉的精准拆解。",
    "tags": ["心理学", "行为经济学", "认知科学"],
    "audioUrl": "audio/book-001.mp3",
    "pdfUrl": "pdf/book-001.pdf",
    "duration": "45:23"
  },
  {
    "id": 2,
    "date": "2026-05-18",
    "title": "原则",
    "originalTitle": "Principles",
    "author": "瑞·达利欧",
    "description": "桥水基金创始人达利欧分享了他在生活和工作中总结的一套原则体系。从「拥抱现实、应对现实」到「进化是宇宙中最强大的力量」，这些原则既是世界观，也是方法论，帮助他在四十年间打造出全球最大的对冲基金。",
    "tags": ["管理", "投资", "人生哲学"],
    "audioUrl": "audio/book-002.mp3",
    "pdfUrl": "pdf/book-002.pdf",
    "duration": "52:10"
  },
  {
    "id": 3,
    "date": "2026-05-17",
    "title": "人类简史",
    "originalTitle": "Sapiens",
    "author": "尤瓦尔·赫拉利",
    "description": "从十万年前有生命迹象开始到21世纪资本、科技交织的人类发展史。赫拉利以大历史视角重新审视人类崛起的秘密——是「虚构故事」的能力让智人脱颖而出，统治了地球。读完此书，你对文明的理解将被彻底重构。",
    "tags": ["历史", "人类学", "社会学"],
    "audioUrl": "audio/book-003.mp3",
    "pdfUrl": "pdf/book-003.pdf",
    "duration": "38:45"
  }
];

function init() {
  const today = new Date().toISOString().slice(0, 10);

  document.getElementById('headerDate').textContent =
    new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
  document.getElementById('footerYear').textContent = new Date().getFullYear();

  const books = BOOKS_DATA.slice().sort((a, b) => b.date.localeCompare(a.date));
  const todayBook = books.find(b => b.date === today) || books[0];
  const archiveBooks = books.filter(b => b !== todayBook);

  renderHero(todayBook);
  renderArchive(archiveBooks);
}

init();
