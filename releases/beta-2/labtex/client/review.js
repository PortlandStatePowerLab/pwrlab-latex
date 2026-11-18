// Track changes + comments, built on the file's Yjs document.
//
// Track changes: suggestions live as formatting attributes on the shared Y.Text.
//   { ins: meta }  text someone inserted while tracking was on
//   { del: meta }  text someone deleted while tracking was on (kept in the document, shown struck through)
// meta = { uid, name, color, ts }. Accepting/rejecting just removes the attribute or the text.
// The compiled file uses the "accepted" view (server: acceptedText).
//
// Comments: ydoc.getMap('threads') holds one Y.Map per thread, anchored with Yjs relative positions
// so the highlight follows the text as people edit around it.
import * as Y from 'yjs';
import { EditorView, Decoration, ViewPlugin, showTooltip } from '@codemirror/view';
import { StateField, StateEffect, EditorState, Transaction } from '@codemirror/state';
import { h, timeAgo, avatar } from './util.js';

export const TC_ORIGIN = 'labtex-tc'; // our own formatting transactions (undoable)
const REVIEW_ORIGIN = 'labtex-review'; // accept/reject/comment actions

// ---------- reading the document ----------

/** Spans of the text with their attributes, in document order. */
export function spans(ytext) {
  const out = [];
  let pos = 0;
  for (const op of ytext.toDelta()) {
    if (typeof op.insert !== 'string') continue;
    const len = op.insert.length;
    out.push({ from: pos, to: pos + len, text: op.insert, attrs: op.attributes || {} });
    pos += len;
  }
  return out;
}

/** Tracked changes grouped into reviewable units (adjacent spans of the same kind by the same person). */
export function trackedChanges(ytext) {
  const groups = [];
  for (const s of spans(ytext)) {
    const kind = s.attrs.del ? 'del' : s.attrs.ins ? 'ins' : null;
    if (!kind) continue;
    const meta = s.attrs[kind];
    const last = groups[groups.length - 1];
    if (last && last.kind === kind && last.uid === meta.uid && last.to === s.from) {
      last.to = s.to; last.text += s.text; last.ts = Math.max(last.ts, meta.ts || 0);
    } else {
      groups.push({ kind, from: s.from, to: s.to, text: s.text, uid: meta.uid, name: meta.name, color: meta.color, ts: meta.ts || 0 });
    }
  }
  return groups;
}

export function acceptChange(ydoc, ytext, c) {
  ydoc.transact(() => {
    if (c.kind === 'ins') ytext.format(c.from, c.to - c.from, { ins: null });
    else ytext.delete(c.from, c.to - c.from);
  }, REVIEW_ORIGIN);
}
export function rejectChange(ydoc, ytext, c) {
  ydoc.transact(() => {
    if (c.kind === 'ins') ytext.delete(c.from, c.to - c.from);
    else ytext.format(c.from, c.to - c.from, { del: null });
  }, REVIEW_ORIGIN);
}
/** Apply to all changes, last first so earlier positions stay valid. */
export function resolveAll(ydoc, ytext, accept) {
  ydoc.transact(() => {
    for (const c of trackedChanges(ytext).reverse()) {
      if ((c.kind === 'ins') === accept) ytext.format(c.from, c.to - c.from, { ins: null, del: null });
      else ytext.delete(c.from, c.to - c.from);
    }
  }, REVIEW_ORIGIN);
}

// ---------- comments ----------

const relToJSON = (ytext, index, assoc) => Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(ytext, index, assoc));
const absIndex = (ydoc, json) => {
  try { return Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(json), ydoc)?.index ?? null; } catch { return null; }
};
const newId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

