// Version history: list snapshots, diff against the current project, restore.
import { diffLines } from 'diff';
import { h, api, modal, toast, confirmBox, prompt, timeAgo, fmtBytes } from './util.js';

export function openHistory(projectId, canEdit) {
  return modal('History', (close) => {
    const list = h('div', { class: 'hist-list' });
    const detail = h('div', { class: 'hist-detail' }, h('div', { class: 'muted pad' }, 'Select a version to compare it with the current project.'));
    let selectedId = null;

    const loadList = async () => {
      const snaps = await api(`/api/projects/${projectId}/snapshots`);
      if (!snaps.length) { list.replaceChildren(h('div', { class: 'muted pad' }, 'No versions yet. Versions are saved automatically when you compile, or save one now.')); return; }
      // Group by day.
      const groups = new Map();
      for (const s of snaps) {
        const day = new Date(s.created_at).toLocaleDateString(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });
        if (!groups.has(day)) groups.set(day, []);
        groups.get(day).push(s);
      }
      list.replaceChildren(...[...groups].map(([day, items]) => h('div', {},
        h('div', { class: 'hist-day' }, day),
        items.map((s) => h('button', {
          class: 'hist-item' + (s.id === selectedId ? ' sel' : '') + (s.auto ? '' : ' labeled'), 'data-id': s.id,
          onclick: () => select(s.id),
        },
        h('div', { class: 'hist-time' }, new Date(s.created_at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }), h('span', { class: 'muted small' }, ` · ${timeAgo(s.created_at)}`)),
        s.label ? h('div', { class: 'hist-label' }, '🏷 ', s.label) : h('div', { class: 'muted small' }, 'Auto-saved on compile'),
        h('div', { class: 'muted small' }, s.user_name || 'Unknown'))))));
    };

    const select = async (id) => {
      selectedId = id;
      list.querySelectorAll('.hist-item').forEach((b) => b.classList.toggle('sel', Number(b.dataset.id) === id));
      detail.replaceChildren(h('div', { class: 'muted pad' }, 'Loading…'));
      const snap = await api(`/api/projects/${projectId}/snapshots/${id}`);
      const cur = new Map(snap.current.map((f) => [f.path, f]));
      const old = new Map(snap.files.map((f) => [f.path, f]));
      const paths = [...new Set([...old.keys(), ...cur.keys()])].sort();
      const changes = [];
      for (const p of paths) {
        const a = old.get(p), b = cur.get(p);
        if (a && !b) changes.push({ p, kind: 'deleted since', a, b });
        else if (!a && b) changes.push({ p, kind: 'added since', a, b });
        else if (a.is_binary || b.is_binary) { if (a.blob !== b.blob || a.is_binary !== b.is_binary) changes.push({ p, kind: 'changed', a, b }); }
        else if (a.content !== b.content) changes.push({ p, kind: 'changed', a, b });
      }
      const restoreFile = async (path) => {
        if (!(await confirmBox('Restore file', `Replace the current “${path}” with this version? A snapshot of the current state is saved first.`, { okText: 'Restore file' }))) return;
        await api(`/api/projects/${projectId}/snapshots/${id}/restore`, { method: 'POST', body: { path } });
        toast(`Restored ${path}`, 'ok'); loadList(); select(id);
      };
      detail.replaceChildren(
        h('div', { class: 'hist-head' },
          h('div', {}, h('strong', {}, snap.label || 'Auto-saved version'), h('div', { class: 'muted small' }, new Date(snap.created_at).toLocaleString(), ` · ${snap.files.length} files`)),
          h('div', { class: 'hist-actions' },
            canEdit && h('button', { class: 'btn small', onclick: async () => {
              const label = await prompt('Label this version', { value: snap.label || '', placeholder: 'e.g. Submitted to journal', okText: 'Save label' });
              if (label == null) return;
              await api(`/api/projects/${projectId}/snapshots/${id}`, { method: 'PATCH', body: { label } }); loadList(); select(id);
            } }, 'Label'),
            h('a', { class: 'btn small', href: `/api/projects/${projectId}/snapshots/${id}/zip` }, 'Download .zip'),
            canEdit && h('button', { class: 'btn small primary', onclick: async () => {
              if (!(await confirmBox('Restore project', 'Restore the whole project to this version? Files added since will be removed. The current state is saved as a version first, so you can undo this.', { okText: 'Restore project' }))) return;
              await api(`/api/projects/${projectId}/snapshots/${id}/restore`, { method: 'POST' });
              toast('Project restored', 'ok'); close(true);
            } }, 'Restore this version'))),
        changes.length === 0
          ? h('div', { class: 'muted pad' }, 'Identical to the current project.')
          : h('div', { class: 'diffs' },
            h('p', { class: 'muted small pad-x' }, `Changes between this version (red) and the current project (green): ${changes.length} file${changes.length > 1 ? 's' : ''}`),
            changes.map((c) => h('details', { class: 'diff-file', open: changes.length <= 4 },
              h('summary', {}, h('code', {}, c.p), h('span', { class: `chg chg-${c.kind.split(' ')[0]}` }, c.kind),
                canEdit && c.a && h('button', { class: 'btn tiny', onclick: (e) => { e.preventDefault(); restoreFile(c.p); } }, 'Restore file')),
              renderDiff(c)))));
    };

    const save = async () => {
      const label = await prompt('Save a version', { label: 'Label', placeholder: 'e.g. Draft sent to PI', okText: 'Save version' });
      if (label == null) return;
      await api(`/api/projects/${projectId}/snapshots`, { method: 'POST', body: { label } });
      toast('Version saved', 'ok'); loadList();
    };

    loadList();
    return h('div', { class: 'hist' },
      h('div', { class: 'hist-side' }, canEdit && h('button', { class: 'btn primary block', onclick: save }, '+ Save current version'), list),
      detail);
  }, { wide: true, tall: true });
}

