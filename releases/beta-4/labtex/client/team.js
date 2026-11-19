// Teammates & collaboration UI: sharing, notifications, team directory, profiles and tasks.
import { h, api, toast, modal, confirmBox, prompt, menu, avatar, timeAgo } from './util.js';

export const COLORS = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#42d4f4', '#f032e6', '#9a6324', '#469990', '#800000'];
export const colorFor = (id) => COLORS[id % COLORS.length];
export const ROLE_INFO = {
  viewer: { label: 'Viewer', desc: 'Can read, compile and download' },
  commenter: { label: 'Commenter', desc: 'Viewer + can comment and create tasks' },
  editor: { label: 'Editor', desc: 'Commenter + can edit files and review changes' },
  admin: { label: 'Admin', desc: 'Editor + can manage sharing and project settings' },
  owner: { label: 'Owner', desc: 'Admin + can delete the project or transfer ownership' },
};
const RANK = { viewer: 1, commenter: 2, editor: 3, admin: 4, owner: 5 };
export const atLeast = (role, needed) => !!role && RANK[role] >= RANK[needed];
export const roleLabel = (r) => ROLE_INFO[r]?.label || r;

let teamCache = null, teamCacheAt = 0;
export async function team(force = false) {
  if (!force && teamCache && Date.now() - teamCacheAt < 30000) return teamCache;
  try { teamCache = await api('/api/team'); } catch { teamCache = []; } // not on the lab team: no directory
  teamCacheAt = Date.now();
  return teamCache;
}
const personAvatar = (u, title) => avatar({ name: u.name || '?', color: colorFor(u.id) }, title);
const lastSeen = (u) => (u.online ? 'Online now' : u.last_seen_at ? `Active ${timeAgo(u.last_seen_at)}` : 'Never signed in');

// ---------------------------------------------------------------------------
// Sharing
// ---------------------------------------------------------------------------

/** Share dialog for a project. Works for any role; only owner/admin can change things. */
export async function shareDialog(projectId, me, { onChange } = {}) {
  let project = await api(`/api/projects/${projectId}`);
  const people = await team();
  return modal(`Share “${project.name}”`, (close) => {
    const root = h('div', { class: 'share' });
    const draw = () => {
      const canManage = atLeast(project.role, 'admin');
      const isOwner = project.role === 'owner';
      const memberIds = new Set(project.members.map((m) => m.id));

      // Add people (autocomplete over the lab directory)
      const input = h('input', { type: 'text', placeholder: me.lab_member ? 'Name of a lab member, or anyone’s email' : 'Email of the person to share with', autocomplete: 'off', 'aria-label': 'Person to share with' });
      const roleSel = h('select', { 'aria-label': 'Role' }, ['viewer', 'commenter', 'editor', 'admin'].map((r) => h('option', { value: r, selected: r === 'editor' }, roleLabel(r))));
      const suggest = h('div', { class: 'suggest', hidden: true, role: 'listbox' });
      let picked = null;
      const showSuggest = () => {
        const q = input.value.trim().toLowerCase();
        picked = null;
        const hits = people.filter((u) => !memberIds.has(u.id) && (!q || u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q))).slice(0, 6);
        suggest.replaceChildren(...hits.map((u) => h('button', {
          type: 'button', class: 'suggest-item', role: 'option',
          onmousedown: (e) => { e.preventDefault(); picked = u; input.value = u.name; suggest.hidden = true; },
        }, personAvatar(u), h('span', {}, h('strong', {}, u.name), h('span', { class: 'muted small' }, ` ${u.email}`)))));
        suggest.hidden = !hits.length || document.activeElement !== input;
      };
      input.addEventListener('input', showSuggest);
      input.addEventListener('focus', showSuggest);
      input.addEventListener('blur', () => setTimeout(() => (suggest.hidden = true), 150));
      const err = h('div', { class: 'form-error' });
      const add = async (e) => {
        e.preventDefault(); err.textContent = '';
        const q = input.value.trim().toLowerCase();
        const u = picked || people.find((p) => p.email.toLowerCase() === q || p.name.toLowerCase() === q);
        try {
          await api(`/api/projects/${projectId}/members`, { method: 'POST', body: u ? { userId: u.id, role: roleSel.value } : { email: input.value.trim(), role: roleSel.value } });
          toast(`Shared with ${u ? u.name : input.value.trim()} as ${roleLabel(roleSel.value)}`, 'ok');
          await reload();
        } catch (ex) { err.textContent = ex.message; }
      };

      // Whole lab
      const labSel = h('select', { disabled: !canManage || project.is_lab, 'aria-label': 'Access for everyone in the lab',
        onchange: async (e) => {
          try {
            await api(`/api/projects/${projectId}`, { method: 'PATCH', body: { lab_role: e.target.value || null } });
            toast(e.target.value ? `Everyone in the lab can now ${e.target.value === 'viewer' ? 'view' : e.target.value === 'commenter' ? 'comment on' : 'edit'} this project` : 'No longer shared with the whole lab', 'ok');
            await reload();
          } catch (ex) { toast(ex.message, 'error'); e.target.value = project.lab_role || ''; }
        } },
      [['', 'Only people added below'], ['viewer', 'Everyone in the lab can view'], ['commenter', 'Everyone in the lab can comment'], ['editor', 'Everyone in the lab can edit']]
        .map(([v, l]) => h('option', { value: v, selected: (project.lab_role || '') === v }, l)));

      const rows = project.members.map((m) => {
        const editable = canManage && m.role !== 'owner' && !(m.id === me.id && !isOwner);
        const sel = editable ? h('select', { 'aria-label': `Role for ${m.name}`, onchange: async (e) => {
          const role = e.target.value;
          try {
            if (role === 'remove') {
              if (!(await confirmBox('Remove access', `Remove ${m.name} from this project?`, { okText: 'Remove', danger: true }))) { e.target.value = m.role; return; }
              await api(`/api/projects/${projectId}/members/${m.id}`, { method: 'DELETE' });
            } else if (role === 'owner') {
              if (!(await confirmBox('Transfer ownership', `Make ${m.name} the owner? You will become an admin of this project.`, { okText: 'Transfer' }))) { e.target.value = m.role; return; }
              await api(`/api/projects/${projectId}/members/${m.id}`, { method: 'PATCH', body: { role } });
            } else await api(`/api/projects/${projectId}/members/${m.id}`, { method: 'PATCH', body: { role } });
            await reload();
          } catch (ex) { toast(ex.message, 'error'); e.target.value = m.role; }
        } }, ['viewer', 'commenter', 'editor', 'admin'].map((r) => h('option', { value: r, selected: m.role === r }, roleLabel(r))),
        isOwner && h('option', { value: 'owner' }, 'Make owner'), h('option', { value: 'remove' }, 'Remove access')) : h('span', { class: `role role-${m.role}` }, roleLabel(m.role));
        return h('div', { class: 'member' }, personAvatar(m),
          h('div', { class: 'grow' }, h('div', {}, m.name, m.id === me.id ? h('span', { class: 'muted small' }, ' (you)') : null),
            h('div', { class: 'muted small' }, [m.title, m.email].filter(Boolean).join(' · '))), sel);
      });

      root.replaceChildren(h('div', {},
        canManage && !project.is_lab ? h('form', { class: 'share-add', onsubmit: add }, h('div', { class: 'share-input' }, input, suggest), roleSel, h('button', { class: 'btn primary', type: 'submit' }, 'Share')) : null,
        err,
        !project.is_lab && (me.lab_member || project.lab_role) && h('div', { class: 'share-lab' }, h('span', { class: 'share-lab-ico' }, '🏛'), h('div', { class: 'grow' }, h('strong', {}, 'Lab workspace'), h('div', { class: 'muted small' }, 'Give every lab member access, including people who join later.')), labSel),
        h('h4', {}, `People with access (${project.members.length})`),
        h('div', { class: 'members' }, rows),
        h('details', { class: 'roles-help' }, h('summary', {}, 'What can each role do?'),
          h('ul', {}, Object.entries(ROLE_INFO).map(([k, v]) => h('li', {}, h('span', { class: `role role-${k}` }, v.label), ' ', v.desc)))),
        !canManage && h('p', { class: 'muted small' }, 'Only the owner or a project admin can change sharing.')));
    };
    const reload = async () => { project = await api(`/api/projects/${projectId}`); draw(); onChange?.(project); };
    draw();
    return root;
  });
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