export function addThread(ydoc, ytext, from, to, user, text) {
  const id = newId();
  ydoc.transact(() => {
    const t = new Y.Map();
    const msgs = new Y.Array();
    t.set('id', id);
    t.set('start', relToJSON(ytext, from, 0));
    t.set('end', relToJSON(ytext, to, -1));
    t.set('quote', ytext.toString().slice(from, to).slice(0, 300));
    t.set('uid', user.id); t.set('name', user.name); t.set('color', user.color);
    t.set('created', Date.now());
    t.set('resolved', false);
    msgs.push([{ id: newId(), uid: user.id, name: user.name, color: user.color, text, ts: Date.now() }]);
    t.set('messages', msgs);
    ydoc.getMap('threads').set(id, t);
  }, REVIEW_ORIGIN);
  return id;
}
export function replyThread(ydoc, id, user, text) {
  const t = ydoc.getMap('threads').get(id);
  if (!t) return;
  ydoc.transact(() => t.get('messages').push([{ id: newId(), uid: user.id, name: user.name, color: user.color, text, ts: Date.now() }]), REVIEW_ORIGIN);
}
export function setResolved(ydoc, id, resolved, user) {
  const t = ydoc.getMap('threads').get(id);
  if (!t) return;
  ydoc.transact(() => { t.set('resolved', resolved); t.set('resolvedBy', resolved ? user.name : null); t.set('resolvedAt', resolved ? Date.now() : null); }, REVIEW_ORIGIN);
}
export function deleteThread(ydoc, id) {
  ydoc.transact(() => ydoc.getMap('threads').delete(id), REVIEW_ORIGIN);
}

/** All threads with their current position in the text. */
export function threads(ydoc) {
  const out = [];
  ydoc.getMap('threads').forEach((t, id) => {
    const from = absIndex(ydoc, t.get('start'));
    const to = absIndex(ydoc, t.get('end'));
    out.push({
      id, from, to, quote: t.get('quote') || '', uid: t.get('uid'), name: t.get('name'), color: t.get('color'),
      created: t.get('created') || 0, resolved: !!t.get('resolved'), resolvedBy: t.get('resolvedBy'), resolvedAt: t.get('resolvedAt'),
      messages: t.get('messages')?.toArray() || [],
      orphaned: from == null || to == null || to <= from,
    });
  });
  return out;
}

// ---------- CodeMirror integration ----------

const setDecos = StateEffect.define();
export const setActiveThread = StateEffect.define();

/**
 * @param opts.ydoc, opts.ytext
 * @param opts.user        { id, name, color }
 * @param opts.isTracking  () => boolean
 * @param opts.canEdit     () => boolean
 * @param opts.onComment   (from, to) => void       user asked to comment on a selection
 * @param opts.onFocusThread (id) => void           user clicked a comment highlight
 * @param opts.onChange    () => void               review data changed (to refresh the panel)
 */
