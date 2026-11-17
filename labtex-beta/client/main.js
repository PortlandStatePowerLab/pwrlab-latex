import { h, api, toast, modal, confirmBox, prompt, timeAgo, menu, avatar } from './util.js';
import { openEditor } from './editor.js';

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
    return renderAuth(hash === '/register' ? 'register' : 'login');
  }
  try { me = await api('/api/me'); } catch { location.hash = config.hasUsers ? '#/login' : '#/register'; return; }
  let m;
  if ((m = hash.match(/^\/p\/([\w-]+)$/))) {
    app.replaceChildren();
    cleanup = await openEditor(app, m[1], me);
  } else if (hash === '/admin' && me.is_admin) renderAdmin();
  else renderDashboard();
}
window.addEventListener('hashchange', route);
route();

// ---------------- Header ----------------
function header(extra) {
  return h('header', { class: 'topbar' },
    h('a', { class: 'brand', href: '#/' }, h('span', { class: 'brand-mark' }, 'Λ'), 'LabTeX'),
    h('div', { class: 'spacer' }), extra,
    h('button', { class: 'user-btn', onclick: (e) => menu(e.currentTarget, [
      { label: 'Account settings', onClick: accountSettings },
      { label: `LabTeX build ${document.querySelector('meta[name=labtex-build]')?.content || 'dev'}`, disabled: true, onClick: () => {} },
      me.is_admin && { label: 'Admin: manage users', onClick: () => (location.hash = '#/admin') },
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
  h('p', { class: 'auth-sub' }, first ? 'Welcome! Create the first account. It will be the lab administrator.' : mode === 'login' ? 'Sign in to your lab workspace' : 'Create your lab account'),
  mode === 'register' && h('label', {}, 'Full name', fields.name),
  h('label', {}, 'Email', fields.email),
  h('label', {}, 'Password', fields.password),
  mode === 'register' && config.needsCode && h('label', {}, 'Lab registration code', fields.code),
  err, submit,
  !first && h('p', { class: 'auth-switch' }, mode === 'login'
    ? (config.allowRegistration ? ['New to the lab? ', h('a', { href: '#/register' }, 'Create an account')] : 'Ask a lab admin for an account.')
    : ['Already have an account? ', h('a', { href: '#/login' }, 'Sign in')]));
  app.replaceChildren(h('div', { class: 'auth-page' }, form));
  (mode === 'register' ? fields.name : fields.email).focus();
}

// ---------------- Dashboard ----------------
async function renderDashboard() {
  let filter = localStorage.getItem('labtex.filter') || 'all';
  let query = '';
  const list = h('div', { class: 'project-list' });
  const search = h('input', { type: 'search', class: 'search', placeholder: 'Search projects…', oninput: () => { query = search.value.toLowerCase(); draw(); } });
  const zipInput = h('input', { type: 'file', accept: '.zip', hidden: true, onchange: async () => {
    const f = zipInput.files[0]; if (!f) return;
    const form = new FormData(); form.append('zip', f);
    try { toast('Importing…'); const { id } = await api('/api/projects/import', { method: 'POST', form }); location.hash = `#/p/${id}`; }
    catch (e) { toast(e.message, 'error'); } finally { zipInput.value = ''; }
  } });
  const tabs = h('div', { class: 'tabs', role: 'tablist' });
  let projects = [];

  const draw = () => {
    tabs.replaceChildren(...[['all', 'All projects'], ['mine', 'Owned by me'], ['shared', 'Shared with me'], ['templates', 'My lab templates']].map(([k, l]) =>
      h('button', { class: 'tab' + (filter === k ? ' active' : ''), role: 'tab', 'aria-selected': String(filter === k), onclick: () => { filter = k; localStorage.setItem('labtex.filter', k); draw(); } }, l)));
    const rows = projects.filter((p) =>
      (filter === 'all' || (filter === 'mine' && p.role === 'owner') || (filter === 'shared' && p.role !== 'owner') || (filter === 'templates' && p.is_template))
      && (!query || p.name.toLowerCase().includes(query) || (p.owner_name || '').toLowerCase().includes(query)));
    if (!rows.length) {
      list.replaceChildren(h('div', { class: 'empty' },
        projects.length ? 'No projects match.' : [h('h3', {}, 'No projects yet'), h('p', {}, 'Create a project from a template, or import a .zip (for example, an Overleaf download).')]));
      return;
    }
    list.replaceChildren(h('table', { class: 'ptable' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Owner'), h('th', {}, 'Your access'), h('th', {}, 'Last modified'), h('th', { class: 'r' }, ''))),
      h('tbody', {}, rows.map((p) => h('tr', {},
        h('td', {}, h('a', { href: `#/p/${p.id}`, class: 'pname' }, p.name), p.is_template ? h('span', { class: 'badge' }, 'Lab template') : null,
          p.member_count > 1 ? h('span', { class: 'muted small', title: 'Collaborators' }, ` · ${p.member_count} people`) : null),
        h('td', {}, p.role === 'owner' ? 'You' : p.owner_name || '—'),
        h('td', {}, h('span', { class: `role role-${p.role}` }, p.role)),
        h('td', { title: new Date(p.updated_at).toLocaleString() }, timeAgo(p.updated_at)),
        h('td', { class: 'r' }, h('button', { class: 'icon-btn', 'aria-label': `Actions for ${p.name}`, onclick: (e) => menu(e.currentTarget, [
          { label: 'Open', onClick: () => (location.hash = `#/p/${p.id}`) },
          { label: 'Make a copy', onClick: async () => { const r = await prompt('Copy project', { label: 'Name of the copy', value: `Copy of ${p.name}`, okText: 'Copy' }); if (r == null) return; const { id } = await api(`/api/projects/${p.id}/copy`, { method: 'POST', body: { name: r } }); toast('Copied'); location.hash = `#/p/${id}`; } },
          { label: 'Download source (.zip)', onClick: () => (location.href = `/api/projects/${p.id}/zip`) },
          'sep',
          p.role === 'owner'
            ? { label: 'Delete project…', danger: true, onClick: async () => {
              if (!(await confirmBox('Delete project', `Delete “${p.name}” for everyone? This cannot be undone.`, { okText: 'Delete', danger: true }))) return;
              await api(`/api/projects/${p.id}`, { method: 'DELETE' }); toast('Project deleted'); load();
            } }
            : { label: 'Leave project', danger: true, onClick: async () => {
              if (!(await confirmBox('Leave project', `Remove yourself from “${p.name}”?`, { okText: 'Leave', danger: true }))) return;
              await api(`/api/projects/${p.id}/members/${me.id}`, { method: 'DELETE' }); load();
            } },
        ]) }, '⋯')))))));
  };
  const load = async () => { projects = await api('/api/projects'); draw(); };

  app.replaceChildren(header(), h('main', { class: 'dash' },
    h('div', { class: 'dash-head' },
      h('h1', {}, 'Projects'),
      h('div', { class: 'dash-actions' },
        h('button', { class: 'btn', onclick: () => zipInput.click() }, 'Import .zip'), zipInput,
        h('button', { class: 'btn primary', onclick: newProjectDialog }, '+ New project'))),
    h('a', { class: 'lab-card', href: '#/p/lab-library' },
      h('div', { class: 'lab-icon' }, '📚'),
      h('div', {}, h('strong', {}, 'Lab Library'), h('div', { class: 'muted' }, 'Shared bibliography everyone in the lab can edit. Cite it from any project with \\bibliography{lab} or \\addbibresource{lab.bib}.')),
      h('span', { class: 'chev' }, '›')),
    h('div', { class: 'dash-filters' }, tabs, search),
    list));
  load();
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
    const cur = h('input', { type: 'password', autocomplete: 'current-password' });
    const nxt = h('input', { type: 'password', autocomplete: 'new-password', minlength: 8 });
    const err = h('div', { class: 'form-error' });
    return h('div', {},
      h('form', { onsubmit: async (e) => { e.preventDefault(); try { await api('/api/me', { method: 'PATCH', body: { name: name.value } }); me.name = name.value.trim(); toast('Name updated', 'ok'); } catch (ex) { toast(ex.message, 'error'); } } },
        h('label', {}, 'Display name', name), h('div', { class: 'modal-actions' }, h('button', { class: 'btn primary', type: 'submit' }, 'Save name'))),
      h('hr'),
      h('form', { onsubmit: async (e) => { e.preventDefault(); err.textContent = ''; try { await api('/api/me/password', { method: 'POST', body: { current: cur.value, next: nxt.value } }); toast('Password changed', 'ok'); close(); } catch (ex) { err.textContent = ex.message; } } },
        h('p', { class: 'muted small' }, `Signed in as ${me.email}`),
        h('label', {}, 'Current password', cur), h('label', {}, 'New password (8+ characters)', nxt), err,
        h('div', { class: 'modal-actions' }, h('button', { class: 'btn primary', type: 'submit' }, 'Change password'))));
  });
}

// ---------------- Admin ----------------
async function renderAdmin() {
  const body = h('tbody');
  const load = async () => {
    const users = await api('/api/admin/users');
    body.replaceChildren(...users.map((u) => h('tr', {},
      h('td', {}, u.name, u.id === me.id ? h('span', { class: 'muted small' }, ' (you)') : null),
      h('td', {}, u.email),
      h('td', {}, u.is_admin ? h('span', { class: 'role role-owner' }, 'admin') : 'member'),
      h('td', {}, String(u.projects)),
      h('td', {}, new Date(u.created_at).toLocaleDateString()),
      h('td', { class: 'r' }, h('button', { class: 'icon-btn', 'aria-label': `Actions for ${u.name}`, onclick: (e) => menu(e.currentTarget, [
        { label: u.is_admin ? 'Remove admin rights' : 'Make admin', disabled: u.id === me.id, onClick: async () => { await api(`/api/admin/users/${u.id}`, { method: 'PATCH', body: { is_admin: !u.is_admin } }); load(); } },
        { label: 'Reset password…', onClick: async () => { const pw = await prompt(`New password for ${u.name}`, { label: 'At least 8 characters. They will be signed out everywhere.', okText: 'Set password' }); if (!pw) return; try { await api(`/api/admin/users/${u.id}`, { method: 'PATCH', body: { password: pw } }); toast('Password reset', 'ok'); } catch (ex) { toast(ex.message, 'error'); } } },
        'sep',
        { label: 'Delete user…', danger: true, disabled: u.id === me.id, onClick: async () => {
          if (!(await confirmBox('Delete user', `Delete ${u.name}? Projects they own will be transferred to you.`, { okText: 'Delete', danger: true }))) return;
          const r = await api(`/api/admin/users/${u.id}`, { method: 'DELETE' }); toast(`User deleted${r.transferred ? `; ${r.transferred} project(s) transferred to you` : ''}`); load();
        } },
      ]) }, '⋯')))));
  };
  const addUser = () => modal('Add lab member', (close) => {
    const f = { name: h('input', { type: 'text' }), email: h('input', { type: 'email' }), password: h('input', { type: 'text', minlength: 8 }), admin: h('input', { type: 'checkbox' }) };
    const err = h('div', { class: 'form-error' });
    return h('form', { onsubmit: async (e) => { e.preventDefault(); try { await api('/api/admin/users', { method: 'POST', body: { name: f.name.value, email: f.email.value, password: f.password.value, is_admin: f.admin.checked } }); close(); toast('User created. Share the password with them securely.', 'ok'); load(); } catch (ex) { err.textContent = ex.message; } } },
      h('label', {}, 'Full name', f.name), h('label', {}, 'Email', f.email), h('label', {}, 'Initial password (8+ characters)', f.password),
      h('label', { class: 'check' }, f.admin, 'Administrator'), err,
      h('div', { class: 'modal-actions' }, h('button', { type: 'button', class: 'btn', onclick: () => close() }, 'Cancel'), h('button', { class: 'btn primary', type: 'submit' }, 'Create user')));
  });
  app.replaceChildren(header(), h('main', { class: 'dash' },
    h('div', { class: 'dash-head' }, h('div', {}, h('a', { href: '#/', class: 'muted small' }, '← Projects'), h('h1', {}, 'Lab members')),
      h('button', { class: 'btn primary', onclick: addUser }, '+ Add member')),
    h('table', { class: 'ptable' }, h('thead', {}, h('tr', {}, ['Name', 'Email', 'Role', 'Projects owned', 'Joined', ''].map((t) => h('th', {}, t)))), body)));
  load();
}