const ROLE_VERB = { viewer: 'view', commenter: 'comment on', editor: 'edit', admin: 'manage', owner: 'own' };

/** Text, target and icon for a notification. */
export function describe(n) {
  const who = n.actor?.name || 'Someone';
  const proj = n.project?.name || n.data.name || 'a project';
  const d = n.data || {};
  const pid = n.project?.id;
  const at = d.path ? ` on ${d.path}` : '';
  switch (n.type) {
    case 'share': return { icon: '👥', text: `${who} shared “${proj}” with you as ${roleLabel(d.role)}`, pid };
    case 'lab_share': return { icon: '🏛', text: `${who} shared “${proj}” with the whole lab (everyone can ${ROLE_VERB[d.role] || 'view'} it)`, pid };
    case 'role_change': return { icon: '🔑', text: d.role === 'owner' ? `${who} made you the owner of “${proj}”` : `${who} changed your role in “${proj}” to ${roleLabel(d.role)}`, pid };
    case 'task_assigned': return { icon: '✅', text: `${who} assigned you “${d.title}” in ${proj}${d.due ? ` (due ${fmtDate(d.due)})` : ''}`, pid, task: n.task_id };
    case 'task_status': return { icon: d.status === 'done' ? '🎉' : '🔄', text: `${who} ${d.status === 'done' ? 'completed' : d.status === 'doing' ? 'started' : 'reopened'} “${d.title}” in ${proj}`, pid, task: n.task_id };
    case 'task_due': return { icon: '⏰', text: d.overdue ? `“${d.title}” in ${proj} is overdue (was due ${fmtDate(d.due)})` : `“${d.title}” in ${proj} is due ${fmtDate(d.due)}`, pid, task: n.task_id };
    case 'comment_new': return { icon: '💬', text: `${who} commented${at} in ${proj}: “${d.text}”`, pid, fileId: d.fileId, thread: d.threadId };
    case 'comment_reply': return { icon: '💬', text: `${who} replied${at} in ${proj}: “${d.text}”`, pid, fileId: d.fileId, thread: d.threadId };
    case 'comment_mention': return { icon: '＠', text: `${who} mentioned you${at} in ${proj}: “${d.text}”`, pid, fileId: d.fileId, thread: d.threadId };
    case 'comment_resolved': return { icon: '✔', text: `${who} resolved your comment${at} in ${proj}`, pid, fileId: d.fileId, thread: d.threadId };
    case 'signup_request': return { icon: '🙋', text: `${d.name} (${d.email}) signed up for LabTeX. Add them to the lab team?`, href: '#/team' };
    case 'lab_joined': return { icon: '🏛', text: `${who} added you to the lab team. You can now see the Team directory, the lab library and lab-wide projects.`, href: '#/team' };
    case 'version': return { icon: '🏷', text: `${who} saved version “${d.label}” of ${proj}`, pid, history: true };
    default: return { icon: '•', text: `${who} updated ${proj}`, pid };
  }
}
export function fmtDate(iso) {
  if (!iso) return '';
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const d = new Date(iso + 'T00:00:00');
  const diff = Math.round((d - today) / 864e5);
  if (diff === 0) return 'today';
  if (diff === 1) return 'tomorrow';
  if (diff === -1) return 'yesterday';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(d.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}) });
}