export function reviewExtension(opts) {
  const { ydoc, ytext, user } = opts;

  const buildDecos = (state, activeId) => {
    const ranges = [];
    const len = state.doc.length;
    // One mark per reviewable change (a person's contiguous run), not per keystroke.
    for (const c of trackedChanges(ytext)) {
      if (c.to > len) break;
      const verb = c.kind === 'del' ? 'Deleted' : 'Inserted';
      ranges.push(Decoration.mark({
        class: c.kind === 'del' ? 'cm-tc-del' : 'cm-tc-ins',
        attributes: { style: `--tc:${c.color || (c.kind === 'del' ? '#b42318' : '#146c43')}`, title: `${verb} by ${c.name || 'someone'}${c.ts ? ' · ' + timeAgo(c.ts) : ''}` },
      }).range(c.from, c.to));
    }
    for (const t of threads(ydoc)) {
      if (t.resolved || t.orphaned || t.to > len) continue;
      ranges.push(Decoration.mark({
        class: 'cm-comment' + (t.id === activeId ? ' cm-comment-active' : ''),
        attributes: { 'data-thread': t.id },
      }).range(t.from, t.to));
    }
    return Decoration.set(ranges, true);
  };

  const decoField = StateField.define({
    create: (state) => ({ decos: buildDecos(state, null), active: null }),
    update(value, tr) {
      let { decos, active } = value;
      decos = decos.map(tr.changes);
      for (const e of tr.effects) {
        if (e.is(setDecos)) decos = e.value;
        if (e.is(setActiveThread)) { active = e.value; decos = buildDecos(tr.state, active); }
      }
      return { decos, active };
    },
    provide: (f) => EditorView.decorations.from(f, (v) => v.decos),
  });

  // Keep decorations in sync with Yjs (remote edits, format changes, comment changes).
  const sync = ViewPlugin.fromClass(class {
    constructor(view) {
      this.view = view;
      this.pending = false;
      this.refresh = () => {
        if (this.pending) return;
        this.pending = true;
        // Deferred: Yjs observers can fire while CodeMirror is mid-update.
        requestAnimationFrame(() => {
          this.pending = false;
          if (this.destroyed) return;
          const active = this.view.state.field(decoField).active;
          this.view.dispatch({ effects: setDecos.of(buildDecos(this.view.state, active)) });
          opts.onChange?.();
        });
      };
      ytext.observe(this.onText = (event, tr) => { this.normalize(event, tr); this.refresh(); });
      ydoc.getMap('threads').observeDeep(this.refresh);
    }
    // Local insertions inherit formatting from the previous character in Yjs, so fix them up:
    // tracked mode marks them as this user's insertion; otherwise they are plain text.
    normalize(event, tr) {
      if (!tr.local || tr.origin === TC_ORIGIN || tr.origin === REVIEW_ORIGIN || tr.origin === 'server') return;
      if (tr.origin instanceof Y.UndoManager) return;
      const inserted = [];
      let index = 0;
      for (const d of event.delta) {
        if (d.retain) index += d.retain;
        else if (typeof d.insert === 'string') {
          inserted.push([relToJSON(ytext, index, 0), relToJSON(ytext, index + d.insert.length, -1)]);
          index += d.insert.length;
        }
      }
      if (!inserted.length) return;
      const tracking = opts.isTracking();
      queueMicrotask(() => {
        const attrs = tracking ? { ins: { uid: user.id, name: user.name, color: user.color, ts: Date.now() }, del: null } : { ins: null, del: null };
        ydoc.transact(() => {
          for (const [a, b] of inserted) {
            const from = absIndex(ydoc, a), to = absIndex(ydoc, b);
            if (from != null && to != null && to > from) ytext.format(from, to - from, attrs);
          }
        }, TC_ORIGIN);
      });
    }
    destroy() {
      this.destroyed = true;
      ytext.unobserve(this.onText);
      ydoc.getMap('threads').unobserveDeep(this.refresh);
    }
  });

  // In tracked mode, deleting text marks it as deleted instead of removing it.
  // (Deleting your own pending insertion really removes it, like in Overleaf.)
  const trackFilter = EditorState.transactionFilter.of((tr) => {
    if (!tr.docChanged || !opts.isTracking() || !opts.canEdit()) return tr;
    const ev = tr.annotation(Transaction.userEvent) || '';
    if (!/^(input|delete|move)/.test(ev)) return tr; // remote sync, undo/redo, programmatic: leave alone
    const all = spans(ytext);
    if (all.length && all[all.length - 1].to !== tr.startState.doc.length) return tr; // out of sync; don't interfere
    const attrsAt = (from, to) => all.filter((s) => s.to > from && s.from < to).map((s) => ({ from: Math.max(s.from, from), to: Math.min(s.to, to), attrs: s.attrs }));

    let hasDeletion = false;
    tr.changes.iterChanges((fromA, toA) => { if (toA > fromA) hasDeletion = true; });
    if (!hasDeletion) return tr; // pure insertions are handled by normalize()

    const specs = [];
    const toMark = [];
    tr.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
      for (const seg of attrsAt(fromA, toA)) {
        const ownInsert = seg.attrs.ins && seg.attrs.ins.uid === user.id && !seg.attrs.del;
        if (ownInsert) specs.push({ from: seg.from, to: seg.to });
        else if (!seg.attrs.del) toMark.push([relToJSON(ytext, seg.from, 0), relToJSON(ytext, seg.to, -1)]);
      }
      if (inserted.length) specs.push({ from: toA, insert: inserted });
    });
    const changes = tr.startState.changes(specs);
    const main = tr.startState.selection.main;
    let anchor;
    // Backspace leaves the cursor before the struck-out text, so repeated Backspace keeps going left.
    if (ev.startsWith('delete.backward')) anchor = changes.mapPos(main.empty ? Math.max(0, main.from - 1) : main.from, -1);
    else if (ev.startsWith('delete.forward')) anchor = changes.mapPos(main.empty ? Math.min(tr.startState.doc.length, main.to + 1) : main.to, 1);
    else anchor = changes.mapPos(main.to, 1);
    if (toMark.length) {
      queueMicrotask(() => {
        const meta = { uid: user.id, name: user.name, color: user.color, ts: Date.now() };
        ydoc.transact(() => {
          for (const [a, b] of toMark) {
            const from = absIndex(ydoc, a), to = absIndex(ydoc, b);
            if (from != null && to != null && to > from) ytext.format(from, to - from, { del: meta, ins: null });
          }
        }, TC_ORIGIN);
      });
    }
    return { changes, selection: { anchor }, userEvent: ev, scrollIntoView: true };
  });

  // Floating "Comment" button on a non-empty selection.
  const commentTooltip = StateField.define({
    create: () => null,
    update(_, tr) {
      const sel = tr.state.selection.main;
      if (sel.empty || !opts.canEdit()) return null;
      return {
        pos: sel.head, above: sel.head <= sel.anchor, strictSide: false, arrow: true,
        create: (view) => {
          const btn = h('button', {
            class: 'cm-comment-btn', title: 'Add a comment on the selected text (Ctrl/⌘+Alt+M)',
            onmousedown: (e) => e.preventDefault(), // keep the selection
            onclick: () => { const s = view.state.selection.main; opts.onComment(s.from, s.to); },
          }, '💬 Comment');
          return { dom: btn };
        },
      };
    },
    provide: (f) => showTooltip.from(f),
  });

  const clickComment = EditorView.domEventHandlers({
    click(e) {
      const el = e.target.closest?.('[data-thread]');
      if (el && window.getSelection().isCollapsed) opts.onFocusThread?.(el.dataset.thread);
      return false;
    },
  });

  return [decoField, sync, trackFilter, commentTooltip, clickComment, reviewTheme];
}

