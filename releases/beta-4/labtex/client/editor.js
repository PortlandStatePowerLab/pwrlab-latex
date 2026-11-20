import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next';
import {
  EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection,
  dropCursor, rectangularSelection, crosshairCursor, highlightSpecialChars,
} from '@codemirror/view';
import { EditorState, Compartment } from '@codemirror/state';
import { StreamLanguage, syntaxHighlighting, defaultHighlightStyle, bracketMatching, indentOnInput, indentUnit } from '@codemirror/language';
import { stex } from '@codemirror/legacy-modes/mode/stex';
import { defaultKeymap, indentWithTab, toggleComment } from '@codemirror/commands';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';

import { h, api, toast, modal, confirmBox, prompt, menu, avatar, fmtBytes, timeAgo } from './util.js';
import { PdfView } from './pdfview.js';
import { openHistory } from './history.js';
import { latexCompletions, parseBibKeys, parseLabels } from './latex-completions.js';
import { reviewExtension, ReviewPanel, TC_ORIGIN } from './review.js';
import { latexHighlight } from './latex-highlight.js';
import { themeButton, isDark, onThemeChange } from './theme.js';
import { shareDialog as openShareDialog, bellButton, TasksDrawer, takePending, atLeast, roleLabel } from './team.js';

const WS_BASE = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
const LAB_ID = 'lab-library';
const COLORS = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#42d4f4', '#f032e6', '#9a6324', '#469990', '#800000'];
const isTexLike = (p) => /\.(tex|sty|cls|bib|bbx|cbx|ltx|dtx|bst|def|cfg|clo)$/i.test(p);
const isImage = (p) => /\.(png|jpe?g|gif|webp)$/i.test(p);