function renderDiff({ a, b }) {
  if (a?.is_binary || b?.is_binary) {
    return h('div', { class: 'pad muted small' }, `Binary file: ${a ? fmtBytes(a.size) : 'absent'} → ${b ? fmtBytes(b.size) : 'absent'}`);
  }
  const parts = diffLines(a?.content ?? '', b?.content ?? '');
  const rows = [];
  let oldNo = 1, newNo = 1;
  for (const part of parts) {
    const lines = part.value.replace(/\n$/, '').split('\n');
    if (!part.added && !part.removed && lines.length > 6) {
      // Collapse long unchanged runs, keep 3 lines of context each side.
      const show = [...lines.slice(0, 3).map((l, i) => [l, oldNo + i, newNo + i]), null, ...lines.slice(-3).map((l, i) => [l, oldNo + lines.length - 3 + i, newNo + lines.length - 3 + i])];
      for (const s of show) rows.push(s ? h('div', { class: 'dl' }, h('span', { class: 'ln' }, s[1]), h('span', { class: 'ln' }, s[2]), h('span', { class: 'dt' }, ' ' + s[0])) : h('div', { class: 'dl skip' }, `⋯ ${lines.length - 6} unchanged lines`));
      oldNo += lines.length; newNo += lines.length;
      continue;
    }
    for (const l of lines) {
      if (part.added) rows.push(h('div', { class: 'dl add' }, h('span', { class: 'ln' }), h('span', { class: 'ln' }, newNo++), h('span', { class: 'dt' }, '+' + l)));
      else if (part.removed) rows.push(h('div', { class: 'dl del' }, h('span', { class: 'ln' }, oldNo++), h('span', { class: 'ln' }), h('span', { class: 'dt' }, '-' + l)));
      else rows.push(h('div', { class: 'dl' }, h('span', { class: 'ln' }, oldNo++), h('span', { class: 'ln' }, newNo++), h('span', { class: 'dt' }, ' ' + l)));
    }
  }
  return h('div', { class: 'diff' }, rows);
}