/** Where a notification leads. The editor picks up the pending target after opening. */
export function openTarget(t) {
  if (t.href) { if (location.hash === t.href) window.dispatchEvent(new HashChangeEvent('hashchange')); else location.hash = t.href; return; }
  if (!t.pid) return;
  try { sessionStorage.setItem('labtex.pending', JSON.stringify({ pid: t.pid, fileId: t.fileId, thread: t.thread, task: t.task, history: t.history })); } catch {}
  if (location.hash === `#/p/${t.pid}`) window.dispatchEvent(new Event('labtex:pending'));
  else location.hash = `#/p/${t.pid}`;
}
export function takePending(pid) {
  try {
    const p = JSON.parse(sessionStorage.getItem('labtex.pending') || 'null');
    if (p && p.pid === pid) { sessionStorage.removeItem('labtex.pending'); return p; }
  } catch {}
  return null;
}

// One live connection per tab; every bell on the page shares the same state.
const notif = { unread: 0, sock: null, retry: 0, bells: new Set(), started: false, me: null };
export function startNotifications(me) {
  notif.me = me;
  if (notif.started) return;
  notif.started = true;
  const connect = () => {
    const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws/user');
    notif.sock = ws;
    ws.onopen = () => { notif.retry = 0; };
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (typeof msg.unread === 'number') { notif.unread = msg.unread; notif.bells.forEach((b) => b.update()); }
      if (msg.type === 'notification') onNew(msg.notification);
    };
    ws.onclose = () => { notif.sock = null; if (notif.started) setTimeout(connect, Math.min(15000, 1000 * 2 ** notif.retry++)); };
  };
  connect();
  // Keep "last active" fresh while the tab is open.
  setInterval(() => { if (notif.sock?.readyState === 1 && !document.hidden) notif.sock.send('ping'); }, 60000);
}
export function stopNotifications() {
  notif.started = false;
  notif.sock?.close();
}
function onNew(n) {
  const t = describe(n);
  if (document.hidden && localStorage.getItem('labtex.desktopNotify') === '1' && 'Notification' in window && Notification.permission === 'granted') {
    const dn = new Notification('LabTeX', { body: t.text, tag: `labtex-${n.id}` });
    dn.onclick = () => { window.focus(); markRead([n.id]); openTarget(t); dn.close(); };
  } else {
    const el = toast(h('span', { class: 'toast-link', onclick: () => { markRead([n.id]); openTarget(t); } }, `${t.icon} ${t.text}`), 'info', 6000);
  }
  notif.bells.forEach((b) => b.prepend?.(n));
}
async function markRead(ids) {
  try { const r = await api('/api/notifications/read', { method: 'POST', body: ids === 'all' ? { all: true } : { ids } }); notif.unread = r.unread; notif.bells.forEach((b) => b.update()); } catch {}
}

