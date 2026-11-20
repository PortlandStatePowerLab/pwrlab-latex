import { h, api, toast, modal, confirmBox, prompt, timeAgo, menu, avatar } from './util.js';
import { openEditor } from './editor.js';
import { themeButton } from './theme.js';
import { shareDialog, bellButton, startNotifications, stopNotifications, renderTeam, renderProfile, renderMyTasks, roleLabel, atLeast, taskRow, openTarget, dueBadge } from './team.js';

const app = document.getElementById('app');
let me = null;
let config = null;
let cleanup = null; // teardown for the current view

async function route() {
  if (cleanup) { try { cleanup(); } catch {} cleanup = null; }
  document.querySelectorAll('.overlay,.menu').forEach((e) => e.remove());
  const hash = location.hash.slice(1) || '/';
  config ??= await api('/api/config');
  if (hash === '/login' || hash === '/register') {
    me = null;
    stopNotifications();
    return renderAuth(hash === '/register' ? 'register' : 'login');
  }
  try { me = await api('/api/me'); } catch { location.hash = config.hasUsers ? '#/login' : '#/register'; return; }
  startNotifications(me);
  let m;
  if ((m = hash.match(/^\/p\/([\w-]+)$/))) {
    app.replaceChildren();
    cleanup = await openEditor(app, m[1], me);
  } else if ((hash === '/team' || hash.startsWith('/team/') || hash === '/admin') && !me.lab_member) page('team', (main) => main.replaceChildren(
    h('div', { class: 'empty full' }, h('h3', {}, 'The Team directory is for lab-team members'), h('p', {}, 'You can still create your own projects and work on projects people share with you. A lab admin can add you to the lab team.'), h('a', { class: 'btn', href: '#/' }, 'Back to projects'))));
  else if (hash === '/team' || hash === '/admin') page('team', (main) => renderTeam(main, me, { adminActions }));
  else if ((m = hash.match(/^\/team\/(\d+)$/))) page('team', (main) => renderProfile(main, me, Number(m[1])));
  else if (hash === '/tasks') page('tasks', (main) => renderMyTasks(main, me));
  else renderDashboard();
}
window.addEventListener('hashchange', route);
route();

function page(section, render) {
  const main = h('main', { class: 'dash' });
  app.replaceChildren(header(null, section), main);
  return render(main);
}

// ---------------- Header ----------------
function header(extra, section = 'projects') {
  const nav = (key, href, label) => h('a', { href, class: 'nav-link' + (section === key ? ' active' : ''), 'aria-current': section === key ? 'page' : null }, label);
  return h('header', { class: 'topbar' },
    h('a', { class: 'brand', href: '#/' }, h('span', { class: 'brand-mark' }, 'Λ'), 'LabTeX'),
    h('nav', { class: 'main-nav' }, nav('projects', '#/', 'Projects'), me?.lab_member && nav('team', '#/team', 'Team'), nav('tasks', '#/tasks', 'My tasks')),
    h('div', { class: 'spacer' }), extra, bellButton(), themeButton(),
    h('button', { class: 'user-btn', onclick: (e) => menu(e.currentTarget, [
      { label: 'Account settings', onClick: accountSettings },
      { label: `LabTeX build ${document.querySelector('meta[name=labtex-build]')?.content || 'dev'}`, disabled: true, onClick: () => {} },
      me.lab_member && { label: 'Team directory', onClick: () => (location.hash = '#/team') },
      'sep',
      { label: 'Sign out', onClick: async () => { await api('/api/logout', { method: 'POST' }); location.hash = '#/login'; } },
    ]) }, avatar({ name: me.name, color: '#334155' }), h('span', {}, me.name), '▾'));
}