const reviewTheme = EditorView.baseTheme({
  '.cm-tc-ins': { backgroundColor: 'color-mix(in srgb, var(--tc) 16%, transparent)', borderBottom: '2px solid var(--tc)' },
  '.cm-tc-del': { textDecoration: 'line-through', textDecorationColor: 'var(--tc)', textDecorationThickness: '2px', color: 'var(--del-text)', backgroundColor: 'var(--danger-soft)' },
  '.cm-comment': { backgroundColor: 'rgba(250, 204, 21, 0.28)', borderBottom: '2px solid #eab308', cursor: 'pointer' },
  '.cm-comment-active': { backgroundColor: 'rgba(250, 204, 21, 0.6)' },
  '.cm-tooltip.cm-tooltip-above, .cm-tooltip.cm-tooltip-below': {},
  '.cm-comment-btn': { font: '600 12.5px system-ui, sans-serif', padding: '5px 10px', border: '0', borderRadius: '6px', background: '#17212b', color: '#fff', cursor: 'pointer' },
  '.cm-comment-btn:hover': { background: '#146c43' },
});

// ---------- Review panel ----------

export class ReviewPanel {
  /**
   * @param opts.getCtx  () => ({ ydoc, ytext, view } | null) for the open file
   * @param opts.user, opts.canEdit(), opts.canModerate(), opts.isTracking(), opts.setTracking(bool)
   */
  constructor(opts) {
    this.opts = opts;
    this.drafts = new Map(); // thread id or 'new' -> text
    this.pendingNew = null;  // { from, to, quote } for a comment being written
    this.showResolved = false;
    this.el = h('aside', { class: 'review', 'aria-label': 'Review panel' });
    this.scheduled = false;
  }

  /** Start writing a new comment on [from, to). */
  newComment(from, to) {
    const ctx = this.opts.getCtx();
    if (!ctx) return;
    this.pendingNew = { from, to, quote: ctx.ytext.toString().slice(from, to) };
    this.render();
    setTimeout(() => this.el.querySelector('textarea[data-key="new"]')?.focus(), 30);
  }