/** The bell button + dropdown panel. */
export function bellButton() {
  const badge = h('span', { class: 'bell-badge', hidden: true });
  const btn = h('button', { class: 'icon-btn bell-btn', 'aria-label': 'Notifications', title: 'Notifications', onclick: () => openPanel() }, '🔔', badge);
  const bell = {
    update() {
      badge.hidden = !notif.unread;
      badge.textContent = notif.unread > 99 ? '99+' : String(notif.unread);
      btn.setAttribute('aria-label', notif.unread ? `Notifications (${notif.unread} unread)` : 'Notifications');
    },
  };
  notif.bells.add(bell);
  bell.update();
  // Remove from the set when the button leaves the page.
  const mo = new MutationObserver(() => { if (!btn.isConnected) { notif.bells.delete(bell); mo.disconnect(); } });
  setTimeout(() => mo.observe(document.body, { childList: true, subtree: true }));

  async function openPanel() {
    document.querySelectorAll('.notif-panel').forEach((p) => p.remove());
    const list = h('div', { class: 'notif-list' }, h('div', { class: 'muted pad small' }, 'Loading…'));
    const desktop = h('input', { type: 'checkbox', checked: localStorage.getItem('labtex.desktopNotify') === '1', onchange: async (e) => {
      if (e.target.checked && 'Notification' in window && Notification.permission !== 'granted') {
        const p = await Notification.requestPermission();
        if (p !== 'granted') { e.target.checked = false; toast('Your browser blocked desktop notifications for this site.', 'error'); return; }
      }
      localStorage.setItem('labtex.desktopNotify', e.target.checked ? '1' : '0');
    } });
    const panel = h('div', { class: 'notif-panel', role: 'dialog', 'aria-label': 'Notifications' },
      h('div', { class: 'notif-head' }, h('strong', {}, 'Notifications'), h('div', { class: 'spacer' }),
        h('button', { class: 'btn tiny', onclick: async () => { await markRead('all'); panel.querySelectorAll('.notif-item.unread').forEach((x) => x.classList.remove('unread')); } }, 'Mark all read')),
      list,
      h('label', { class: 'notif-foot' }, desktop, 'Show desktop notifications when LabTeX is in the background'));
    document.body.append(panel);
    const r = btn.getBoundingClientRect();
    panel.style.top = r.bottom + 6 + 'px';
    panel.style.right = Math.max(8, innerWidth - r.right - 8) + 'px';
    const off = (e) => { if (!panel.contains(e.target) && !btn.contains(e.target)) { panel.remove(); document.removeEventListener('mousedown', off, true); } };
    setTimeout(() => document.addEventListener('mousedown', off, true));
    const item = (n) => {
      const t = describe(n);
      return h('button', { class: 'notif-item' + (n.read ? '' : ' unread'), onclick: () => { panel.remove(); if (!n.read) markRead([n.id]); openTarget(t); } },
        h('span', { class: 'notif-ico' }, n.actor ? personAvatar(n.actor) : t.icon),
        h('span', { class: 'notif-text' }, h('span', {}, t.text), h('span', { class: 'muted small' }, `${t.icon} ${timeAgo(n.created_at)}`)),
        !n.read && h('span', { class: 'notif-dot', 'aria-label': 'unread' }));
    };
    bell.prepend = (n) => { list.querySelector('.notif-empty')?.remove(); list.prepend(item(n)); };
    try {
      const { items } = await api('/api/notifications?limit=40');
      list.replaceChildren(...(items.length ? items.map(item) : [h('div', { class: 'notif-empty muted pad' }, 'You’re all caught up. Shares, task assignments, comment replies and @mentions will show up here.')]));
    } catch (e) { list.replaceChildren(h('div', { class: 'form-error pad' }, e.message)); }
  }
  return btn;
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

const STATUS = { todo: 'To do', doing: 'In progress', done: 'Done' };
export function dueBadge(t) {
  if (!t.due_date) return null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const d = new Date(t.due_date + 'T00:00:00');
  const overdue = t.status !== 'done' && d < today;
  const soon = t.status !== 'done' && !overdue && d - today <= 2 * 864e5;
  return h('span', { class: 'due' + (overdue ? ' overdue' : soon ? ' soon' : ''), title: `Due ${d.toLocaleDateString()}` }, overdue ? `Overdue · ${fmtDate(t.due_date)}` : `Due ${fmtDate(t.due_date)}`);
}

/** People a task can be assigned to: members, or everyone when the project is shared with the lab. */
export async function assignable(project) {
  if (project.lab_role || project.is_lab) return (await team()).map((u) => ({ id: u.id, name: u.name }));
  return project.members.map((m) => ({ id: m.id, name: m.name }));
}

/** Create or edit a task. Resolves with the saved task, or undefined. */
export async function taskModal(project, me, { task = null, preset = {} } = {}) {
  const people = await assignable(project);
  const canEditAll = !task || atLeast(project.role, 'editor') || task.created_by === me.id;
  return modal(task ? 'Edit task' : 'New task', (close) => {
    const v = { title: '', description: '', assignee_id: '', due_date: '', status: 'todo', file_path: '', line: '', ...preset, ...(task || {}) };
    const title = h('input', { type: 'text', value: v.title, placeholder: 'e.g. Write the related-work section', required: true, disabled: !canEditAll });
    const desc = h('textarea', { rows: 3, placeholder: 'Details (optional)', disabled: !canEditAll }); desc.value = v.description || '';
    const who = h('select', { disabled: !canEditAll }, h('option', { value: '' }, 'Unassigned'), people.map((p) => h('option', { value: p.id, selected: String(v.assignee_id) === String(p.id) }, p.id === me.id ? `${p.name} (me)` : p.name)));
    const due = h('input', { type: 'date', value: v.due_date || '', disabled: !canEditAll });
    const status = h('select', {}, Object.entries(STATUS).map(([k, l]) => h('option', { value: k, selected: v.status === k }, l)));
    const link = v.file_path ? h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: true, disabled: !canEditAll, 'data-link': '1' }), `Linked to ${v.file_path}${v.line ? `:${v.line}` : ''}`) : null;
    const err = h('div', { class: 'form-error' });
    return h('form', { class: 'task-form', onsubmit: async (e) => {
      e.preventDefault(); err.textContent = '';
      const keepLink = link?.querySelector('input').checked;
      const body = canEditAll
        ? { title: title.value, description: desc.value, assignee_id: who.value ? Number(who.value) : null, due_date: due.value || null, status: status.value,
          file_path: keepLink ? v.file_path : null, line: keepLink ? v.line || null : null }
        : { status: status.value };
      try {
        const saved = task
          ? await api(`/api/projects/${project.id}/tasks/${task.id}`, { method: 'PATCH', body })
          : await api(`/api/projects/${project.id}/tasks`, { method: 'POST', body });
        toast(task ? 'Task updated' : body.assignee_id && body.assignee_id !== me.id ? `Task assigned to ${people.find((p) => p.id === body.assignee_id)?.name}` : 'Task created', 'ok');
        close(saved);
      } catch (ex) { err.textContent = ex.message; }
    } },
    h('label', {}, 'Task', title),
    h('label', {}, 'Description', desc),
    h('div', { class: 'task-grid' }, h('label', {}, 'Assignee', who), h('label', {}, 'Due date', due), h('label', {}, 'Status', status)),
    link, !canEditAll && h('p', { class: 'hint' }, 'This task is assigned to you: you can update its status.'),
    err,
    h('div', { class: 'modal-actions' },
      task && canEditAll && h('button', { type: 'button', class: 'btn danger-text', onclick: async () => {
        if (!(await confirmBox('Delete task', `Delete “${task.title}”?`, { okText: 'Delete', danger: true }))) return;
        try { await api(`/api/projects/${project.id}/tasks/${task.id}`, { method: 'DELETE' }); toast('Task deleted'); close({ deleted: true }); } catch (ex) { err.textContent = ex.message; }
      } }, 'Delete'),
      h('div', { class: 'spacer' }),
      h('button', { type: 'button', class: 'btn', onclick: () => close() }, 'Cancel'),
      h('button', { type: 'submit', class: 'btn primary' }, task ? 'Save' : 'Create task')));
  });
}