// ---------------- Auth ----------------
function renderAuth(mode) {
  const first = !config.hasUsers;
  if (mode === 'register' && !config.allowRegistration) mode = 'login';
  const err = h('div', { class: 'form-error', role: 'alert' });
  const fields = {
    name: h('input', { type: 'text', autocomplete: 'name', required: true }),
    email: h('input', { type: 'email', autocomplete: 'email', required: true }),
    password: h('input', { type: 'password', autocomplete: mode === 'login' ? 'current-password' : 'new-password', required: true, minlength: mode === 'register' ? 8 : null }),
    code: h('input', { type: 'text', autocomplete: 'off' }),
  };
  const submit = h('button', { class: 'btn primary block', type: 'submit' }, mode === 'login' ? 'Sign in' : first ? 'Create admin account' : 'Create account');
  const form = h('form', {
    class: 'auth-card', onsubmit: async (e) => {
      e.preventDefault(); err.textContent = ''; submit.disabled = true;
      try {
        const body = { email: fields.email.value, password: fields.password.value };
        if (mode === 'register') Object.assign(body, { name: fields.name.value, code: fields.code.value });
        await api(mode === 'login' ? '/api/login' : '/api/register', { method: 'POST', body });
        config = null;
        location.hash = '#/';
      } catch (ex) { err.textContent = ex.message; } finally { submit.disabled = false; }
    },
  },
  h('div', { class: 'auth-brand' }, h('span', { class: 'brand-mark big' }, 'Λ'), h('h1', {}, 'LabTeX')),
  h('p', { class: 'auth-sub' }, first ? 'Welcome! Create the first account. It will be the lab administrator.' : mode === 'login' ? 'Sign in to your lab workspace' : 'Create your LabTeX account'),
  mode === 'register' && h('label', {}, 'Full name', fields.name),
  h('label', {}, 'Email', fields.email),
  h('label', {}, 'Password', fields.password),
  mode === 'register' && config.needsCode && h('label', {}, 'Lab registration code', fields.code),
  err, submit,
  !first && h('p', { class: 'auth-switch' }, mode === 'login'
    ? (config.allowRegistration ? ['New to the lab? ', h('a', { href: '#/register' }, 'Create an account')] : 'Ask a lab admin for an account.')
    : ['Already have an account? ', h('a', { href: '#/login' }, 'Sign in')]));
  app.replaceChildren(h('div', { class: 'auth-page' }, h('div', { class: 'auth-theme' }, themeButton()), form));
  (mode === 'register' ? fields.name : fields.email).focus();
}

