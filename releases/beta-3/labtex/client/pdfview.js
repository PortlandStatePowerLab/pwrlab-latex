// PDF preview built on pdf.js: lazy page rendering, zoom, and SyncTeX hooks.
import * as pdfjsLib from 'pdfjs-dist';
import { TextLayerBuilder } from 'pdfjs-dist/web/pdf_viewer.mjs';
import { h } from './util.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';

export class PdfView {
  constructor(root, { onDoubleClick } = {}) {
    this.root = root;
    this.onDoubleClick = onDoubleClick;
    this.zoom = localStorage.getItem('labtex.zoom') || 'fit';
    this.pdf = null;
    this.pages = []; // {el, canvas, viewport, rendered, task}
    this.zoomLabel = h('span', { class: 'zoom-label' });
    this.pageLabel = h('span', { class: 'page-label' });
    this.toolbar = h('div', { class: 'pdf-toolbar' },
      h('button', { class: 'icon-btn', title: 'Zoom out', 'aria-label': 'Zoom out', onclick: () => this.setZoom(this.currentScale() / 1.15) }, '−'),
      this.zoomLabel,
      h('button', { class: 'icon-btn', title: 'Zoom in', 'aria-label': 'Zoom in', onclick: () => this.setZoom(this.currentScale() * 1.15) }, '+'),
      h('button', { class: 'btn small', title: 'Fit page width', onclick: () => this.setZoom('fit') }, 'Fit width'),
      h('div', { class: 'spacer' }), this.pageLabel);
    this.scroller = h('div', { class: 'pdf-scroll', tabindex: '0' });
    this.empty = h('div', { class: 'pdf-empty' }, 'Click Recompile to build the PDF.');
    this.scroller.append(this.empty);
    root.append(this.toolbar, this.scroller);
    this.observer = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) this.renderPage(Number(e.target.dataset.index));
    }, { root: this.scroller, rootMargin: '600px 0px' });
    this.scroller.addEventListener('scroll', () => this.updatePageLabel(), { passive: true });
    // Keyboard selection in the PDF: Shift+arrows extend the selection (Ctrl/Alt for whole words),
    // Ctrl/Cmd+A selects the text of the PDF only.
    this.scroller.addEventListener('keydown', (e) => {
      const sel = window.getSelection();
      const inside = sel.rangeCount && this.scroller.contains(sel.anchorNode);
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        const range = document.createRange();
        range.selectNodeContents(this.scroller);
        sel.removeAllRanges(); sel.addRange(range);
        return;
      }
      if (!e.shiftKey || !inside || !sel.modify) return;
      const map = { ArrowLeft: ['backward', 'character'], ArrowRight: ['forward', 'character'], ArrowUp: ['backward', 'line'], ArrowDown: ['forward', 'line'], Home: ['backward', 'lineboundary'], End: ['forward', 'lineboundary'] };
      const m = map[e.key];
      if (!m) return;
      e.preventDefault();
      const unit = (e.ctrlKey || e.altKey) && m[1] === 'character' ? 'word' : m[1];
      sel.modify('extend', m[0], unit);
    });
    // Clicking in the PDF focuses it so the keys above go here, without stealing an active selection.
    this.scroller.addEventListener('mousedown', () => this.scroller.focus({ preventScroll: true }));
    this.resizeObs = new ResizeObserver(() => {
      if (this.zoom === 'fit' && this.pdf) { clearTimeout(this.rt); this.rt = setTimeout(() => this.layout(), 150); }
    });
    this.resizeObs.observe(this.scroller);
    this.scroller.addEventListener('wheel', (e) => {
      if (!(e.ctrlKey || e.metaKey) || !this.pdf) return;
      e.preventDefault();
      this.setZoom(this.currentScale() * (e.deltaY < 0 ? 1.08 : 1 / 1.08));
    }, { passive: false });
  }

  currentScale() { return this.scale || 1; }

  async load(url) {
    const prev = this.pdf ? { top: this.scroller.scrollTop, left: this.scroller.scrollLeft } : null;
    let doc;
    const task = pdfjsLib.getDocument({ url, withCredentials: true, isEvalSupported: false });
    try { doc = await task.promise; }
    catch (e) { task.destroy(); if (!this.pdf) this.showMessage('No PDF yet. Recompile to build it.'); return false; }
    const old = this.task;
    this.pdf = doc; this.task = task;
    this.pageSizes = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const p = await doc.getPage(i);
      this.pageSizes.push(p.getViewport({ scale: 1 }));
    }
    await this.layout(prev);
    old?.destroy();
    return true;
  }

  showMessage(msg) {
    this.empty.textContent = msg;
    this.scroller.replaceChildren(this.empty);
    this.pageLabel.textContent = '';
  }

  computeScale() {
    if (this.zoom !== 'fit') return Number(this.zoom);
    const w = this.scroller.clientWidth - 32;
    const maxW = Math.max(...this.pageSizes.map((v) => v.width));
    return Math.max(0.25, w / maxW);
  }

  setZoom(z) {
    if (!this.pdf) return;
    if (z !== 'fit') z = String(Math.min(5, Math.max(0.25, z)).toFixed(3));
    // Keep the same relative scroll position.
    const ratio = this.scroller.scrollTop / Math.max(1, this.scroller.scrollHeight);
    this.zoom = z;
    localStorage.setItem('labtex.zoom', z);
    this.layout().then(() => { this.scroller.scrollTop = ratio * this.scroller.scrollHeight; });
  }

  async layout(prev) {
    for (const p of this.pages) { p.task?.cancel(); this.observer.unobserve(p.el); }
    this.scale = this.computeScale();
    this.zoomLabel.textContent = Math.round(this.scale * 100) + '%';
    const frag = document.createDocumentFragment();
    this.pages = this.pageSizes.map((v, i) => {
      const vp = v.clone({ scale: this.scale });
      const el = h('div', { class: 'pdf-page', 'data-index': i, style: { width: vp.width + 'px', height: vp.height + 'px' } });
      el.style.setProperty('--total-scale-factor', String(this.scale));
      el.style.setProperty('--scale-factor', String(this.scale));
      el.style.setProperty('--scale-round-x', '1px');
      el.style.setProperty('--scale-round-y', '1px');
      el.addEventListener('dblclick', (e) => {
        const r = el.getBoundingClientRect();
        this.onDoubleClick?.(i + 1, (e.clientX - r.left) / this.scale, (e.clientY - r.top) / this.scale);
      });
      frag.append(el);
      return { el, vp, rendered: false };
    });
    this.scroller.replaceChildren(frag);
    if (prev) { this.scroller.scrollTop = prev.top; this.scroller.scrollLeft = prev.left; }
    for (const p of this.pages) this.observer.observe(p.el);
    this.updatePageLabel();
  }

  async renderPage(i) {
    const p = this.pages[i];
    if (!p || p.rendered) return;
    p.rendered = true;
    const pdf = this.pdf;
    const page = await pdf.getPage(i + 1);
    if (pdf !== this.pdf || this.pages[i] !== p) return;
    const dpr = window.devicePixelRatio || 1;
    const canvas = h('canvas', { width: Math.floor(p.vp.width * dpr), height: Math.floor(p.vp.height * dpr), style: { width: p.vp.width + 'px', height: p.vp.height + 'px' } });
    p.task = page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport: p.vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null });
    try { await p.task.promise; } catch { p.rendered = false; return; }
    p.el.querySelector('canvas')?.remove();
    p.el.prepend(canvas);
    // Selectable, copyable text on top of the rendered page.
    try {
      const tl = new TextLayerBuilder({ pdfPage: page });
      await tl.render({ viewport: p.vp });
      if (pdf !== this.pdf || this.pages[i] !== p) return;
      p.el.querySelector('.textLayer')?.remove();
      p.el.append(tl.div);
    } catch (e) { console.warn('text layer failed', e); }
  }

  updatePageLabel() {
    if (!this.pages.length) return;
    const mid = this.scroller.scrollTop + this.scroller.clientHeight / 3;
    let cur = 1;
    for (let i = 0; i < this.pages.length; i++) if (this.pages[i].el.offsetTop <= mid) cur = i + 1;
    this.pageLabel.textContent = `Page ${cur} / ${this.pages.length}`;
  }

  /** Scroll to and flash SyncTeX boxes ({page,h,v,W,H} in PDF points; v is the baseline). */
  highlight(boxes) {
    if (!boxes?.length || !this.pages.length) return;
    this.scroller.querySelectorAll('.sync-hl').forEach((e) => e.remove());
    let first = null;
    for (const b of boxes) {
      const p = this.pages[b.page - 1];
      if (!p) continue;
      const s = this.scale;
      const el = h('div', { class: 'sync-hl', style: { left: b.h * s + 'px', top: (b.v - b.H) * s + 'px', width: Math.max(b.W, 20) * s + 'px', height: Math.max(b.H, 8) * s + 'px' } });
      p.el.append(el);
      first ??= el;
      setTimeout(() => el.remove(), 2200);
    }
    if (first) {
      const pageEl = first.parentElement;
      this.scroller.scrollTo({ top: pageEl.offsetTop + first.offsetTop - this.scroller.clientHeight / 3, behavior: 'smooth' });
    }
  }

  destroy() {
    this.observer.disconnect();
    this.resizeObs.disconnect();
    this.task?.destroy();
  }
}