  focusThread(id) {
    const card = this.el.querySelector(`[data-thread-card="${id}"]`);
    this.el.querySelectorAll('.rv-card.active').forEach((c) => c.classList.remove('active'));
    if (card) { card.classList.add('active'); card.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
  }

  /** Re-render soon (coalesced). */
  update() {
    if (this.scheduled) return;
    this.scheduled = true;
    requestAnimationFrame(() => { this.scheduled = false; this.render(); });
  }

  /** Jump to a range. Threads get a cursor + strong highlight (no selection, so no Comment button). */
  select(from, to, threadId) {
    const ctx = this.opts.getCtx();
    if (!ctx?.view) return;
    const len = ctx.view.state.doc.length;
    ctx.view.dispatch({
      selection: threadId ? { anchor: Math.min(from, len) } : { anchor: Math.min(from, len), head: Math.min(to, len) },
      effects: [EditorView.scrollIntoView(Math.min(from, len), { y: 'center' }), setActiveThread.of(threadId || null)],
    });
    ctx.view.focus();
  }

  render() {
    const ctx = this.opts.getCtx();
    const { user } = this.opts;
    const canEdit = this.opts.canEdit();
    // Preserve focus/caret in a reply box across re-renders.
    const focused = document.activeElement?.closest?.('.review') ? document.activeElement : null;
    const focusKey = focused?.dataset?.key;
    const caret = focused && 'selectionStart' in focused ? [focused.selectionStart, focused.selectionEnd] : null;

    const tracking = this.opts.isTracking();
    const toggle = h('label', { class: 'rv-switch', title: 'When on, everyone’s edits in this project are recorded as suggestions' },
      h('input', { type: 'checkbox', checked: tracking, disabled: !canEdit, onchange: (e) => this.opts.setTracking(e.target.checked) }),
      h('span', { class: 'rv-slider' }), h('span', {}, 'Track changes'));
    const head = h('div', { class: 'rv-head' }, h('strong', {}, 'Review'), h('div', { class: 'spacer' }), toggle,
      h('button', { class: 'icon-btn', 'aria-label': 'Close review panel', onclick: () => this.opts.onClose() }, '✕'));

    if (!ctx) { this.el.replaceChildren(head, h('div', { class: 'muted pad small' }, 'Open a text file to review it.')); return; }
    const { ydoc, ytext } = ctx;
    const changes = trackedChanges(ytext);
    const all = threads(ydoc);
    const open = all.filter((t) => !t.resolved);
    const resolved = all.filter((t) => t.resolved);

    const textarea = (key, placeholder, onSubmit) => {
      const ta = h('textarea', {
        rows: key === 'new' ? 3 : 1, placeholder, 'data-key': key,
        oninput: (e) => { this.drafts.set(key, e.target.value); e.target.style.height = 'auto'; e.target.style.height = e.target.scrollHeight + 'px'; },
        onkeydown: (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSubmit(); } if (e.key === 'Escape' && key === 'new') { this.pendingNew = null; this.drafts.delete('new'); this.render(); } },
      });
      ta.value = this.drafts.get(key) || '';
      return ta;
    };

    const items = [];
    if (this.pendingNew) {
      const submit = () => {
        const text = (this.drafts.get('new') || '').trim();
        if (!text) return;
        const id = addThread(ydoc, ytext, this.pendingNew.from, this.pendingNew.to, user, text);
        this.pendingNew = null; this.drafts.delete('new');
        this.render();
        this.select(threads(ydoc).find((t) => t.id === id)?.from ?? 0, threads(ydoc).find((t) => t.id === id)?.to ?? 0, id);
      };
      items.push({ pos: -1, el: h('div', { class: 'rv-card rv-new' },
        h('div', { class: 'rv-quote' }, '“', clip(this.pendingNew.quote, 140), '”'),
        textarea('new', 'Add your comment… (Enter to post, Shift+Enter for a new line)', submit),
        h('div', { class: 'rv-actions' },
          h('button', { class: 'btn small', onclick: () => { this.pendingNew = null; this.drafts.delete('new'); this.render(); } }, 'Cancel'),
          h('button', { class: 'btn small primary', onclick: submit }, 'Comment'))) });
    }

    for (const c of changes) {
      items.push({ pos: c.from, el: h('div', {
        class: `rv-card rv-change rv-${c.kind}`, style: { borderLeftColor: c.color || '#888' },
        onclick: (e) => { if (!e.target.closest('button')) this.select(c.from, c.to); },
      },
      h('div', { class: 'rv-meta' }, avatar({ name: c.name || '?', color: c.color }), h('span', {}, h('strong', {}, c.name || 'Someone'), c.kind === 'ins' ? ' added' : ' deleted'), h('span', { class: 'muted small' }, c.ts ? timeAgo(c.ts) : '')),
      h('div', { class: 'rv-text ' + (c.kind === 'ins' ? 'rv-ins-text' : 'rv-del-text') }, clip(c.text.replace(/\n/g, '↵ '), 160)),
      canEdit && h('div', { class: 'rv-actions' },
        h('button', { class: 'btn tiny', title: 'Reject', onclick: () => rejectChange(ydoc, ytext, c) }, '✕ Reject'),
        h('button', { class: 'btn tiny primary', title: 'Accept', onclick: () => acceptChange(ydoc, ytext, c) }, '✓ Accept'))) });
    }

    for (const t of open) {
      items.push({ pos: t.orphaned ? Infinity : t.from, el: this.threadCard(t, ydoc, textarea) });
    }
    items.sort((a, b) => a.pos - b.pos);

    const body = h('div', { class: 'rv-body' },
      items.length ? items.map((i) => i.el) : h('div', { class: 'rv-empty' },
        h('p', {}, 'No suggestions or comments in this file.'),
        h('p', { class: 'muted small' }, 'Select text and click 💬 Comment to start a discussion. Turn on Track changes to make edits reviewable.')),
      resolved.length ? h('details', { class: 'rv-resolved', open: this.showResolved, ontoggle: (e) => (this.showResolved = e.target.open) },
        h('summary', {}, `Resolved comments (${resolved.length})`),
        resolved.map((t) => this.threadCard(t, ydoc, textarea))) : null);

    const foot = changes.length && canEdit ? h('div', { class: 'rv-foot' },
      h('span', { class: 'muted small' }, `${changes.length} suggestion${changes.length > 1 ? 's' : ''}`), h('div', { class: 'spacer' }),
      h('button', { class: 'btn tiny', onclick: () => { if (confirm('Reject all suggestions in this file?')) resolveAll(ydoc, ytext, false); } }, 'Reject all'),
      h('button', { class: 'btn tiny primary', onclick: () => { if (confirm('Accept all suggestions in this file?')) resolveAll(ydoc, ytext, true); } }, 'Accept all')) : null;

    const banner = tracking ? h('div', { class: 'rv-banner' }, '● Tracking changes: everyone’s edits are recorded as suggestions.') : null;
    this.el.replaceChildren(head, banner || '', body, foot || '');

    if (focusKey) {
      const ta = this.el.querySelector(`[data-key="${CSS.escape(focusKey)}"]`);
      if (ta) { ta.focus(); if (caret) ta.setSelectionRange(caret[0], caret[1]); }
    }
  }