// ---------------- Dashboard ----------------
async function renderDashboard() {
  let filter = localStorage.getItem('labtex.filter') || 'all';
  let query = '';
  const list = h('div', { class: 'project-list' });
  const search = h('input', { type: 'search', class: 'search', placeholder: 'Search projects…', oninput: () => { query = search.value.toLowerCase(); draw(); } });
  const zipInput = h('input', { type: 'file', accept: '.zip,application/zip', multiple: true, hidden: true, onchange: () => {
    const files = [...zipInput.files];
    zipInput.value = '';
    importZips(files);
  } });
  const importBox = h('div', { class: 'import-box', hidden: true, 'aria-live': 'polite' });
  let newIds = new Set();

  // Import one or more .zip files; each becomes its own project.
  async function importZips(files) {
    const zips = files.filter((f) => /\.zip$/i.test(f.name));
    const skipped = files.length - zips.length;
    if (!zips.length) { toast('Choose .zip files to import.', 'error'); return; }
    if (skipped) toast(`Skipped ${skipped} file(s) that aren’t .zip`);

    // A single zip opens straight away, like before.
    if (zips.length === 1) {
      const form = new FormData(); form.append('zip', zips[0]);
      try { toast('Importing…'); const { id } = await api('/api/projects/import', { method: 'POST', form }); location.hash = `#/p/${id}`; }
      catch (e) { toast(`${zips[0].name}: ${e.message}`, 'error', 6000); }
      return;
    }

    const items = zips.map((file) => ({ file, status: 'waiting', id: null, error: '' }));
    const drawBox = () => {
      const done = items.filter((i) => i.status === 'done').length;
      const failed = items.filter((i) => i.status === 'failed').length;
      const finished = done + failed === items.length;
      importBox.hidden = false;
      importBox.replaceChildren(
        h('div', { class: 'import-head' },
          h('strong', {}, finished ? `Imported ${done} of ${items.length} projects` : `Importing ${items.length} projects…`),
          h('span', { class: 'muted small' }, finished ? (failed ? ` · ${failed} failed` : '') : ` ${done + failed}/${items.length}`),
          h('div', { class: 'spacer' }),
          finished && h('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: () => { importBox.hidden = true; } }, '✕')),
        h('div', { class: 'import-bar' }, h('span', { style: { width: `${((done + failed) / items.length) * 100}%` } })),
        h('ul', { class: 'import-list' }, items.map((i) => h('li', { class: `imp-${i.status}` },
          h('span', { class: 'imp-ico' }, { waiting: '•', uploading: '', done: '✓', failed: '✕' }[i.status]),
          h('span', { class: 'imp-name', title: i.file.name }, i.file.name),
          i.status === 'uploading' && h('span', { class: 'muted small' }, 'importing…'),
          i.status === 'done' && h('a', { href: `#/p/${i.id}`, class: 'small' }, 'Open'),
          i.status === 'failed' && h('span', { class: 'imp-err small', title: i.error }, i.error)))));
    };
    drawBox();
    // Two at a time keeps the server responsive.
    let next = 0;
    const worker = async () => {
      while (next < items.length) {
        const it = items[next++];
        it.status = 'uploading'; drawBox();
        try {
          const form = new FormData(); form.append('zip', it.file);
          const { id } = await api('/api/projects/import', { method: 'POST', form });
          it.status = 'done'; it.id = id; newIds.add(id);
        } catch (e) { it.status = 'failed'; it.error = e.message; }
        drawBox();
      }
    };
    await Promise.all([worker(), worker()]);
    await load();
    const ok = items.filter((i) => i.status === 'done').length;
    toast(ok === items.length ? `Imported ${ok} projects` : `Imported ${ok} of ${items.length}; see the list for errors`, ok === items.length ? 'ok' : 'error', 5000);
    setTimeout(() => { newIds = new Set(); draw(); }, 6000);
  }
  const tabs = h('div', { class: 'tabs', role: 'tablist' });
  let projects = [];

  const draw = () => {
    tabs.replaceChildren(...[['all', 'All projects'], ['mine', 'Owned by me'], ['shared', 'Shared with me'], me.lab_member && ['lab', 'Lab workspace'], me.lab_member && ['templates', 'My lab templates']].filter(Boolean).map(([k, l]) =>
      h('button', { class: 'tab' + (filter === k ? ' active' : ''), role: 'tab', 'aria-selected': String(filter === k), onclick: () => { filter = k; localStorage.setItem('labtex.filter', k); draw(); } }, l)));
    const rows = projects.filter((p) =>
      (filter === 'all' || (filter === 'mine' && p.role === 'owner') || (filter === 'shared' && p.member_role && p.member_role !== 'owner') || (filter === 'lab' && p.lab_role) || (filter === 'templates' && p.is_template))
      && (!query || p.name.toLowerCase().includes(query) || (p.owner_name || '').toLowerCase().includes(query)));
    if (!rows.length) {
      list.replaceChildren(h('div', { class: 'empty' },
        filter === 'lab' && !query ? [h('h3', {}, 'Nothing in the lab workspace yet'), h('p', {}, 'Projects shared with “Everyone in the lab” appear here for every lab member. Open a project’s Share dialog to add it.')] :
        projects.length ? 'No projects match.' : [h('h3', {}, 'No projects yet'), h('p', {}, 'Create a project from a template, or import a .zip (for example, an Overleaf download).')]));
      return;
    }
    list.replaceChildren(h('table', { class: 'ptable' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Owner'), h('th', {}, 'Your access'), h('th', {}, 'Last modified'), h('th', { class: 'r' }, ''))),
      h('tbody', {}, rows.map((p) => h('tr', { class: newIds.has(p.id) ? 'row-new' : null },
        h('td', {}, h('a', { href: `#/p/${p.id}`, class: 'pname' }, p.name), p.is_template ? h('span', { class: 'badge' }, 'Lab template') : null,
          p.lab_role ? h('span', { class: 'badge badge-lab', title: `Everyone in the lab can ${p.lab_role === 'viewer' ? 'view' : p.lab_role === 'commenter' ? 'comment' : 'edit'}` }, '🏛 Lab') : null,
          p.member_count > 1 ? h('span', { class: 'muted small', title: 'Collaborators' }, ` · ${p.member_count} people`) : null,
          p.open_tasks ? h('span', { class: 'muted small', title: 'Open tasks' }, ` · ${p.open_tasks} open task${p.open_tasks === 1 ? '' : 's'}`) : null),
        h('td', {}, p.role === 'owner' ? 'You' : p.owner_name || '—'),
        h('td', {}, h('span', { class: `role role-${p.role}`, title: p.via_lab ? 'Through lab-wide sharing' : null }, roleLabel(p.role))),
        h('td', { title: new Date(p.updated_at).toLocaleString() }, timeAgo(p.updated_at)),
        h('td', { class: 'r' }, h('button', { class: 'icon-btn', 'aria-label': `Actions for ${p.name}`, onclick: (e) => menu(e.currentTarget, [
          { label: 'Open', onClick: () => (location.hash = `#/p/${p.id}`) },
          { label: atLeast(p.role, 'admin') ? 'Share…' : 'Who has access', onClick: () => shareDialog(p.id, me, { onChange: () => load() }) },
          { label: 'Make a copy', onClick: async () => { const r = await prompt('Copy project', { label: 'Name of the copy', value: `Copy of ${p.name}`, okText: 'Copy' }); if (r == null) return; const { id } = await api(`/api/projects/${p.id}/copy`, { method: 'POST', body: { name: r } }); toast('Copied'); location.hash = `#/p/${id}`; } },
          { label: 'Download source (.zip)', onClick: () => (location.href = `/api/projects/${p.id}/zip`) },
          'sep',
          p.role === 'owner'
            ? { label: 'Delete project…', danger: true, onClick: async () => {
              if (!(await confirmBox('Delete project', `Delete “${p.name}” for everyone? This cannot be undone.`, { okText: 'Delete', danger: true }))) return;
              await api(`/api/projects/${p.id}`, { method: 'DELETE' }); toast('Project deleted'); load();
            } }
            : p.via_lab ? null : { label: 'Leave project', danger: true, onClick: async () => {
              if (!(await confirmBox('Leave project', `Remove yourself from “${p.name}”?`, { okText: 'Leave', danger: true }))) return;
              await api(`/api/projects/${p.id}/members/${me.id}`, { method: 'DELETE' }); load();
            } },
        ]) }, '⋯')))))));
  };
  const tasksStrip = h('div', { class: 'tasks-strip', hidden: true });
  const loadTasks = async () => {
    try {
      const tasks = (await api('/api/tasks?scope=assigned')).filter((t) => t.status !== 'done');
      tasksStrip.hidden = !tasks.length;
      if (!tasks.length) return;
      const rowOpts = {
        showProject: true,
        onOpen: (x) => openTarget({ pid: x.project_id, task: x.id }),
        onOpenLink: (x) => openTarget({ pid: x.project_id, task: x.id }),
        onToggle: async (x, d) => { try { await api(`/api/projects/${x.project_id}/tasks/${x.id}`, { method: 'PATCH', body: { status: d ? 'done' : 'todo' } }); if (d) toast('Task completed 🎉', 'ok'); } catch (e) { toast(e.message, 'error'); } loadTasks(); },
      };
      tasksStrip.replaceChildren(
        h('div', { class: 'ts-head' }, h('strong', {}, `Your open tasks · ${tasks.length}`), h('div', { class: 'spacer' }), h('a', { href: '#/tasks', class: 'small' }, 'See all →')),
        h('div', { class: 'plist' }, tasks.slice(0, 4).map((t) => taskRow(t, me, rowOpts))));
    } catch {}
  };
  const load = async () => { projects = await api('/api/projects'); draw(); };

  app.replaceChildren(header(null, 'projects'), h('main', { class: 'dash' },
    h('div', { class: 'dash-head' },
      h('h1', {}, 'Projects'),
      h('div', { class: 'dash-actions' },
        h('button', { class: 'btn', title: 'Import one or more .zip files (each becomes a project). You can also drag zips onto this page.', onclick: () => zipInput.click() }, 'Import .zip'), zipInput,
        h('button', { class: 'btn primary', onclick: newProjectDialog }, '+ New project'))),
    me.lab_member && h('a', { class: 'lab-card', href: '#/p/lab-library' },
      h('div', { class: 'lab-icon' }, '📚'),
      h('div', {}, h('strong', {}, 'Lab Library'), h('div', { class: 'muted' }, 'Shared bibliography everyone in the lab can edit. Cite it from any project with \\bibliography{lab} or \\addbibresource{lab.bib}.')),
      h('span', { class: 'chev' }, '›')),
    tasksStrip,
    importBox,
    h('div', { class: 'dash-filters' }, tabs, search),
    list));

  // Drag .zip files from your computer anywhere onto the projects page.
  const dash = app.querySelector('.dash');
  const dropHint = h('div', { class: 'dash-drop' }, h('div', {}, h('span', { class: 'dash-drop-ico' }, '⤓'), h('strong', {}, 'Drop .zip files to import'), h('span', {}, 'Each zip becomes its own project')));
  let depth = 0;
  const hasFiles = (e) => e.dataTransfer?.types?.includes('Files');
  dash.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; depth++; dash.append(dropHint); });
  dash.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; dropHint.remove(); } });
  dash.addEventListener('dragover', (e) => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
  dash.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); depth = 0; dropHint.remove();
    importZips([...e.dataTransfer.files]);
  });
  load();
  loadTasks();
}