/** One task row; `onOpen(task)` opens it, `project` is used for permission hints. */
export function taskRow(t, me, { onToggle, onOpen, showProject = false, onOpenLink } = {}) {
  const canToggle = t.assignee_id === me.id || t.created_by === me.id || t._canEdit;
  return h('div', { class: `task-row status-${t.status}`, 'data-task': t.id },
    h('input', { type: 'checkbox', checked: t.status === 'done', disabled: !canToggle, title: canToggle ? (t.status === 'done' ? 'Mark as not done' : 'Mark as done') : 'Only the assignee, creator or an editor can change this',
      'aria-label': `Done: ${t.title}`, onchange: (e) => onToggle?.(t, e.target.checked) }),
    h('div', { class: 'task-main', role: 'button', tabindex: '0', onclick: () => onOpen?.(t), onkeydown: (e) => { if (e.key === 'Enter') onOpen?.(t); } },
      h('div', { class: 'task-title' }, t.title),
      h('div', { class: 'task-meta' },
        t.status === 'doing' && h('span', { class: 'chip-doing' }, 'In progress'),
        dueBadge(t),
        showProject && t.project_name && h('a', { href: `#/p/${t.project_id}`, class: 'small', onclick: (e) => e.stopPropagation() }, t.project_name),
        t.file_path && h('a', { href: '#', class: 'small task-link', onclick: (e) => { e.preventDefault(); e.stopPropagation(); onOpenLink?.(t); } }, `${t.file_path}${t.line ? ':' + t.line : ''}`),
        h('span', { class: 'muted small' }, t.created_by_name ? `from ${t.created_by_id === me.id || t.created_by === me.id ? 'you' : t.created_by_name}` : ''))),
    t.assignee_id ? personAvatar({ id: t.assignee_id, name: t.assignee_name || '?' }, `Assigned to ${t.assignee_name}`) : h('span', { class: 'avatar unassigned', title: 'Unassigned' }, '?'));
}