  threadCard(t, ydoc, textarea) {
    const { user } = this.opts;
    const canEdit = this.opts.canEdit();
    const canDelete = canEdit && (t.uid === user.id || this.opts.canModerate());
    const reply = () => {
      const text = (this.drafts.get(t.id) || '').trim();
      if (!text) return;
      replyThread(ydoc, t.id, user, text);
      this.drafts.delete(t.id);
    };
    return h('div', {
      class: 'rv-card rv-thread' + (t.resolved ? ' resolved' : ''), 'data-thread-card': t.id,
      onclick: (e) => { if (!e.target.closest('button,textarea') && !t.orphaned) this.select(t.from, t.to, t.id); },
    },
    h('div', { class: 'rv-quote' + (t.orphaned ? ' orphan' : '') }, t.orphaned ? 'Commented text was deleted: ' : '', '“', clip(t.quote, 120), '”'),
    t.messages.map((m) => h('div', { class: 'rv-msg' },
      h('div', { class: 'rv-meta' }, avatar({ name: m.name || '?', color: m.color }), h('strong', {}, m.name || 'Someone'), h('span', { class: 'muted small', title: new Date(m.ts).toLocaleString() }, timeAgo(m.ts))),
      h('div', { class: 'rv-body-text' }, m.text))),
    t.resolved
      ? h('div', { class: 'rv-actions' }, h('span', { class: 'muted small' }, `Resolved by ${t.resolvedBy || 'someone'}`), h('div', { class: 'spacer' }),
        canEdit && h('button', { class: 'btn tiny', onclick: () => setResolved(ydoc, t.id, false, user) }, 'Reopen'),
        canDelete && h('button', { class: 'btn tiny danger-text', onclick: () => { if (confirm('Delete this comment thread?')) deleteThread(ydoc, t.id); } }, 'Delete'))
      : canEdit && h('div', {},
        textarea(t.id, 'Reply…', reply),
        h('div', { class: 'rv-actions' },
          canDelete && h('button', { class: 'btn tiny danger-text', onclick: () => { if (confirm('Delete this comment thread?')) deleteThread(ydoc, t.id); } }, 'Delete'),
          h('div', { class: 'spacer' }),
          h('button', { class: 'btn tiny', onclick: () => setResolved(ydoc, t.id, true, user) }, '✓ Resolve'),
          h('button', { class: 'btn tiny primary', onclick: reply }, 'Reply'))));
  }

  counts() {
    const ctx = this.opts.getCtx();
    if (!ctx) return { changes: 0, comments: 0 };
    return { changes: trackedChanges(ctx.ytext).length, comments: threads(ctx.ydoc).filter((t) => !t.resolved).length };
  }
}

const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