async function newProjectDialog() {
  const tpls = await api('/api/templates');
  let selected = 'blank';
  const name = h('input', { type: 'text', placeholder: 'e.g. Grant proposal 2026', value: '' });
  const card = (id, title, desc, meta) => h('button', {
    type: 'button', class: 'tpl' + (selected === id ? ' sel' : ''), 'data-id': id,
    onclick: (e) => { selected = id; e.currentTarget.parentElement.parentElement.querySelectorAll('.tpl').forEach((b) => b.classList.toggle('sel', b.dataset.id === id)); },
  }, h('strong', {}, title), h('span', {}, desc || ''), meta && h('em', {}, meta));
  const res = await modal('New project', (close) => h('form', { onsubmit: (e) => { e.preventDefault(); close({ name: name.value, template: selected }); } },
    h('label', {}, 'Project name', name),
    h('div', { class: 'tpl-section' }, h('h4', {}, 'Starter templates'),
      h('div', { class: 'tpl-grid' }, tpls.builtin.map((t) => card(t.id, t.name, t.description)))),
    tpls.lab.length ? h('div', { class: 'tpl-section' }, h('h4', {}, 'Lab templates'),
      h('div', { class: 'tpl-grid' }, tpls.lab.map((t) => card('project:' + t.id, t.name, t.description, t.owner_name && `by ${t.owner_name}`)))) : null,
    h('div', { class: 'modal-actions' },
      h('button', { type: 'button', class: 'btn', onclick: () => close() }, 'Cancel'),
      h('button', { type: 'submit', class: 'btn primary' }, 'Create'))), { wide: true });
  if (!res) return;
  try { const { id } = await api('/api/projects', { method: 'POST', body: res }); location.hash = `#/p/${id}`; }
  catch (e) { toast(e.message, 'error'); }
}