export async function openEditor(root, projectId, me) {
  let project;
  try { project = await api(`/api/projects/${projectId}`); }
  catch (e) {
    root.replaceChildren(h('div', { class: 'empty full' }, h('h3', {}, e.status === 404 ? 'Project not found' : 'Could not open project'), h('p', {}, e.message), h('a', { class: 'btn', href: '#/' }, 'Back to projects')));
    return () => {};
  }

  const myColor = COLORS[me.id % COLORS.length];
  const state = {
    current: null, // { file, ydoc, provider, view, undo }
    compiling: false, lastResult: null, lastOwnCompile: 0,
    autoCompile: localStorage.getItem('labtex.autocompile') === '1',
    openFolders: new Set(JSON.parse(localStorage.getItem(`labtex.folders.${projectId}`) || '[]')),
    pendingFolders: new Set(),
    cursors: new Map(), // fileId -> selection anchor
    keys: { cites: [], labels: [], files: [] },
    destroyed: false,
    layout: localStorage.getItem('labtex.layout') || 'both',
  };
  const canEdit = () => atLeast(project.role, 'editor');
  const canComment = () => atLeast(project.role, 'commenter');
  const canManage = () => atLeast(project.role, 'admin');

  // ---------- DOM skeleton ----------
  const presenceBox = h('div', { class: 'presence' });
  const nameEl = h('button', { class: 'proj-name', title: canManage() ? 'Rename project' : project.name, onclick: renameProject }, project.name);
  const compileBtn = h('button', { class: 'btn compile', onclick: () => compile(), title: 'Recompile (Ctrl/⌘ + Enter or Ctrl/⌘ + S)' }, h('span', { class: 'spin' }), h('span', { class: 'lbl' }, 'Recompile'));
  const compileMore = h('button', { class: 'btn compile more', 'aria-label': 'Compile options', onclick: (e) => menu(e.currentTarget, [
    { label: (state.autoCompile ? '✓ ' : '   ') + 'Auto-compile while typing', onClick: () => { state.autoCompile = !state.autoCompile; localStorage.setItem('labtex.autocompile', state.autoCompile ? '1' : '0'); toast(`Auto-compile ${state.autoCompile ? 'on' : 'off'}`); } },
    'sep',
    ...project.engines.map((en) => ({ label: (project.engine === en ? '✓ ' : '   ') + en, disabled: !canEdit(), onClick: () => setEngine(en) })),
  ]) }, '▾');
  const logBtn = h('button', { class: 'btn small log-btn', onclick: () => toggleLogs() }, 'Logs');
  const fileTree = h('div', { class: 'tree', role: 'tree' });
  const srcHost = h('div', { class: 'src-host' });
  const srcTitle = h('div', { class: 'src-title' });
  const srcStatus = h('div', { class: 'src-status' });
  const pdfHost = h('div', { class: 'pdf-host' });
  const logPanel = h('div', { class: 'log-panel', hidden: true });
  const filesPane = h('aside', { class: 'ed-files' });
  const srcPane = h('section', { class: 'ed-src' });
  const pdfPane = h('section', { class: 'ed-pdf' });
  const uploadInput = h('input', { type: 'file', multiple: true, hidden: true, onchange: () => { uploadFiles([...uploadInput.files], uploadInput.dataset.folder || ''); uploadInput.value = ''; } });
  const layoutBtns = h('div', { class: 'seg', role: 'group', 'aria-label': 'Layout' },
    [['src', 'Editor'], ['both', 'Split'], ['pdf', 'PDF']].map(([k, l]) => h('button', { class: 'seg-btn', 'data-k': k, onclick: () => setLayout(k) }, l)));

  // ---------- Tasks ----------
  const tasksBtn = h('button', { class: 'btn ghost', title: 'Tasks for this project', onclick: () => tasks.toggle() }, '✓ Tasks');
  const tasks = new TasksDrawer({
    getProject: () => project, me,
    getCurrentLocation: () => {
      const c = state.current;
      if (!c?.view) return c?.file ? { path: c.file.path, line: null } : null;
      return { path: c.file.path, line: c.view.state.doc.lineAt(c.view.state.selection.main.head).number };
    },
    onOpenLink: (t) => { if (t.file_path) openPath(t.file_path, t.line || undefined); },
  });
  // On smaller screens the review panel and the tasks drawer take turns, so the editor keeps its room.
  const roomForBoth = () => innerWidth >= 1800;
  tasks.onOpen = () => { if (!roomForBoth() && reviewOpen) toggleReview(false); };
  tasks.onCount = (n) => { tasksBtn.replaceChildren('✓ Tasks'); if (n) tasksBtn.append(h('span', { class: 'cnt' }, n)); };
  const top = h('header', { class: 'ed-top' },
    h('a', { class: 'icon-btn home', href: '#/', title: 'Back to projects', 'aria-label': 'Back to projects' }, h('span', { class: 'brand-mark' }, 'Λ')),
    nameEl,
    project.role === 'viewer' && h('span', { class: 'badge ro', title: 'You can read, compile and download this project' }, 'Read-only'),
    project.role === 'commenter' && h('span', { class: 'badge ro cm', title: 'You can comment on text and create tasks, but not edit' }, 'Commenting'),
    h('div', { class: 'spacer' }),
    presenceBox,
    layoutBtns,
    themeButton(),
    h('button', { class: 'btn ghost', onclick: () => openHistory(projectId, canEdit()).then((r) => { if (r) afterRestore(); }) }, '🕘 History'),
    tasksBtn,
    !project.is_lab && h('button', { class: 'btn ghost', onclick: shareDialog }, '👥 Share'),
    bellButton(),
    h('button', { class: 'btn ghost', 'aria-label': 'Project menu', onclick: (e) => menu(e.currentTarget, [
      { label: 'Download PDF', onClick: () => (location.href = `/api/projects/${projectId}/pdf?download=1`) },
      { label: 'Download source (.zip)', onClick: () => (location.href = `/api/projects/${projectId}/zip`) },
      { label: 'Make a copy', onClick: copyProject },
      'sep',
      { label: 'Project settings…', onClick: settingsDialog },
    ]) }, '☰ Menu'));

  filesPane.append(
    h('div', { class: 'pane-head' }, h('span', {}, 'Files'),
      canEdit() && h('div', { class: 'pane-tools' },
        h('button', { class: 'icon-btn', title: 'New file', 'aria-label': 'New file', onclick: () => newFile('') }, '📄'),
        h('button', { class: 'icon-btn', title: 'New folder', 'aria-label': 'New folder', onclick: () => newFolder('') }, '📁'),
        h('button', { class: 'icon-btn', title: 'Upload files', 'aria-label': 'Upload files', onclick: () => { uploadInput.dataset.folder = ''; uploadInput.click(); } }, '⤒'))),
    fileTree, uploadInput,
    ...(project.is_lab ? [h('div', { class: 'pane-foot muted small' }, 'Shared with the whole lab. Cite with \\bibliography{lab}.')] : []));
  // ---------- Review (track changes + comments) ----------
  const myUser = { id: me.id, name: me.name, color: myColor };
  const reviewBtn = h('button', { class: 'btn small review-btn', title: 'Review: suggestions and comments', onclick: () => toggleReview() }, 'Review');
  const trackBadge = h('span', { class: 'track-badge', hidden: true, title: 'Track changes is on for this project' }, '● Tracking');
  const review = new ReviewPanel({
    user: myUser,
    getCtx: () => (state.current?.view ? { ydoc: state.current.ydoc, ytext: state.current.ydoc.getText('content'), view: state.current.view } : null),
    canEdit: () => canEdit(),
    canComment: () => canComment(),
    canModerate: () => canManage() || me.is_admin,
    getMembers: () => mentionables(),
    onMakeTask: ({ title, description, from }) => {
      const c = state.current;
      const line = c?.view ? c.view.state.doc.lineAt(Math.min(from, c.view.state.doc.length)).number : null;
      tasks.newTask({ title, description, file_path: c?.file.path, line });
    },
    isTracking: () => !!project.track_changes,
    setTracking: async (on) => {
      try {
        await api(`/api/projects/${projectId}`, { method: 'PATCH', body: { track_changes: on } });
        project.track_changes = on ? 1 : 0; updateReviewChrome(); review.render();
        toast(on ? 'Track changes is on: edits by everyone are now suggestions.' : 'Track changes is off.');
      } catch (e) { toast(e.message, 'error'); review.render(); }
    },
    onClose: () => toggleReview(false),
  });
  let reviewOpen = localStorage.getItem('labtex.review') === '1';
  function toggleReview(force) {
    reviewOpen = force === undefined ? !reviewOpen : force;
    localStorage.setItem('labtex.review', reviewOpen ? '1' : '0');
    review.el.hidden = !reviewOpen;
    reviewBtn.classList.toggle('active', reviewOpen);
    if (reviewOpen && tasks.open && !roomForBoth()) tasks.toggle(false);
    if (reviewOpen) review.render();
    state.current?.view?.requestMeasure();
  }
  function updateReviewChrome() {
    trackBadge.hidden = !project.track_changes;
    const { changes, comments } = review.counts();
    reviewBtn.replaceChildren('Review');
    if (changes) reviewBtn.append(h('span', { class: 'cnt warn', title: `${changes} suggestion(s)` }, changes));
    if (comments) reviewBtn.append(h('span', { class: 'cnt cmt', title: `${comments} open comment(s)` }, comments));
  }
  const onReviewChange = () => { updateReviewChrome(); if (reviewOpen) review.update(); };

  srcPane.append(h('div', { class: 'src-bar' }, srcTitle, trackBadge, h('div', { class: 'spacer' }), srcStatus, reviewBtn,
    h('button', { class: 'btn small', title: 'Show this line in the PDF (SyncTeX)', onclick: forwardSync }, 'Go to PDF →')),
  h('div', { class: 'src-row' }, srcHost, review.el));
  review.el.hidden = !reviewOpen;
  reviewBtn.classList.toggle('active', reviewOpen);
  pdfPane.append(h('div', { class: 'pdf-bar' }, h('div', { class: 'compile-group' }, compileBtn, compileMore), logBtn,
    h('div', { class: 'spacer' }),
    h('button', { class: 'icon-btn', title: 'Download PDF', 'aria-label': 'Download PDF', onclick: () => (location.href = `/api/projects/${projectId}/pdf?download=1`) }, '⤓')), pdfHost, logPanel);

  const split1 = h('div', { class: 'splitter', role: 'separator', 'aria-orientation': 'vertical' });
  const split2 = h('div', { class: 'splitter', role: 'separator', 'aria-orientation': 'vertical' });
  const body = h('div', { class: 'ed-body' }, filesPane, split1, srcPane, split2, pdfPane, tasks.el);
  const shell = h('div', { class: 'editor-app' }, top, body);
  root.replaceChildren(shell);

  // Drag & drop: OS files upload; files/folders dragged inside the tree are moved.
  // Dropping on a folder row targets that folder; anywhere else in the pane targets the top level.
  const DND = 'application/x-labtex-item';
  let dragItem = null; // { type: 'file', file } | { type: 'folder', path }
  let hoverTimer = null;
  const acceptsDrag = (e) => canEdit() && (e.dataTransfer.types.includes('Files') || e.dataTransfer.types.includes(DND));
  const clearDropMarks = () => {
    filesPane.classList.remove('drop');
    fileTree.querySelectorAll('.drop-target').forEach((el) => el.classList.remove('drop-target'));
  };
  async function handleDrop(e, folder) {
    e.preventDefault(); e.stopPropagation();
    clearTimeout(hoverTimer); clearDropMarks();
    if (!canEdit()) return;
    if (e.dataTransfer.types.includes(DND) && dragItem) {
      const item = dragItem; dragItem = null;
      if (item.type === 'file') await moveFile(item.file, folder);
      else await moveFolder(item.path, folder);
    } else if (e.dataTransfer.files.length) {
      if (folder) state.openFolders.add(folder);
      uploadFiles([...e.dataTransfer.files], folder);
    }
  }
  filesPane.addEventListener('dragover', (e) => {
    if (!acceptsDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = e.dataTransfer.types.includes(DND) ? 'move' : 'copy';
    if (!e.target.closest?.('.tree-row.folder')) {
      fileTree.querySelectorAll('.drop-target').forEach((el) => el.classList.remove('drop-target'));
      filesPane.classList.add('drop');
    }
  });
  filesPane.addEventListener('dragleave', (e) => { if (!filesPane.contains(e.relatedTarget)) clearDropMarks(); });
  filesPane.addEventListener('drop', (e) => handleDrop(e, ''));
  const onDragEnd = () => { dragItem = null; clearTimeout(hoverTimer); clearDropMarks(); };
  document.addEventListener('dragend', onDragEnd);

  // Props that make a tree row draggable and/or a drop target.
  function dragProps(item, dropFolder) {
    if (!canEdit()) return {};
    return {
      draggable: 'true',
      ondragstart: (e) => {
        dragItem = item;
        e.dataTransfer.effectAllowed = 'copyMove';
        e.dataTransfer.setData(DND, item.type === 'file' ? item.file.path : item.path);
        e.dataTransfer.setData('text/plain', item.type === 'file' ? item.file.path : item.path);
        e.currentTarget.classList.add('dragging');
      },
      ondragend: (e) => { e.currentTarget.classList.remove('dragging'); },
      ...(dropFolder !== undefined ? {
        ondragover: (e) => {
          if (!acceptsDrag(e)) return;
          // Can't drop a folder into itself or its own subfolders.
          if (dragItem?.type === 'folder' && (dropFolder === dragItem.path || dropFolder.startsWith(dragItem.path + '/'))) return;
          e.preventDefault(); e.stopPropagation();
          e.dataTransfer.dropEffect = e.dataTransfer.types.includes(DND) ? 'move' : 'copy';
          filesPane.classList.remove('drop');
          const row = e.currentTarget;
          if (!row.classList.contains('drop-target')) {
            fileTree.querySelectorAll('.drop-target').forEach((el) => el.classList.remove('drop-target'));
            row.classList.add('drop-target');
            // Hovering a closed folder for a moment opens it, so you can drop deeper.
            clearTimeout(hoverTimer);
            if (!state.openFolders.has(dropFolder)) hoverTimer = setTimeout(() => { state.openFolders.add(dropFolder); renderTree(); }, 700);
          }
        },
        ondragleave: (e) => { if (!e.currentTarget.contains(e.relatedTarget)) { e.currentTarget.classList.remove('drop-target'); clearTimeout(hoverTimer); } },
        ondrop: (e) => handleDrop(e, dropFolder),
      } : {}),
    };
  }

  async function moveFile(f, folder) {
    const name = f.path.split('/').pop();
    const to = (folder ? folder + '/' : '') + name;
    if (to === f.path) return;
    try {
      await api(`/api/projects/${projectId}/files/${f.id}`, { method: 'PATCH', body: { path: to } });
      state.pendingFolders.delete(folder);
      if (folder) state.openFolders.add(folder);
      await reloadProject();
      toast(`Moved to ${folder || 'top level'}`);
    } catch (e) { toast(e.message, 'error'); }
  }
  async function moveFolder(path, folder) {
    const to = (folder ? folder + '/' : '') + path.split('/').pop();
    if (to === path || folder === path || folder.startsWith(path + '/')) return;
    if (state.pendingFolders.has(path)) { state.pendingFolders.delete(path); state.pendingFolders.add(to); renderTree(); return; }
    try {
      await api(`/api/projects/${projectId}/folders/rename`, { method: 'POST', body: { from: path, to } });
      if (state.openFolders.has(path)) state.openFolders.add(to);
      if (folder) state.openFolders.add(folder);
      await reloadProject();
      toast(`Moved to ${folder || 'top level'}`);
    } catch (e) { toast(e.message, 'error'); }
  }

  // Resizable panes.
  const widths = JSON.parse(localStorage.getItem('labtex.widths') || '{"files":220,"pdf":0.5}');
  const applyWidths = () => {
    filesPane.style.width = widths.files + 'px';
    pdfPane.style.width = state.layout === 'both' ? `calc((100% - ${widths.files + 12}px) * ${widths.pdf})` : '';
  };
  const drag = (el, onMove) => el.addEventListener('pointerdown', (e) => {
    e.preventDefault(); el.setPointerCapture(e.pointerId); shell.classList.add('dragging');
    const move = (ev) => onMove(ev);
    const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); shell.classList.remove('dragging'); localStorage.setItem('labtex.widths', JSON.stringify(widths)); };
    el.addEventListener('pointermove', move); el.addEventListener('pointerup', up);
  });
  drag(split1, (e) => { widths.files = Math.min(500, Math.max(140, e.clientX - body.getBoundingClientRect().left)); applyWidths(); });
  drag(split2, (e) => {
    const r = body.getBoundingClientRect();
    const avail = r.width - widths.files - 12;
    widths.pdf = Math.min(0.85, Math.max(0.15, (r.right - e.clientX) / avail)); applyWidths();
  });
  function setLayout(k) {
    state.layout = k; localStorage.setItem('labtex.layout', k);
    body.dataset.layout = k;
    layoutBtns.querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.k === k));
    applyWidths();
    state.current?.view?.requestMeasure();
  }
  setLayout(state.layout);

  const pdfView = new PdfView(pdfHost, { onDoubleClick: reverseSync });

  // ---------- Project event channel ----------
  let projSock, projRetry = 0, projTimer;
  const connectProject = () => {
    if (state.destroyed) return;
    projSock = new WebSocket(`${WS_BASE}/ws/project/${projectId}`);
    projSock.onopen = () => { projRetry = 0; };
    projSock.onmessage = (e) => onProjectEvent(JSON.parse(e.data));
    projSock.onclose = (e) => {
      if (state.destroyed) return;
      if (e.code === 4003 || e.code === 4004) {
        toast(e.code === 4003 ? 'Your access to this project changed.' : 'This project was deleted.', 'error', 6000);
        if (e.code === 4004) { location.hash = '#/'; return; }
        // Access changed: reload to pick up the new role (or bounce out if removed).
        return reloadProject(true);
      }
      projTimer = setTimeout(connectProject, Math.min(10000, 500 * 2 ** projRetry++));
    };
  };
  connectProject();

  async function onProjectEvent(ev) {
    if (ev.type === 'presence') {
      presenceBox.replaceChildren(...ev.users.filter((u) => u.id !== me.id).map((u) => avatar(u, `${u.name} is here`)));
    } else if (ev.type === 'files' || ev.type === 'project') {
      await reloadProject();
    } else if (ev.type === 'tasks') {
      if (tasks.open) tasks.load(); else refreshTaskCount();
    } else if (ev.type === 'compiled') {
      if (!state.compiling && !(ev.by === me.name && Date.now() - state.lastOwnCompile < 4000)) {
        loadPdf();
      }
    }
  }

  async function reloadProject(roleMayChange = false) {
    try {
      const prevRole = project.role;
      project = await api(`/api/projects/${projectId}`);
      nameEl.textContent = project.name;
      updateReviewChrome(); if (reviewOpen) review.update();
      if (roleMayChange || prevRole !== project.role) {
        toast(`Your access is now: ${roleLabel(project.role)}`);
        const keep = state.current?.file?.id;
        cleanupFn(); // full re-open with new permissions
        root.replaceChildren();
        const c = await openEditor(root, projectId, me);
        replaceCleanup(c);
        return;
      }
      renderTree();
      // Handle the open file being renamed or deleted.
      if (state.current) {
        const f = project.files.find((x) => x.id === state.current.file.id);
        if (!f) { toast(`“${state.current.file.path}” was removed`); openFile(defaultFileId()); }
        else if (f.path !== state.current.file.path) { state.current.file = f; srcTitle.textContent = f.path; }
      }
      refreshKeys();
    } catch (e) {
      if (e.status === 404) { toast('You no longer have access to this project.', 'error'); location.hash = '#/'; }
    }
  }

  // ---------- File tree ----------
  function buildTree() {
    const rootNode = { name: '', path: '', folders: new Map(), files: [] };
    const ensure = (folderPath) => {
      let node = rootNode;
      if (!folderPath) return node;
      let acc = '';
      for (const part of folderPath.split('/')) {
        acc = acc ? acc + '/' + part : part;
        if (!node.folders.has(part)) node.folders.set(part, { name: part, path: acc, folders: new Map(), files: [] });
        node = node.folders.get(part);
      }
      return node;
    };
    for (const p of state.pendingFolders) ensure(p);
    for (const f of project.files) {
      const i = f.path.lastIndexOf('/');
      ensure(i > 0 ? f.path.slice(0, i) : '').files.push(f);
    }
    return rootNode;
  }

  function renderTree() {
    const tree = buildTree();
    const rows = [];
    const walk = (node, depth) => {
      const folders = [...node.folders.values()].sort((a, b) => a.name.localeCompare(b.name));
      for (const fo of folders) {
        const open = state.openFolders.has(fo.path);
        rows.push(h('div', {
          class: 'tree-row folder', role: 'treeitem', 'aria-expanded': String(open), tabindex: '0', style: { paddingLeft: 8 + depth * 14 + 'px' },
          onclick: () => toggleFolder(fo.path), onkeydown: (e) => { if (e.key === 'Enter') toggleFolder(fo.path); },
          oncontextmenu: (e) => { e.preventDefault(); folderMenu(e.currentTarget, fo.path); },
          ...dragProps({ type: 'folder', path: fo.path }, fo.path),
        }, h('span', { class: 'caret' }, open ? '▾' : '▸'), h('span', { class: 'ico' }, '📁'), h('span', { class: 'nm' }, fo.name),
        canEdit() && h('button', { class: 'row-menu', 'aria-label': `Folder actions for ${fo.name}`, onclick: (e) => { e.stopPropagation(); folderMenu(e.currentTarget, fo.path); } }, '⋯')));
        if (open) walk(fo, depth + 1);
      }
      for (const f of [...node.files].sort((a, b) => a.path.localeCompare(b.path))) {
        const name = f.path.split('/').pop();
        const isMain = f.path === project.main_file;
        rows.push(h('div', {
          class: 'tree-row file' + (state.current?.file.id === f.id ? ' active' : ''), role: 'treeitem', tabindex: '0',
          style: { paddingLeft: 8 + depth * 14 + 14 + 'px' }, title: f.path + (f.is_binary ? ` (${fmtBytes(f.size)})` : ''),
          onclick: () => openFile(f.id), onkeydown: (e) => { if (e.key === 'Enter') openFile(f.id); },
          oncontextmenu: (e) => { e.preventDefault(); fileMenu(e.currentTarget, f); },
          ...dragProps({ type: 'file', file: f }, f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : undefined),
        }, h('span', { class: 'ico' }, fileIcon(f.path)), h('span', { class: 'nm' }, name),
        isMain ? h('span', { class: 'main-star', title: 'Main document' }, '★') : null,
        h('button', { class: 'row-menu', 'aria-label': `File actions for ${name}`, onclick: (e) => { e.stopPropagation(); fileMenu(e.currentTarget, f); } }, '⋯')));
      }
    };
    walk(tree, 0);
    fileTree.replaceChildren(...rows);
    if (!rows.length) fileTree.append(h('div', { class: 'muted pad small' }, 'No files.'));
  }
  const fileIcon = (p) => /\.tex$/i.test(p) ? '📝' : /\.bib$/i.test(p) ? '📚' : isImage(p) ? '🖼' : /\.pdf$/i.test(p) ? '📕' : '📄';
  function toggleFolder(path) {
    state.openFolders.has(path) ? state.openFolders.delete(path) : state.openFolders.add(path);
    localStorage.setItem(`labtex.folders.${projectId}`, JSON.stringify([...state.openFolders]));
    renderTree();
  }

  function fileMenu(anchor, f) {
    menu(anchor, [
      { label: 'Open', onClick: () => openFile(f.id) },
      !f.is_binary && /\.tex$/i.test(f.path) && f.path !== project.main_file && { label: 'Set as main document', disabled: !canEdit(), onClick: () => setMain(f.path) },
      { label: 'Download', onClick: () => (location.href = `/api/projects/${projectId}/files/${f.id}/raw?download=1`) },
      canEdit() && 'sep',
      canEdit() && { label: 'Rename / move…', onClick: () => renameFile(f) },
      canEdit() && { label: 'Delete', danger: true, onClick: () => deleteFile(f) },
    ]);
  }
  function folderMenu(anchor, path) {
    if (!canEdit()) return;
    menu(anchor, [
      { label: 'New file here…', onClick: () => newFile(path) },
      { label: 'New folder here…', onClick: () => newFolder(path) },
      { label: 'Upload files here…', onClick: () => { uploadInput.dataset.folder = path; uploadInput.click(); } },
      'sep',
      { label: 'Rename / move folder…', onClick: () => renameFolder(path) },
      { label: 'Delete folder', danger: true, onClick: () => deleteFolder(path) },
    ]);
  }

  async function newFile(folder) {
    const name = await prompt('New file', { label: folder ? `In folder “${folder}”` : 'File name (use / for folders, e.g. sections/intro.tex)', value: 'untitled.tex', okText: 'Create' });
    if (!name) return;
    const path = (folder ? folder + '/' : '') + name;
    try {
      const r = await api(`/api/projects/${projectId}/files`, { method: 'POST', body: { path } });
      state.pendingFolders.delete(folder);
      if (folder) state.openFolders.add(folder);
      await reloadProject(); openFile(r.id);
    } catch (e) { toast(e.message, 'error'); }
  }
  async function newFolder(parent) {
    const name = await prompt('New folder', { label: parent ? `Inside “${parent}”` : 'Folder name', value: '', placeholder: 'figures', okText: 'Create' });
    if (!name) return;
    const p = (parent ? parent + '/' : '') + name.replace(/^\/+|\/+$/g, '');
    state.pendingFolders.add(p); state.openFolders.add(p);
    if (parent) state.openFolders.add(parent);
    renderTree();
    toast('Folder created. Add or upload files into it so it is saved.');
  }
  async function renameFile(f) {
    const p = await prompt('Rename or move', { label: 'New path (use / to move into a folder)', value: f.path, okText: 'Rename' });
    if (!p || p === f.path) return;
    try { await api(`/api/projects/${projectId}/files/${f.id}`, { method: 'PATCH', body: { path: p } }); await reloadProject(); }
    catch (e) { toast(e.message, 'error'); }
  }
  async function deleteFile(f) {
    if (!(await confirmBox('Delete file', `Delete “${f.path}”? You can recover it from History.`, { okText: 'Delete', danger: true }))) return;
    try { await api(`/api/projects/${projectId}/files/${f.id}`, { method: 'DELETE' }); await reloadProject(); }
    catch (e) { toast(e.message, 'error'); }
  }
  async function renameFolder(path) {
    const to = await prompt('Rename folder', { label: 'New folder path', value: path, okText: 'Rename' });
    if (!to || to === path) return;
    if (state.pendingFolders.has(path)) { state.pendingFolders.delete(path); state.pendingFolders.add(to); renderTree(); return; }
    try { await api(`/api/projects/${projectId}/folders/rename`, { method: 'POST', body: { from: path, to } }); state.openFolders.add(to); await reloadProject(); }
    catch (e) { toast(e.message, 'error'); }
  }
  async function deleteFolder(path) {
    if (state.pendingFolders.has(path)) { state.pendingFolders.delete(path); renderTree(); return; }
    const n = project.files.filter((f) => f.path.startsWith(path + '/')).length;
    if (!(await confirmBox('Delete folder', `Delete “${path}” and the ${n} file(s) inside it? You can recover them from History.`, { okText: 'Delete', danger: true }))) return;
    try { await api(`/api/projects/${projectId}/folders/delete`, { method: 'POST', body: { folder: path } }); await reloadProject(); }
    catch (e) { toast(e.message, 'error'); }
  }
  async function uploadFiles(list, folder) {
    if (!list.length) return;
    const form = new FormData();
    if (folder) form.append('folder', folder);
    for (const f of list) form.append('files', f, f.name);
    try {
      toast(`Uploading ${list.length} file(s)…`);
      const r = await api(`/api/projects/${projectId}/upload`, { method: 'POST', form });
      state.pendingFolders.delete(folder);
      toast(`Uploaded ${r.files.length} file(s)`, 'ok');
      await reloadProject();
    } catch (e) { toast(e.message, 'error'); }
  }
  async function setMain(path) {
    try { await api(`/api/projects/${projectId}`, { method: 'PATCH', body: { main_file: path } }); await reloadProject(); toast(`Main document: ${path}`); }
    catch (e) { toast(e.message, 'error'); }
  }
  async function setEngine(engine) {
    try { await api(`/api/projects/${projectId}`, { method: 'PATCH', body: { engine } }); project.engine = engine; toast(`Compiler: ${engine}`); compile(); }
    catch (e) { toast(e.message, 'error'); }
  }

  // ---------- Opening files ----------
  const defaultFileId = () => ((project.is_lab && project.files.find((f) => f.path === 'lab.bib')) || project.files.find((f) => f.path === project.main_file) || project.files.find((f) => !f.is_binary) || project.files[0])?.id;
  const readOnlyComp = new Compartment();
  // Syntax colors follow the light/dark theme.
  const highlightComp = new Compartment();
  const highlightFor = (dark) => latexHighlight(dark);
  const offTheme = onThemeChange((dark) => state.current?.view?.dispatch({ effects: highlightComp.reconfigure(highlightFor(dark)) }));

  function closeCurrent() {
    const c = state.current;
    if (!c) return;
    review.pendingNew = null;
    if (c.view) { state.cursors.set(c.file.id, { anchor: c.view.state.selection.main.anchor, scroll: c.view.scrollDOM.scrollTop }); c.view.destroy(); }
    c.provider?.destroy();
    c.ydoc?.destroy();
    state.current = null;
  }

  async function openFile(fileId, gotoLine) {
    const file = project.files.find((f) => f.id === fileId);
    if (!file) { srcHost.replaceChildren(h('div', { class: 'muted pad' }, 'No file selected.')); return; }
    if (state.current?.file.id === fileId) { if (gotoLine) goToLine(gotoLine); return; }
    closeCurrent();
    localStorage.setItem(`labtex.lastfile.${projectId}`, fileId);
    // Expand parent folders.
    const parts = file.path.split('/'); parts.pop();
    let acc = ''; for (const p of parts) { acc = acc ? acc + '/' + p : p; state.openFolders.add(acc); }
    srcTitle.textContent = file.path;
    state.current = { file };
    renderTree();

    if (file.is_binary) {
      srcStatus.textContent = fmtBytes(file.size);
      const url = `/api/projects/${projectId}/files/${file.id}/raw?v=${file.updated_at}`;
      srcHost.replaceChildren(h('div', { class: 'binary-view' },
        isImage(file.path) ? h('img', { src: url, alt: file.path }) : h('div', { class: 'muted' }, 'This file can’t be edited in the browser.'),
        h('div', {}, h('a', { class: 'btn', href: url + '&download=1' }, 'Download'),
          canEdit() && h('button', { class: 'btn', onclick: () => { uploadInput.dataset.folder = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : ''; uploadInput.click(); } }, 'Replace…'))));
      return;
    }

    srcHost.replaceChildren(h('div', { class: 'muted pad' }, 'Connecting…'));
    srcStatus.textContent = 'Connecting…';
    const ydoc = new Y.Doc();
    const provider = new WebsocketProvider(`${WS_BASE}/ws/doc`, file.id, ydoc, { disableBc: true, maxBackoffTime: 5000 });
    const cur = state.current;
    cur.ydoc = ydoc; cur.provider = provider;
    provider.awareness.setLocalStateField('user', { name: me.name, color: myColor, colorLight: myColor + '33' });
    provider.on('status', ({ status }) => {
      if (state.current !== cur) return;
      srcStatus.textContent = status === 'connected' ? (canEdit() ? 'All changes saved' : canComment() ? 'Comment only' : 'Read-only') : status === 'connecting' ? 'Reconnecting…' : 'Offline';
      srcStatus.className = 'src-status ' + status;
    });

    await new Promise((resolve) => {
      if (provider.synced) return resolve();
      const on = (s) => { if (s) { provider.off('sync', on); resolve(); } };
      provider.on('sync', on);
    });
    if (state.current !== cur || state.destroyed) return;

    const ytext = ydoc.getText('content');
    const undo = new Y.UndoManager(ytext);
    undo.addTrackedOrigin(TC_ORIGIN); // so Ctrl+Z also undoes "marked as deleted" suggestions
    cur.undo = undo;
    const lang = isTexLike(file.path) ? [StreamLanguage.define(stex)] : [];
    const view = new EditorView({
      parent: srcHost,
      state: EditorState.create({
        doc: ytext.toString(),
        extensions: [
          lineNumbers(), highlightActiveLineGutter(), highlightSpecialChars(), drawSelection(), dropCursor(),
          EditorState.allowMultipleSelections.of(true), indentOnInput(), bracketMatching(), closeBrackets(),
          rectangularSelection(), crosshairCursor(), highlightActiveLine(), highlightSelectionMatches(),
          highlightComp.of(highlightFor(isDark())), indentUnit.of('  '),
          autocompletion({ override: isTexLike(file.path) ? [latexCompletions(() => state.keys)] : [], activateOnTyping: true, icons: false }),
          ...lang,
          EditorView.lineWrapping,
          // The current-line tint must be translucent, or it hides the selection drawn beneath it.
          EditorView.theme({
            '.cm-activeLine': { backgroundColor: 'var(--cm-active-line)' },
            '.cm-selectionBackground': { backgroundColor: 'var(--cm-selection-blur)' },
            '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': { backgroundColor: 'var(--cm-selection)' },
            '.cm-content ::selection': { backgroundColor: 'var(--cm-selection)' },
            '.cm-selectionMatch': { backgroundColor: 'rgba(250, 204, 21, 0.25)' },
          }),
          EditorView.contentAttributes.of({ spellcheck: 'true', autocorrect: 'off', autocapitalize: 'off' }),
          readOnlyComp.of([EditorState.readOnly.of(!canEdit()), EditorView.editable.of(canComment())]),
          keymap.of([
            { key: 'Mod-Enter', run: () => { compile(); return true; } },
            { key: 'Mod-s', run: () => { compile(); return true; }, preventDefault: true },
            { key: 'Mod-/', run: toggleComment },
            { key: 'Mod-b', run: (v) => wrapSel(v, '\\textbf{', '}') },
            { key: 'Mod-i', run: (v) => wrapSel(v, '\\textit{', '}') },
            { key: 'Mod-Alt-m', run: (v) => { const r = v.state.selection.main; if (r.empty || !canComment()) return false; toggleReview(true); review.newComment(r.from, r.to); return true; } },
            ...closeBracketsKeymap, ...completionKeymap, ...searchKeymap, ...yUndoManagerKeymap, ...defaultKeymap, indentWithTab,
          ]),
          yCollab(ytext, provider.awareness, { undoManager: undo }),
          reviewExtension({
            ydoc, ytext, user: myUser,
            isTracking: () => !!project.track_changes,
            canEdit: () => canEdit(),
            canComment: () => canComment(),
            onComment: (from, to) => { toggleReview(true); review.newComment(from, to); },
            onFocusThread: (id) => { toggleReview(true); review.render(); review.focusThread(id); },
            onChange: onReviewChange,
          }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged && u.transactions.some((t) => t.isUserEvent('input') || t.isUserEvent('delete') || t.isUserEvent('undo') || t.isUserEvent('redo') || t.isUserEvent('move'))) scheduleAutoCompile();
          }),
        ],
      }),
    });
    srcHost.replaceChildren(view.dom);
    onReviewChange(); if (reviewOpen) review.render();
    cur.view = view;
    const saved = state.cursors.get(file.id);
    if (gotoLine) goToLine(gotoLine);
    else if (saved) {
      view.dispatch({ selection: { anchor: Math.min(saved.anchor, view.state.doc.length) } });
      requestAnimationFrame(() => (view.scrollDOM.scrollTop = saved.scroll));
    }
    view.focus();
  }

  function wrapSel(view, before, after) {
    if (!canEdit()) return false;
    view.dispatch(view.state.changeByRange((r) => ({
      changes: [{ from: r.from, insert: before }, { from: r.to, insert: after }],
      range: r.empty ? { anchor: r.from + before.length } : { anchor: r.from + before.length, head: r.to + before.length },
    })));
    return true;
  }

  function goToLine(line) {
    const v = state.current?.view;
    if (!v) return;
    const l = v.state.doc.line(Math.max(1, Math.min(line, v.state.doc.lines)));
    v.dispatch({ selection: { anchor: l.from }, effects: EditorView.scrollIntoView(l.from, { y: 'center' }) });
    v.focus();
  }
  async function openPath(path, line) {
    const f = project.files.find((x) => x.path === path || x.path === path.replace(/^\.\//, ''));
    if (!f) return toast(`File “${path}” is not in this project`, 'error');
    if (state.current?.file.id === f.id) goToLine(line);
    else await openFile(f.id, line);
  }

  // ---------- Compile ----------
  let autoTimer;
  function scheduleAutoCompile() {
    if (!state.autoCompile) return;
    clearTimeout(autoTimer);
    autoTimer = setTimeout(() => compile(true), 2500);
  }

  async function compile(silent = false) {
    if (state.compiling) return;
    state.compiling = true;
    compileBtn.classList.add('busy'); compileBtn.querySelector('.lbl').textContent = 'Compiling…';
    try {
      const r = await api(`/api/projects/${projectId}/compile`, { method: 'POST' });
      state.lastResult = r;
      state.lastOwnCompile = Date.now();
      renderLogBadge();
      if (r.hasPdf) await loadPdf();
      else pdfView.showMessage('No PDF was produced. Open the logs to see what went wrong.');
      if (!r.ok && !silent && r.errors.length) { if (!r.hasPdf) toggleLogs(true); }
      if (!logPanel.hidden) renderLogs();
      refreshKeys();
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      state.compiling = false;
      compileBtn.classList.remove('busy'); compileBtn.querySelector('.lbl').textContent = 'Recompile';
    }
  }
  const loadPdf = () => pdfView.load(`/api/projects/${projectId}/pdf?t=${Date.now()}`);

  function renderLogBadge() {
    const r = state.lastResult;
    logBtn.replaceChildren('Logs');
    if (!r) return;
    if (r.errors.length) logBtn.append(h('span', { class: 'cnt err' }, r.errors.length));
    const w = r.warnings.filter((x) => !x.box).length;
    if (w) logBtn.append(h('span', { class: 'cnt warn' }, w));
    if (!r.errors.length && !w) logBtn.append(h('span', { class: 'cnt ok' }, '✓'));
  }
  function toggleLogs(force) {
    logPanel.hidden = force === undefined ? !logPanel.hidden : !force;
    logBtn.classList.toggle('active', !logPanel.hidden);
    if (!logPanel.hidden) renderLogs();
  }
  function renderLogs() {
    const r = state.lastResult;
    if (!r) { logPanel.replaceChildren(h('div', { class: 'muted pad' }, 'Compile the project to see logs.')); return; }
    const entry = (kind, e) => h('button', {
      class: `log-entry ${kind}`, disabled: !e.line,
      onclick: () => { if (e.line) openPath(e.file || project.main_file, e.line); },
    }, h('div', { class: 'log-head' }, h('strong', {}, kind === 'err' ? 'Error' : kind === 'box' ? 'Typesetting' : 'Warning'),
      e.file ? h('code', {}, `${e.file}${e.line ? ':' + e.line : ''}`) : e.line ? h('code', {}, `line ${e.line}`) : null),
    h('pre', {}, e.message));
    const raw = h('pre', { class: 'raw-log', hidden: true }, r.log);
    const warnings = r.warnings.filter((w) => !w.box), boxes = r.warnings.filter((w) => w.box);
    logPanel.replaceChildren(h('div', {},
      h('div', { class: 'log-top' }, h('strong', {}, r.ok ? 'Compiled successfully' : r.hasPdf ? 'Compiled with errors' : 'Compilation failed'),
        h('span', { class: 'muted small' }, ` · ${(r.ms / 1000).toFixed(1)}s · ${project.engine}`), h('div', { class: 'spacer' }),
        h('button', { class: 'btn small', onclick: () => (raw.hidden = !raw.hidden) }, 'Raw log'),
        h('button', { class: 'icon-btn', 'aria-label': 'Close logs', onclick: () => toggleLogs(false) }, '✕')),
      r.errors.map((e) => entry('err', e)),
      warnings.map((e) => entry('warn', e)),
      boxes.length ? h('details', { class: 'box-group' }, h('summary', {}, `${boxes.length} over/underfull box warning(s)`), boxes.map((e) => entry('box', e))) : null,
      !r.errors.length && !r.warnings.length ? h('div', { class: 'muted pad' }, 'No errors or warnings. 🎉') : null,
      raw));
  }

  // ---------- SyncTeX ----------
  async function forwardSync() {
    const c = state.current;
    if (!c?.view) return;
    const line = c.view.state.doc.lineAt(c.view.state.selection.main.head).number;
    const r = await api(`/api/projects/${projectId}/synctex/view?file=${encodeURIComponent(c.file.path)}&line=${line}`);
    if (!r.boxes.length) return toast('No matching location in the PDF. Try recompiling.');
    if (state.layout === 'src') setLayout('both');
    pdfView.highlight(r.boxes);
  }
  async function reverseSync(page, x, y) {
    const r = await api(`/api/projects/${projectId}/synctex/edit?page=${page}&x=${x.toFixed(2)}&y=${y.toFixed(2)}`);
    if (!r.fileId) return toast('No matching source location.');
    if (state.layout === 'pdf') setLayout('both');
    if (state.current?.file.id === r.fileId) goToLine(r.line);
    else openFile(r.fileId, r.line);
  }

  // ---------- Completion keys (cite keys, labels, file names) ----------
  let keysTimer;
  async function refreshKeys() {
    clearTimeout(keysTimer);
    keysTimer = setTimeout(async () => {
      try {
        const texts = project.files.filter((f) => !f.is_binary && /\.(tex|bib)$/i.test(f.path));
        const cites = [], labels = [];
        await Promise.all(texts.map(async (f) => {
          const t = await api(`/api/projects/${projectId}/files/${f.id}/raw`);
          if (/\.bib$/i.test(f.path)) cites.push(...parseBibKeys(t)); else labels.push(...parseLabels(t));
        }));
        if (projectId !== LAB_ID && me.lab_member && !project.files.some((f) => f.path === 'lab.bib')) {
          try {
            const lab = await api(`/api/projects/${LAB_ID}`);
            const lf = lab.files.find((f) => f.path === 'lab.bib');
            if (lf) cites.push(...parseBibKeys(await api(`/api/projects/${LAB_ID}/files/${lf.id}/raw`)).map((k) => ({ ...k, detail: '[lab] ' + k.detail })));
          } catch {}
        }
        const files = project.files.map((f) => f.path.replace(/\.tex$/i, ''));
        state.keys = { cites, labels: [...new Set(labels)], files };
      } catch {}
    }, 300);
  }

  // ---------- Dialogs ----------
  async function renameProject() {
    if (!canManage() || project.is_lab) return;
    const n = await prompt('Rename project', { value: project.name, okText: 'Rename' });
    if (!n || n === project.name) return;
    try { await api(`/api/projects/${projectId}`, { method: 'PATCH', body: { name: n } }); nameEl.textContent = n; project.name = n; }
    catch (e) { toast(e.message, 'error'); }
  }
  async function copyProject() {
    const n = await prompt('Copy project', { label: 'Name of the copy', value: `Copy of ${project.name}`, okText: 'Copy' });
    if (n == null) return;
    const { id } = await api(`/api/projects/${projectId}/copy`, { method: 'POST', body: { name: n } });
    toast('Copied. Opening the copy.', 'ok');
    location.hash = `#/p/${id}`;
  }

  function shareDialog() {
    openShareDialog(projectId, me, { onChange: (p) => { project = { ...project, members: p.members, lab_role: p.lab_role }; mentionCache = null; } });
  }
  // People who can be @mentioned: members, or the whole lab when the project is shared with it.
  let mentionCache = null;
  async function loadMentionables() {
    try {
      mentionCache = project.lab_role || project.is_lab
        ? (await api('/api/team')).map((u) => ({ id: u.id, name: u.name }))
        : project.members.map((m) => ({ id: m.id, name: m.name }));
    } catch { mentionCache = project.members.map((m) => ({ id: m.id, name: m.name })); }
  }
  function mentionables() {
    if (!mentionCache) loadMentionables();
    return (mentionCache || project.members).filter((u) => u.id !== me.id);
  }
  async function refreshTaskCount() {
    try { const list = await api(`/api/projects/${projectId}/tasks`); tasks.tasks = list; tasks.onCount(list.filter((t) => t.status !== 'done').length); } catch {}
  }
  // A notification brought us here: open the right thread / task / history.
  async function handlePending() {
    const p = takePending(projectId);
    if (!p) return;
    if (p.task) { tasks.toggle(true); await tasks.load(); tasks.flash(p.task); const t = tasks.tasks.find((x) => x.id === p.task); if (t?.file_path) openPath(t.file_path, t.line || undefined); }
    if (p.fileId && project.files.some((f) => f.id === p.fileId)) {
      await openFile(p.fileId);
      if (p.thread) { toggleReview(true); review.render(); setTimeout(() => review.focusThread(p.thread), 50); }
    }
    if (p.history) openHistory(projectId, canEdit()).then((r) => { if (r) afterRestore(); });
  }
  window.addEventListener('labtex:pending', handlePending);

  function settingsDialog() {
    modal('Project settings', (close) => {
      const isOwner = canManage();
      const engine = h('select', { disabled: !canEdit() }, project.engines.map((e) => h('option', { value: e, selected: e === project.engine }, e)));
      const main = h('select', { disabled: !canEdit() }, project.files.filter((f) => !f.is_binary && /\.tex$/i.test(f.path)).map((f) => h('option', { value: f.path, selected: f.path === project.main_file }, f.path)));
      const isTpl = h('input', { type: 'checkbox', checked: !!project.is_template, disabled: !isOwner || project.is_lab });
      const tplDesc = h('input', { type: 'text', value: project.template_description || '', placeholder: 'Short description shown in the New project dialog', disabled: !isOwner || project.is_lab });
      return h('form', { onsubmit: async (e) => {
        e.preventDefault();
        try {
          const body = {};
          if (canEdit()) { if (engine.value !== project.engine) body.engine = engine.value; if (main.value && main.value !== project.main_file) body.main_file = main.value; }
          if (isOwner && !project.is_lab && me.lab_member) { body.is_template = isTpl.checked; body.template_description = tplDesc.value; }
          if (Object.keys(body).length) await api(`/api/projects/${projectId}`, { method: 'PATCH', body });
          close(); await reloadProject(); project = await api(`/api/projects/${projectId}`); toast('Settings saved', 'ok');
        } catch (ex) { toast(ex.message, 'error'); }
      } },
      h('label', {}, 'Compiler', engine), h('p', { class: 'hint' }, 'Use xelatex or lualatex for system fonts (fontspec) and Unicode-heavy documents.'),
      h('label', {}, 'Main document', main),
      !project.is_lab && me.lab_member && h('fieldset', {}, h('legend', {}, 'Lab template'),
        h('label', { class: 'check' }, isTpl, 'Offer this project as a starting template for everyone in the lab'),
        tplDesc, !isOwner && h('p', { class: 'hint' }, 'Only the owner or a project admin can change this.')),
      h('div', { class: 'modal-actions' },
        project.role === 'owner' && !project.is_lab && h('button', { type: 'button', class: 'btn danger-text', onclick: async () => {
          if (!(await confirmBox('Delete project', `Delete “${project.name}” for everyone? This cannot be undone.`, { okText: 'Delete', danger: true }))) return;
          await api(`/api/projects/${projectId}`, { method: 'DELETE' }); close(); location.hash = '#/';
        } }, 'Delete project'),
        h('div', { class: 'spacer' }),
        h('button', { type: 'button', class: 'btn', onclick: () => close() }, 'Cancel'),
        h('button', { type: 'submit', class: 'btn primary' }, 'Save')));
    });
  }

  async function afterRestore() {
    await reloadProject();
    compile(true);
  }

  // ---------- Global keys ----------
  const onKey = (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'Enter')) { e.preventDefault(); compile(); }
  };
  document.addEventListener('keydown', onKey);

  // ---------- Start ----------
  renderTree();
  const last = localStorage.getItem(`labtex.lastfile.${projectId}`);
  const pendingAtOpen = (() => { try { return JSON.parse(sessionStorage.getItem('labtex.pending') || 'null'); } catch { return null; } })();
  const firstFile = pendingAtOpen?.pid === projectId && pendingAtOpen.fileId && project.files.some((f) => f.id === pendingAtOpen.fileId) ? pendingAtOpen.fileId : project.files.some((f) => f.id === last) ? last : defaultFileId();
  openFile(firstFile).then(() => handlePending());
  refreshKeys();
  refreshTaskCount();
  loadMentionables();
  loadPdf().then((ok) => { if (!ok) compile(true); });

  let externalCleanup = null;
  const replaceCleanup = (c) => { externalCleanup = c; };
  function cleanupFn() {
    state.destroyed = true;
    clearTimeout(autoTimer); clearTimeout(projTimer); clearTimeout(keysTimer);
    closeCurrent();
    projSock?.close();
    pdfView.destroy();
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('dragend', onDragEnd);
    window.removeEventListener('labtex:pending', handlePending);
    offTheme();
  }
  return () => { if (externalCleanup) externalCleanup(); else cleanupFn(); };
}