/** Side drawer listing a project's tasks (used in the editor). */
export class TasksDrawer {
  constructor({ getProject, me, getCurrentLocation, onOpenLink }) {
    this.getProject = getProject; this.me = me; this.getCurrentLocation = getCurrentLocation; this.onOpenLink = onOpenLink;
    this.filter = localStorage.getItem('labtex.taskFilter') || 'open';
    this.tasks = [];
    this.el = h('aside', { class: 'tasks-drawer', hidden: true, 'aria-label': 'Tasks' });
  }
  get open() { return !this.el.hidden; }
  toggle(force) { this.el.hidden = force === undefined ? !this.el.hidden : !force; if (this.open) { this.onOpen?.(); this.load(); } }
  async load() {
    const p = this.getProject();
    try { this.tasks = await api(`/api/projects/${p.id}/tasks`); } catch (e) { toast(e.message, 'error'); }
    this.render();
    this.onCount?.(this.tasks.filter((t) => t.status !== 'done').length);
  }
  async newTask(preset = {}) {
    const p = this.getProject();
    const saved = await taskModal(p, this.me, { preset });
    if (saved) { this.toggle(true); await this.load(); this.flash(saved.id); }
  }
  async edit(t) {
    const saved = await taskModal(this.getProject(), this.me, { task: t });
    if (saved) await this.load();
  }
  async toggleDone(t, done) {
    try { await api(`/api/projects/${this.getProject().id}/tasks/${t.id}`, { method: 'PATCH', body: { status: done ? 'done' : 'todo' } }); } catch (e) { toast(e.message, 'error'); }
    await this.load();
  }
  flash(id) {
    const row = this.el.querySelector(`[data-task="${id}"]`);
    if (row) { row.scrollIntoView({ block: 'nearest' }); row.classList.add('flash'); setTimeout(() => row.classList.remove('flash'), 2000); }
  }
  render() {
    const p = this.getProject();
    const me = this.me;
    const canCreate = atLeast(p.role, 'commenter');
    const canEdit = atLeast(p.role, 'editor');
    const filters = [['open', 'Open'], ['mine', 'Mine'], ['done', 'Done'], ['all', 'All']];
    let list = this.tasks.map((t) => ({ ...t, _canEdit: canEdit }));
    if (this.filter === 'open') list = list.filter((t) => t.status !== 'done');
    if (this.filter === 'done') list = list.filter((t) => t.status === 'done');
    if (this.filter === 'mine') list = list.filter((t) => t.assignee_id === me.id && t.status !== 'done');
    const groups = this.filter === 'done' ? [['done', list]] : [['doing', list.filter((t) => t.status === 'doing')], ['todo', list.filter((t) => t.status === 'todo')], ['done', list.filter((t) => t.status === 'done')]];
    this.el.replaceChildren(
      h('div', { class: 'td-head' }, h('strong', {}, 'Tasks'), h('div', { class: 'spacer' }),
        canCreate && h('button', { class: 'btn small primary', onclick: () => {
          const loc = this.getCurrentLocation?.();
          this.newTask(loc ? { file_path: loc.path, line: loc.line } : {});
        } }, '+ New task'),
        h('button', { class: 'icon-btn', 'aria-label': 'Close tasks', onclick: () => this.toggle(false) }, '✕')),
      h('div', { class: 'td-filters', role: 'tablist' }, filters.map(([k, l]) => h('button', { class: 'tab' + (this.filter === k ? ' active' : ''), role: 'tab', onclick: () => { this.filter = k; localStorage.setItem('labtex.taskFilter', k); this.render(); } }, l))),
      h('div', { class: 'td-body' },
        list.length ? groups.filter(([, items]) => items.length).map(([st, items]) => h('div', { class: 'td-group' },
          h('div', { class: 'td-group-head' }, `${STATUS[st]} · ${items.length}`),
          items.map((t) => taskRow(t, me, { onToggle: (x, d) => this.toggleDone(x, d), onOpen: (x) => this.edit(x), onOpenLink: (x) => this.onOpenLink?.(x) }))))
          : h('div', { class: 'rv-empty' }, h('p', {}, this.tasks.length ? 'Nothing here.' : 'No tasks yet.'),
            h('p', { class: 'muted small' }, canCreate ? 'Create a task and assign it to a teammate. New tasks link to the line you’re on in the editor.' : 'Tasks created by teammates will show up here.'))));
  }
}

// ---------------------------------------------------------------------------
// Pages: team directory, profile, my tasks
// ---------------------------------------------------------------------------