function accountSettings() {
  modal('Account settings', (close) => {
    const name = h('input', { type: 'text', value: me.name });
    const title = h('input', { type: 'text', value: me.title || '', placeholder: 'e.g. PhD student, Postdoc, PI' });
    const cur = h('input', { type: 'password', autocomplete: 'current-password' });
    const nxt = h('input', { type: 'password', autocomplete: 'new-password', minlength: 8 });
    const err = h('div', { class: 'form-error' });
    return h('div', {},
      h('form', { onsubmit: async (e) => { e.preventDefault(); try { await api('/api/me', { method: 'PATCH', body: { name: name.value, title: title.value } }); me.name = name.value.trim(); me.title = title.value.trim(); toast('Profile updated', 'ok'); } catch (ex) { toast(ex.message, 'error'); } } },
        h('label', {}, 'Display name', name), h('label', {}, 'Role in the lab (shown in the Team directory)', title),
        h('div', { class: 'modal-actions' }, h('button', { class: 'btn primary', type: 'submit' }, 'Save profile'))),
      h('hr'),
      h('form', { onsubmit: async (e) => { e.preventDefault(); err.textContent = ''; try { await api('/api/me/password', { method: 'POST', body: { current: cur.value, next: nxt.value } }); toast('Password changed', 'ok'); close(); } catch (ex) { err.textContent = ex.message; } } },
        h('p', { class: 'muted small' }, `Signed in as ${me.email}`),
        h('label', {}, 'Current password', cur), h('label', {}, 'New password (8+ characters)', nxt), err,
        h('div', { class: 'modal-actions' }, h('button', { class: 'btn primary', type: 'submit' }, 'Change password'))));
  });
}

