# LabTeX: a self-hosted, Overleaf-style LaTeX editor for your lab

LabTeX is a self-hosted web app where lab members write LaTeX together in the browser. It has:

- **Real-time co-editing**: several people can edit the same file at once and see each other's named cursors (built on Yjs CRDTs, so edits never conflict).
- **Track changes and comments**: turn on *Track changes* in the **Review** panel and everyone's edits become suggestions (insertions highlighted, deletions struck through, colored by author) that you accept or reject one at a time or all at once. Select any text and click **💬 Comment** (or press Ctrl/⌘+Alt+M) to start a threaded discussion, which you can reply to, resolve, or reopen. The PDF is always built from the text as if all suggestions were accepted.
- **Real TeX Live compilation**: pdflatex, xelatex or lualatex through `latexmk`. BibTeX and biber run automatically.
- **PDF preview with SyncTeX**: *Go to PDF →* jumps from your cursor to the PDF, and double-clicking the PDF jumps to the source line.
- **Clickable error log**: errors and warnings link to the file and line that caused them. The raw log is available too.
- **Teammates and roles**: each project has five roles: **Viewer** (read, compile, download), **Commenter** (viewer + comments and tasks), **Editor** (commenter + edit files, accept/reject suggestions), **Admin** (editor + manage sharing and project settings) and **Owner** (admin + delete the project or transfer ownership). Share with a person by picking them from the lab directory, or share with **everyone in the lab** (view, comment or edit), which also covers people who join later. Lab-wide projects appear under the **Lab workspace** tab on the Projects page.
- **Team directory**: the **Team** page lists every lab member with their role in the lab, whether they're online, and how many projects and open tasks you share. Open a profile to share one of your projects with them or assign them a task. Lab admins add members, reset passwords and grant admin rights from the same page.
- **Accounts vs. the lab team**: anyone can sign up and use LabTeX right away for their own projects and for anything shared with them directly (collaborators outside the lab, students, co-authors). Being on the **lab team** is separate and is up to a lab admin. Only lab-team members see the Team directory, the lab library (`lab.bib`), lab templates, and projects shared with "everyone in the lab". New sign-ups appear under **Not on the lab team** on the Team page. From there an admin can click **Add to lab team** or delete the account, and every admin gets a notification when someone signs up. Use **Remove from lab team** in a member's ⋯ menu to take them off the team; they keep their account and projects. The **New sign-ups** setting on the Team page chooses between: anyone can sign up and an admin adds them to the team (the default); anyone can sign up and joins the team automatically; or sign-up is off and only admins create accounts. `ALLOW_REGISTRATION=false` in `docker-compose.yml` forces sign-up off, and `REGISTRATION_CODE` still works if you want a code on the sign-up form.
- **Tasks**: create tasks from the **✓ Tasks** drawer in any project (new tasks link to the line you're on) or straight from a comment thread (**✓ Task**). Tasks have an assignee, a due date and a status (to do, in progress, done). **My tasks** collects everything assigned to you or created by you, grouped into overdue, today, this week and later. Your open tasks also appear at the top of the Projects page.
- **Notifications**: the 🔔 bell shows a live unread count and a list of what happened: projects shared with you, role changes, task assignments, completions and due-date reminders, comments on your projects, replies to your threads, **@mentions** (type @ in a comment to pick a teammate), and labelled versions. Clicking a notification opens the exact project, comment thread or task. You can also turn on desktop pop-ups for when LabTeX is in the background. Notifications are in-app only; LabTeX does not send email.
- **Templates**: starter templates (article, paper with BibTeX, thesis, Beamer). Any project can be published as a **lab template** for everyone to start from.
- **Shared lab bibliography**: a lab-wide `lab.bib` that everyone can edit. Every project can cite it with `\bibliography{lab}` or `\addbibresource{lab.bib}`.
- **Version history**: a snapshot is saved automatically on successful compiles (at most one every 2 minutes), and you can save labelled versions by hand. You can view a line diff against the current state, restore a single file or the whole project, and download any version as a .zip.
- **Import and export**: import a .zip (an Overleaf "Download source" zip works) and download the source as a .zip or the PDF.
- **Editor features**: LaTeX syntax highlighting, autocomplete for commands and environments (`\begin{…}` inserts the matching `\end`), `\cite{}` keys from your .bib files and the lab library, `\ref{}` labels, and file names. Also: browser spell-check, Ctrl/⌘+B and Ctrl/⌘+I, Ctrl/⌘+/ to comment a line, Ctrl/⌘+S or Ctrl/⌘+Enter to compile, optional auto-compile, and drag-and-drop uploads for images and other files.

---

## Quick start (Docker, recommended)

You need a Linux machine with Docker and Docker Compose, about 8 GB of free disk space for the full TeX Live image, and at least 2 GB of RAM.

```bash
# 1. Copy this folder to the server, then:
cd labtex

# 2. Edit docker-compose.yml and set REGISTRATION_CODE to a secret you'll share with the lab.

# 3. Build and start (the first build downloads TeX Live and takes a while)
docker compose up -d --build

# 4. Open http://SERVER:3000
```

**The first account you create becomes the administrator.** After that, people can register only with the lab registration code. You can also turn registration off (`ALLOW_REGISTRATION: "false"`) and create accounts from **Admin → Lab members**.

All data lives in `./labtex-data` (a single SQLite database containing users, projects, files and history). **Back up this folder.** A simple nightly backup (add it to root's crontab):

```bash
0 3 * * *  cd /path/to/labtex && docker compose stop labtex && tar czf /backups/labtex-$(date +\%F).tgz labtex-data && docker compose start labtex
```

### HTTPS (strongly recommended beyond a trusted LAN)

Put a reverse proxy in front of LabTeX. With [Caddy](https://caddyserver.com), a complete `Caddyfile` is:

```
latex.yourlab.org {
    reverse_proxy localhost:3000
}
```

Caddy gets certificates automatically and proxies WebSockets. Then set `SECURE_COOKIES: "true"` and `TRUST_PROXY: "true"` in `docker-compose.yml`.

For nginx, remember the WebSocket headers:

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 1h;
    client_max_body_size 60m;
}
```

---

## Running without Docker

```bash
sudo apt install texlive-full latexmk nodejs npm   # Node 20+ required
npm ci
npm run build
DATA_DIR=/var/lib/labtex PORT=3000 npm start
```

> **Security note:** without Docker, TeX runs as the same user as the server. pdflatex and xelatex are restricted to the project folder (`openin_any=p`), but **lualatex's Lua `io.open` can read any file the server user can read, including the database**. If your users aren't fully trusted, use Docker. Or replicate its setup: create a separate `texrunner` user, add a sudoers rule `labtex ALL=(texrunner) NOPASSWD: /usr/bin/env`, and set `COMPILE_USER=texrunner` and `BUILD_DIR` to a directory with mode `711`.

---

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `DATA_DIR` | `./data` | Where the SQLite database lives |
| `BUILD_DIR` | `$DATA_DIR/builds` | Compile working folders (safe to delete; they're a cache) |
| `ALLOW_REGISTRATION` | `true` | Allow self sign-up (the first user can always register) |
| `REGISTRATION_CODE` | *(none)* | If set, sign-up requires this code |
| `SECURE_COOKIES` | `false` | Set `true` when served over HTTPS |
| `TRUST_PROXY` | `false` | Set `true` behind a reverse proxy |
| `COMPILE_USER` | *(none; `texrunner` in Docker)* | Run TeX as this user via sudo |
| `COMPILE_TIMEOUT_SECONDS` | `120` | Kill compiles that run longer than this |
| `MAX_CONCURRENT_COMPILES` | `3` | Extra compiles queue up |
| `MAX_UPLOAD_MB` | `50` | Per-file upload limit |
| `ALLOWED_ORIGINS` | *(none)* | Extra origins allowed to open WebSockets (comma-separated) |

## Security model

- Passwords are hashed with bcrypt. Sessions use HttpOnly, SameSite=Lax cookies. Failed logins are rate-limited.
- Only TeX Live's *restricted* shell escape is allowed: trusted helpers such as `latexminted` (minted v3), `bibtex`, `makeindex` and `repstopdf` can run, but arbitrary `\write18` commands cannot. TeX can only read and write inside the project's own folder (paranoid `openin_any`/`openout_any`).
- `latexmkrc` files inside projects are ignored (they are Perl code). LabTeX uses its own `server/latexmkrc`, which also runs `makeglossaries` (glossaries/acronyms) and nomencl automatically.
- In Docker, TeX runs as a separate `texrunner` account that cannot read `/data`, and compiles are killed after the timeout.
- Viewers can read and compile but can't edit, and Commenters can only add comments: the server checks every change and drops anything a role isn't allowed to make, not only the UI.
- Lab admins can open every project.

## How it works

```
browser ──HTTP──▶ Express API (auth, projects, files, compile, history)  ──▶ SQLite
        ──WS────▶ /ws/doc/<file>      Yjs sync + cursors (one room per open file)
        ──WS────▶ /ws/project/<id>    file-tree changes, presence, "X compiled"
compile: files are written to a per-project build folder, then `latexmk` runs there
         (incremental, so recompiles are fast) and the PDF, log and SyncTeX output are returned
```

- `server/`: `index.js` (REST API), `collab.js` (Yjs WebSocket server), `compile.js` (latexmk, log parser), `db.js`, `auth.js`, `templates.js`
- `client/`: the single-page app (CodeMirror 6, y-codemirror, pdf.js), bundled by esbuild into `public/app.js`

To add more built-in templates, edit `server/templates.js`. Usually it's easier to make a project and tick **Menu → Project settings → Lab template**.