export async function renderTeam(main, me, { adminActions }) {
  let query = '';
  const grid = h('div', { class: 'team-grid' });
  const search = h('input', { type: 'search', class: 'search', placeholder: 'Search by name, title or email…', oninput: () => { query = search.value.toLowerCase(); draw(); } });
  let people = [];
  const draw = () => {
    const rows = people.filter((u) => !query || [u.name, u.email, u.title].some((x) => (x || '').toLowerCase().includes(query)));
    grid.replaceChildren(...rows.map((u) => h('a', { class: 'person-card', href: `#/team/${u.id}` },
      h('div', { class: 'pc-top' },
        h('span', { class: 'pc-avatar' }, personAvatar(u), h('span', { class: 'presence-dot' + (u.online ? ' on' : ''), title: lastSeen(u) })),
        h('div', { class: 'grow' }, h('div', { class: 'pc-name' }, u.name, u.id === me.id && h('span', { class: 'muted small' }, ' (you)')),
          h('div', { class: 'muted small' }, u.title || 'Lab member')),
        u.is_admin && h('span', { class: 'role role-owner' }, 'Lab admin'),
        me.is_admin && h('button', { class: 'icon-btn', 'aria-label': `Admin actions for ${u.name}`, onclick: (e) => { e.preventDefault(); e.stopPropagation(); adminActions(e.currentTarget, u, refreshAll); } }, '⋯')),
      h('div', { class: 'pc-email muted small' }, u.email),
      h('div', { class: 'pc-stats small' },
        h('span', { class: u.online ? 'online-text' : 'muted' }, lastSeen(u)),
        u.id !== me.id && h('span', { class: 'muted' }, `${u.shared_projects} shared project${u.shared_projects === 1 ? '' : 's'}`),
        u.open_tasks ? h('span', { class: 'muted' }, `${u.open_tasks} open task${u.open_tasks === 1 ? '' : 's'}`) : null))));
    if (!rows.length) grid.replaceChildren(h('div', { class: 'empty' }, 'No one matches.'));
  };
  // Lab admins: requests to join + sign-up policy.
  const requests = h('section', { class: 'join-requests', hidden: true });
  let showAllGuests = false;
  const loadRequests = async () => {
    if (!me.is_admin) return;
    let s;
    try { s = await api('/api/admin/signups'); } catch { return; }
    const modeSel = h('select', { disabled: s.locked, 'aria-label': 'New sign-ups', onchange: async (e) => {
      try { await api('/api/admin/signups', { method: 'PATCH', body: { mode: e.target.value } }); toast('Sign-up setting saved', 'ok'); }
      catch (ex) { toast(ex.message, 'error'); e.target.value = s.mode; }
    } }, [['approval', 'Anyone can sign up; I add people to the lab team'], ['open', 'Anyone can sign up and joins the lab team automatically'], ['closed', 'Sign-up is off; only admins create accounts']]
      .map(([v, l]) => h('option', { value: v, selected: s.mode === v }, l)));
    const row = (u) => h('div', { class: 'jr-row' }, personAvatar(u),
      h('div', { class: 'grow' }, h('strong', {}, u.name), h('div', { class: 'muted small' },
        [u.email, `signed up ${timeAgo(u.created_at)}`, u.projects ? `${u.projects} project${u.projects === 1 ? '' : 's'}` : null].filter(Boolean).join(' · '))),
      h('button', { class: 'btn small', title: 'Delete this account', onclick: async () => {
        if (!(await confirmBox('Delete account', `Delete ${u.name}'s LabTeX account?${u.projects ? ` Their ${u.projects} project(s) will be transferred to you.` : ''}`, { okText: 'Delete', danger: true }))) return;
        try { await api(`/api/admin/users/${u.id}`, { method: 'DELETE' }); toast(`Deleted ${u.name}`); loadRequests(); } catch (ex) { toast(ex.message, 'error'); }
      } }, 'Delete account'),
      h('button', { class: 'btn primary', onclick: async () => {
        try { await api(`/api/admin/users/${u.id}/lab`, { method: 'POST', body: { member: true } }); toast(`${u.name} is now on the lab team`, 'ok'); loadRequests(); load(); } catch (ex) { toast(ex.message, 'error'); }
      } }, 'Add to lab team'));
    const shown = s.guests.slice(0, showAllGuests ? 1000 : 5);
    requests.hidden = false;
    requests.replaceChildren(h('div', {},
      h('div', { class: 'jr-head' }, h('h3', {}, `Not on the lab team · ${s.guests.length}`), h('div', { class: 'spacer' }),
        h('label', { class: 'jr-mode' }, h('span', { class: 'muted small' }, 'New sign-ups:'), modeSel)),
      h('p', { class: 'muted small jr-help' }, 'These people have LabTeX accounts and can use it for their own projects and anything shared with them directly. They can’t see the Team directory, the lab library, lab templates or lab-wide projects until you add them to the lab team.'),
      s.locked && h('p', { class: 'hint' }, 'Sign-up is turned off on the server (ALLOW_REGISTRATION=false).'),
      s.guests.length ? h('div', { class: 'plist' }, shown.map(row)) : h('p', { class: 'muted small' }, 'Everyone with an account is on the lab team.'),
      s.guests.length > shown.length && h('button', { class: 'btn ghost small', onclick: () => { showAllGuests = true; loadRequests(); } }, `Show all ${s.guests.length}`)));
  };
  const load = async () => { people = await team(true); draw(); };
  const refreshAll = () => { load(); loadRequests(); };
  main.replaceChildren(
    h('div', { class: 'dash-head' }, h('div', {}, h('h1', {}, 'Team'), h('p', { class: 'muted' }, 'Everyone in the lab. Open a profile to share a project or assign a task.')),
      me.is_admin && h('button', { class: 'btn primary', onclick: () => adminActions(null, null, refreshAll) }, '+ Add member')),
    requests,
    h('div', { class: 'dash-filters' }, h('div', {}), search),
    grid);
  loadRequests();
  await load();
  const timer = setInterval(() => { if (main.isConnected) { load(); loadRequests(); } else clearInterval(timer); }, 30000);
}