// ---------------- Admin actions (used by the Team page) ----------------
function adminActions(anchor, u, reload) {
  if (!u) return addUser(reload);
  menu(anchor, [
    { label: u.is_admin ? 'Remove lab-admin rights' : 'Make lab admin', disabled: u.id === me.id, onClick: async () => { try { await api(`/api/admin/users/${u.id}`, { method: 'PATCH', body: { is_admin: !u.is_admin } }); reload(); } catch (ex) { toast(ex.message, 'error'); } } },
    { label: 'Reset password…', onClick: async () => { const pw = await prompt(`New password for ${u.name}`, { label: 'At least 8 characters. They will be signed out everywhere.', okText: 'Set password' }); if (!pw) return; try { await api(`/api/admin/users/${u.id}`, { method: 'PATCH', body: { password: pw } }); toast('Password reset', 'ok'); } catch (ex) { toast(ex.message, 'error'); } } },
    { label: 'Remove from lab team…', disabled: u.id === me.id || u.is_admin, onClick: async () => {
      if (!(await confirmBox('Remove from lab team', `Remove ${u.name} from the lab team? They keep their account, their own projects and anything shared with them directly, but lose access to the Team directory, the lab library, lab templates and lab-wide projects.`, { okText: 'Remove', danger: true }))) return;
      try { await api(`/api/admin/users/${u.id}/lab`, { method: 'POST', body: { member: false } }); toast(`${u.name} is no longer on the lab team`); reload(); } catch (ex) { toast(ex.message, 'error'); }
    } },
    'sep',
    { label: 'Delete user…', danger: true, disabled: u.id === me.id, onClick: async () => {
      if (!(await confirmBox('Delete user', `Delete ${u.name}? Projects they own will be transferred to you.`, { okText: 'Delete', danger: true }))) return;
      try { const r = await api(`/api/admin/users/${u.id}`, { method: 'DELETE' }); toast(`User deleted${r.transferred ? `; ${r.transferred} project(s) transferred to you` : ''}`); reload(); } catch (ex) { toast(ex.message, 'error'); }
    } },
  ]);
}
function addUser(reload) {
  return modal('Add lab member', (close) => {
    const f = { name: h('input', { type: 'text' }), email: h('input', { type: 'email' }), password: h('input', { type: 'text', minlength: 8 }), admin: h('input', { type: 'checkbox' }) };
    const err = h('div', { class: 'form-error' });
    return h('form', { onsubmit: async (e) => { e.preventDefault(); try { await api('/api/admin/users', { method: 'POST', body: { name: f.name.value, email: f.email.value, password: f.password.value, is_admin: f.admin.checked } }); close(); toast('User created. Share the password with them securely.', 'ok'); reload(); } catch (ex) { err.textContent = ex.message; } } },
      h('label', {}, 'Full name', f.name), h('label', {}, 'Email', f.email), h('label', {}, 'Initial password (8+ characters)', f.password),
      h('label', { class: 'check' }, f.admin, 'Lab administrator'), err,
      h('div', { class: 'modal-actions' }, h('button', { type: 'button', class: 'btn', onclick: () => close() }, 'Cancel'), h('button', { class: 'btn primary', type: 'submit' }, 'Create user')));
  });
}
