/* Brand site: progressive enhancement; all reading links work without GSAP. */
(() => {
  'use strict';
  // Keep bookmarks made before the homepage / library split useful.
  if (location.hash === '#booksSection' || location.hash === '#heroSection') {
    location.replace('library.html' + location.hash);
    return;
  }
  if (location.hash === '#aboutSection') location.replace('#about');
  document.getElementById('year').textContent = new Date().getFullYear();

  const tabs = Array.from(document.querySelectorAll('[data-step]'));
  const panel = document.getElementById('experiencePanel');
  const content = document.getElementById('experienceContent');
  const panels = [content.innerHTML,
    `<span class="demo-kicker">AI 伴读 · 交互示意</span><div class="question-bubble">总是坚持不下来，怎样让习惯更容易开始？</div><div class="answer-preview"><span class="ai-icon" aria-hidden="true">✦</span><div><p>从当前书籍的精读 PDF 中寻找相关内容，理解方法，再查看回答引用的页码。</p><span class="source-note">此处为功能说明，不是实时 AI 回答。</span></div></div><a href="library.html?book=3&action=ai" class="demo-link">打开《原子习惯》AI 伴读 ↗</a>`,
    `<span class="demo-kicker">今日行动 · 阅读后的第一步</span><h3>先做一件，两分钟的小事。</h3><p>把“我要多读书”，变成一个具体的开始。</p><div class="action-preview"><span aria-hidden="true">✓</span><span>今晚，把想读的书放到枕边，读一页。</span></div><span class="source-note">行动建议示意 · 无需打卡，按自己的节奏来。</span><a href="library.html?book=3" class="demo-link">发现这本书的更多行动建议 ↗</a>`
  ];
  function selectStep(index, focus = false) {
    tabs.forEach((tab, i) => {
      tab.setAttribute('aria-selected', String(index === i));
      tab.tabIndex = index === i ? 0 : -1;
    });
    panel.setAttribute('aria-labelledby', tabs[index].id);
    content.innerHTML = panels[index];
    if (focus) tabs[index].focus();
    if (window.gsap && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      gsap.fromTo(content, { y: 8, opacity: 0.4 }, { y: 0, opacity: 1, duration: 0.3, overwrite: true, clearProps: 'transform,opacity' });
    }
  }
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => selectStep(index));
    tab.addEventListener('keydown', event => {
      const destinations = { ArrowDown: (index + 1) % tabs.length, ArrowUp: (index + tabs.length - 1) % tabs.length, Home: 0, End: tabs.length - 1 };
      if (!(event.key in destinations)) return;
      event.preventDefault();
      selectStep(destinations[event.key], true);
    });
  });

  // Actual cover images and count come from the deployed content snapshot.
  // If unavailable, the static topic links remain fully usable.
  async function loadCollection() {
    try {
      const response = await fetch('data.json', { signal: AbortSignal.timeout(8000) });
      if (!response.ok) return;
      const data = await response.json();
      if (!Array.isArray(data.books) || !data.books.length) return;
      document.getElementById('collectionCount').textContent = `已收录 ${data.books.length} 本精读 · 持续更新`;
      document.querySelectorAll('.discovery-card').forEach(card => {
        const category = new URL(card.href).searchParams.get('category');
        const books = data.books.filter(book => book.category === category && (book.cover || book.coverUrl)).slice(0, 2);
        const stack = document.createElement('div');
        stack.className = 'discovery-books';
        stack.setAttribute('aria-hidden', 'true');
        books.forEach(book => {
          const image = document.createElement('img');
          const source = book.cover || book.coverUrl;
          const rawPrefix = 'https://raw.githubusercontent.com/FreedomBAO/yibenshi/main/';
          const url = new URL(source.startsWith(rawPrefix) ? source.slice(rawPrefix.length) : source, location.href);
          if (!['http:', 'https:', 'file:'].includes(url.protocol)) return;
          image.src = url.href;
          image.alt = '';
          image.width = 92;
          image.height = 132;
          image.loading = 'lazy';
          image.addEventListener('error', () => image.remove(), { once: true });
          stack.append(image);
        });
        card.append(stack);
      });
    } catch { /* A book-data outage must not block entry to the reading app. */ }
  }
  loadCollection();

  if (!window.gsap) return;
  if (window.ScrollTrigger) gsap.registerPlugin(ScrollTrigger);
  const media = gsap.matchMedia();
  media.add('(prefers-reduced-motion: no-preference)', () => {
    gsap.timeline({ defaults: { ease: 'power3.out', duration: 0.8 } })
      .from('.hero-reveal', { y: 23, opacity: 0, stagger: 0.09, clearProps: 'transform,opacity' })
      .from('.hero-art', { y: 22, opacity: 0, duration: 1, clearProps: 'transform,opacity' }, 0.2);
    if (window.ScrollTrigger) {
      document.querySelectorAll('[data-reveal]').forEach(element => {
        // Begin only on entry, so offscreen content stays visible to keyboard users.
        ScrollTrigger.create({ trigger: element, start: 'top 94%', once: true,
          onEnter: () => gsap.from(element, { y: 18, duration: 0.7, ease: 'power3.out', clearProps: 'transform' })
        });
      });
      gsap.to('.about-mark', { y: -22, ease: 'none', scrollTrigger: { trigger: '.about', start: 'top bottom', end: 'bottom top', scrub: 0.8 } });
    }
  });
  media.add('(pointer: fine) and (min-width: 801px) and (prefers-reduced-motion: no-preference)', () => {
    const scene = document.getElementById('bookScene');
    let bounds = null;
    const layers = Array.from(scene.querySelectorAll('[data-depth]')).map(element => ({
      depth: Number(element.dataset.depth),
      x: gsap.quickTo(element, 'x', { duration: 0.7, ease: 'power3.out' }),
      y: gsap.quickTo(element, 'y', { duration: 0.7, ease: 'power3.out' }),
      rotationY: gsap.quickTo(element, 'rotationY', { duration: 0.7, ease: 'power3.out' })
    }));
    const invalidate = () => { bounds = null; };
    const move = event => {
      if (!bounds) bounds = scene.getBoundingClientRect();
      const x = gsap.utils.clamp(-0.5, 0.5, (event.clientX - bounds.left) / bounds.width - 0.5);
      const y = gsap.utils.clamp(-0.5, 0.5, (event.clientY - bounds.top) / bounds.height - 0.5);
      layers.forEach(layer => { layer.x(x * 22 * layer.depth); layer.y(y * 18 * layer.depth); layer.rotationY(x * 7 * layer.depth); });
    };
    const reset = () => layers.forEach(layer => { layer.x(0); layer.y(0); layer.rotationY(0); });
    scene.addEventListener('pointermove', move, { passive: true });
    scene.addEventListener('pointerleave', reset);
    window.addEventListener('scroll', invalidate, { passive: true });
    window.addEventListener('resize', invalidate);
    return () => {
      scene.removeEventListener('pointermove', move);
      scene.removeEventListener('pointerleave', reset);
      window.removeEventListener('scroll', invalidate);
      window.removeEventListener('resize', invalidate);
    };
  });
  document.fonts?.ready.then(() => window.ScrollTrigger?.refresh());
})();