export async function renderProfile(main, me, uid) {
  let u;
  try { u = await api(`/api/team/${uid}`); }
  catch (e) { main.replaceChildren(h('div', { class: 'empty full' }, h('h3', {}, 'Not found'), h('a', { class: 'btn', href: '#/team' }, 'Back to Team'))); return; }
  const isMe = u.id === me.id;
  // Share a project
  const shareProj = h('select', { 'aria-label': 'Project to share' }, u.shareable.map((p) => h('option', { value: p.id }, p.name)));
  const shareRole = h('select', { 'aria-label': 'Role' }, ['viewer', 'commenter', 'editor', 'admin'].map((r) => h('option', { value: r, selected: r === 'editor' }, roleLabel(r))));
  const shareBox = !isMe && u.shareable.length ? h('form', { class: 'profile-action', onsubmit: async (e) => {
    e.preventDefault();
    try { await api(`/api/projects/${shareProj.value}/members`, { method: 'POST', body: { userId: u.id, role: shareRole.value } }); toast(`Shared with ${u.name}`, 'ok'); renderProfile(main, me, uid); }
    catch (ex) { toast(ex.message, 'error'); }
  } }, h('strong', {}, 'Share a project'), h('div', { class: 'pa-row' }, shareProj, shareRole, h('button', { class: 'btn primary', type: 'submit' }, 'Share'))) : null;
  // Assign a task (projects you can create tasks in that they can access)
  const myProjects = (await api('/api/projects')).filter((p) => atLeast(p.role, 'commenter'));
  const theirIds = new Set(u.projects.map((p) => p.id));
  const assignOptions = myProjects.filter((p) => theirIds.has(p.id) || p.lab_role);
  const assignProj = h('select', { 'aria-label': 'Project for the task' }, assignOptions.map((p) => h('option', { value: p.id }, p.name)));
  const assignBox = assignOptions.length ? h('div', { class: 'profile-action' }, h('strong', {}, isMe ? 'Create a task for yourself' : `Assign ${u.name.split(' ')[0]} a task`),
    h('div', { class: 'pa-row' }, assignProj, h('button', { class: 'btn primary', onclick: async () => {
      const project = await api(`/api/projects/${assignProj.value}`);
      const saved = await taskModal(project, me, { preset: { assignee_id: u.id } });
      if (saved) renderProfile(main, me, uid);
    } }, 'New task…'))) : null;

  main.replaceChildren(
    h('a', { href: '#/team', class: 'muted small' }, '← Team'),
    h('div', { class: 'profile-head' },
      h('span', { class: 'pc-avatar big' }, avatar({ name: u.name, color: colorFor(u.id) }), h('span', { class: 'presence-dot' + (u.online ? ' on' : '') })),
      h('div', { class: 'grow' }, h('h1', {}, u.name, isMe && h('span', { class: 'muted small' }, ' (you)')),
        h('div', { class: 'muted' }, [u.title || 'Lab member', u.is_admin ? 'Lab admin' : null].filter(Boolean).join(' · ')),
        h('div', { class: 'small' }, h('a', { href: `mailto:${u.email}` }, u.email), h('span', { class: 'muted' }, ` · ${lastSeen(u)}`)))),
    h('div', { class: 'profile-actions' }, shareBox, assignBox),
    h('div', { class: 'profile-cols' },
      h('section', {}, h('h3', {}, isMe ? 'Your projects' : 'Projects you share'),
        u.projects.length ? h('div', { class: 'plist' }, u.projects.map((p) => h('a', { class: 'plist-row', href: `#/p/${p.id}` }, h('span', { class: 'grow' }, p.name), h('span', { class: `role role-${p.role}` }, roleLabel(p.role)), h('span', { class: 'muted small' }, timeAgo(p.updated_at)))))
          : h('p', { class: 'muted' }, 'No shared projects yet.')),
      h('section', {}, h('h3', {}, 'Open tasks'),
        u.tasks.length ? h('div', { class: 'plist' }, u.tasks.map((t) => taskRow({ ...t, project_name: t.project_name }, me, {
          showProject: true,
          onOpen: (x) => openTarget({ pid: x.project_id, task: x.id }),
          onOpenLink: (x) => openTarget({ pid: x.project_id, task: x.id }),
          onToggle: async (x, d) => { try { await api(`/api/projects/${x.project_id}/tasks/${x.id}`, { method: 'PATCH', body: { status: d ? 'done' : 'todo' } }); } catch (e) { toast(e.message, 'error'); } renderProfile(main, me, uid); },
        }))) : h('p', { class: 'muted' }, 'Nothing assigned right now.'))));
}

export async function renderMyTasks(main, me) {
  let scope = localStorage.getItem('labtex.myTasksScope') || 'assigned';
  let showDone = false;
  const body = h('div', {});
  const tabs = h('div', { class: 'tabs', role: 'tablist' });
  const load = async () => {
    tabs.replaceChildren(...[['assigned', 'Assigned to me'], ['created', 'Created by me']].map(([k, l]) => h('button', { class: 'tab' + (scope === k ? ' active' : ''), role: 'tab', onclick: () => { scope = k; localStorage.setItem('labtex.myTasksScope', k); load(); } }, l)));
    const tasks = await api(`/api/tasks?scope=${scope}`);
    const open = tasks.filter((t) => t.status !== 'done');
    const done = tasks.filter((t) => t.status === 'done');
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const bucket = (t) => {
      if (!t.due_date) return 'Later / no date';
      const d = new Date(t.due_date + 'T00:00:00');
      if (d < today) return 'Overdue';
      if (d - today < 864e5) return 'Today';
      if (d - today <= 7 * 864e5) return 'This week';
      return 'Later / no date';
    };
    const order = ['Overdue', 'Today', 'This week', 'Later / no date'];
    const rowOpts = {
      showProject: true,
      onOpen: (x) => openTarget({ pid: x.project_id, task: x.id }),
      onOpenLink: (x) => openTarget({ pid: x.project_id, task: x.id }),
      onToggle: async (x, d) => { try { await api(`/api/projects/${x.project_id}/tasks/${x.id}`, { method: 'PATCH', body: { status: d ? 'done' : 'todo' } }); if (d) toast('Nice work! Task completed 🎉', 'ok'); } catch (e) { toast(e.message, 'error'); } load(); },
    };
    body.replaceChildren(h('div', {},
      open.length ? order.map((b) => { const items = open.filter((t) => bucket(t) === b); return items.length ? h('section', { class: 'mt-group' }, h('h3', { class: b === 'Overdue' ? 'overdue-h' : '' }, `${b} · ${items.length}`), h('div', { class: 'plist' }, items.map((t) => taskRow(t, me, rowOpts)))) : null; })
        : h('div', { class: 'empty' }, h('h3', {}, scope === 'assigned' ? 'No open tasks assigned to you' : 'You haven’t created any open tasks'), h('p', {}, 'Open a project and use ✓ Tasks to create one, or assign one from a teammate’s profile.')),
      done.length ? h('details', { class: 'mt-done', open: showDone, ontoggle: (e) => (showDone = e.target.open) }, h('summary', {}, `Completed (${done.length})`), h('div', { class: 'plist' }, done.slice(0, 100).map((t) => taskRow(t, me, rowOpts)))) : null));
  };
  main.replaceChildren(h('div', { class: 'dash-head' }, h('div', {}, h('h1', {}, 'My tasks'), h('p', { class: 'muted' }, 'Tasks across all your projects.'))), h('div', { class: 'dash-filters' }, tabs), body);
  await load();
}
