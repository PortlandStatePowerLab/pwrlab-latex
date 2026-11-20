# Intro to Labtex

LabTeX is a self-hosted LaTeX editor for writing and compiling documents in a browser. Users can collaborate in real time and preview the compiled PDF alongside the source.

## Use LabTeX

Open the [hosted LabTeX editor](http://psuegotderms.ece.pdx.edu:8080) in your browser. Sign in to create a project or import an existing ZIP archive.

## Features

- Create projects from templates, import or export ZIP archives, and upload supporting files.
- Share projects with collaborators and grant editor or viewer access.
- Compile documents to PDF and use SyncTeX to jump between source and preview.
- Save project snapshots and restore earlier versions.

## Developer setup with Docker

1. Install Docker with the Compose plugin.
2. In [labtex/docker-compose.yml](labtex/docker-compose.yml), replace the placeholder `REGISTRATION_CODE` with a private code to share with lab members.
3. From the repository root, build and start the service.

   ```sh
   cd labtex
   docker compose up -d --build
   ```

4. Open [your local LabTeX instance](http://localhost:3000) and register using the code you configured.

## Repository layout

- [labtex/](labtex/) contains the application and the Compose configuration used above.
- [labtex-beta/](labtex-beta/) contains the beta application and its deployment configuration.
- [releases/](releases/) contains the Beta 2 and Beta 3 release snapshots.

## Data and maintenance

The local Docker configuration stores the database, uploads, and build cache in `labtex/labtex-data/` on the host. Back up this directory before updating the application. The [server maintenance guide](server_maintenance.md) documents the beta deployment, including backup, update, and rollback procedures.
