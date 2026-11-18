# LabTeX beta: deployment and maintenance

This guide describes the deployment we set up on November 17, 2026. Commands are labeled by the machine where you must run them. Paths and settings describe that deployment; check them if you later move it.

## 1. What runs where

| Machine | Purpose |
|---|---|
| Your local computer, `pwrgra01-ubuntu` | Edit LabTeX source and build Docker images. |
| Unraid host, `Tower` | Runs the lab's virtual machines and stores their virtual disks. |
| Ubuntu VM, `psuegotderms` | Runs Docker, LabTeX, and Nginx. Log in as `sonali`. |

The browser address is:

**http://psuegotderms.ece.pdx.edu:8080**

The request travels through Nginx on port 8080 to LabTeX on `127.0.0.1:3000` inside DERMS. Docker port 3000 is not directly exposed to the network.

Registration currently accepts any email address and password without an invitation code. Email ownership is not verified. Whoever can reach the website can register; we did not configure a PSU-only source-address restriction. Campus network firewalls can still limit reachability. HTTP does not encrypt passwords or documents, so ask testers to use unique passwords.

## 2. Where users' projects are stored

Inside the **DERMS Ubuntu VM**, the persistent directory is:

```text
/home/sonali/pwrlab-latex/labtex-beta/labtex-data/
```

Docker mounts this directory as `/data` inside the LabTeX container. Its main database is:

```text
/home/sonali/pwrlab-latex/labtex-beta/labtex-data/labtex.db
```

Projects are database records, not individual folders in your source-code directory. The SQLite database holds accounts, password hashes, sessions, project membership, source files, uploaded binary files, collaboration state, and version-history records. SQLite may also create `labtex.db-wal` and `labtex.db-shm`. Do not delete those files or copy only the main database while the app is running.

Compiled PDFs and intermediate TeX files are generated in `/var/lib/labtex-builds` inside the container. In this deployment they are temporary and can disappear when the container is recreated. Users' source files remain in the database and can be compiled again.

On the **Unraid host**, DERMS's entire virtual disk is:

```text
/mnt/user/domains/psuegotderms/vdisk1.img
```

The Ubuntu filesystem, Docker images, and LabTeX database all live inside that disk. The `/home/sonali/...` path is a path inside Ubuntu, not a directly accessible Unraid share. The virtual disk was reported as 5 TB logically with about 74 GB allocated; the Ubuntu root filesystem was about 98 GB. Those sizes measure different layers and can change.

**The directory to protect during normal LabTeX updates is `labtex-beta/labtex-data`, not the older `labtex/labtex-data` directory.**

## 3. Current deployment files and limits

On DERMS:

```text
/home/sonali/pwrlab-latex/labtex-beta/docker-compose.yml
/etc/nginx/conf.d/labtex-beta.conf
```

The Compose service is named `labtex`. The initial image is `labtex-beta:beta-1`. Compose uses `pull_policy: never` and has no build step. The app is limited to 2 CPUs, 2 GB RAM, and one concurrent compilation. DERMS itself is capped at 4 GB RAM and has 4 GB guest swap.

The environment settings include:

```yaml
ALLOW_REGISTRATION: "true"
REGISTRATION_CODE: ""
SECURE_COOKIES: "false"
TRUST_PROXY: "true"
MAX_CONCURRENT_COMPILES: "1"
```

Keep `SECURE_COOKIES` false while using HTTP. If HTTPS is added later, review that setting. The first registered user becomes administrator; an image rebuild does not reset that account.

## 4. Back up before each update

Schedule a short maintenance window and ask users to stop editing. Stop the app cleanly before copying its database. This lets it flush pending collaborative edits and close SQLite.

Run **inside DERMS**:

```bash
cd /home/sonali/pwrlab-latex/labtex-beta || exit
mkdir -p ../labtex-backups
backup_file="../labtex-backups/labtex-$(date +%Y%m%d-%H%M%S).tgz"
sudo docker compose stop labtex
sudo tar -czf "$backup_file" labtex-data docker-compose.yml
```

If `tar` reports an error, stop and investigate before updating. After a successful backup:

```bash
sudo tar -tzf "$backup_file" | head
sudo docker compose start labtex
echo "$backup_file"
```

Also save the proxy configuration, especially before changing it:

```bash
sudo cp -a /etc/nginx/conf.d/labtex-beta.conf ../labtex-backups/
```

Copy backups off DERMS regularly. A backup inside the same VM does not protect against loss of its virtual disk. From your **local computer**, for example:

```bash
mkdir -p ~/labtex-server-backups
scp sonali@psuegotderms.ece.pdx.edu:/home/sonali/pwrlab-latex/labtex-backups/labtex-YYYYMMDD-HHMMSS.tgz ~/labtex-server-backups/
```

Replace the example filename with the actual backup name. Backups contain private projects and account information; store them privately. Listing an archive checks that it can be read, but a restore test in a separate instance is the stronger check.

## 5. Update application functionality without losing projects

The Docker image contains application code and TeX tools. The mounted data directory contains users' work. **Replace the image while keeping the same data mount.** Do not replace the deployment directory with a fresh local copy.

### A. Build on your local computer

Edit the source under `~/pwrlab-latex/labtex`. Use a new tag for every release. This example uses `beta-2`; use `beta-3`, etc. for later releases.

```bash
cd ~/pwrlab-latex/labtex || exit
sudo docker build --platform linux/amd64 -t labtex-beta:beta-2 .
```

The final dot is required. Only proceed if the build succeeds. Keep `labtex-data` excluded in `.dockerignore`; databases must not be baked into images.

Test the new version with separate test data before deploying it. Never connect two application instances to the production data directory.

Export and transfer:

```bash
sudo docker save labtex-beta:beta-2 | gzip > /tmp/labtex-beta-2.tar.gz
gzip -t /tmp/labtex-beta-2.tar.gz
scp /tmp/labtex-beta-2.tar.gz sonali@psuegotderms.ece.pdx.edu:~/
```

### B. Load the image inside DERMS

```bash
sudo docker load -i ~/labtex-beta-2.tar.gz
sudo docker image ls labtex-beta
```

Loading can take several minutes. It does not update the running application yet.

### C. Back up, then switch versions

Make the stopped-app backup from section 4 immediately before switching versions. Then, inside DERMS:

```bash
cd /home/sonali/pwrlab-latex/labtex-beta || exit
cp -a docker-compose.yml docker-compose.yml.before-beta-2
nano docker-compose.yml
```

Change only the image tag:

```yaml
image: labtex-beta:beta-2
```

Keep this mount unchanged:

```yaml
volumes:
  - ./labtex-data:/data
```

Validate and launch:

```bash
sudo docker compose config --quiet && sudo docker compose up -d --no-build
sudo docker compose ps
sudo docker compose logs --tail=60
curl -fsS http://127.0.0.1:8080/api/config
```

Check the website, sign in to an existing account, open an existing project, and compile it. Confirm the container becomes healthy. Nginx normally needs no change for application-only updates.

**Do not run a Docker build on DERMS.** Earlier builds and image loading triggered host out-of-memory kills when DERMS was allowed nearly all host RAM. Its RAM is now capped, but the other VMs still have oversized allocations. Build locally and monitor host resources.

### D. Database changes need special care

Preserving the directory prevents accidental deletion, but does not make every code update compatible with existing data. If you change tables or stored formats, implement and test database migrations against a disposable copy of a backup. Never overwrite the server database with your local development database.

Keep the previous image and pre-update backup until the new release is verified. A newer version may migrate the database in a way the older version cannot read.

## 6. If an update fails

For an application-only change with no incompatible database migration, restore the previous image tag in Compose, then run:

```bash
sudo docker compose up -d --no-build
```

If the database was changed incompatibly, restoring the old image alone is insufficient. Restore its matching pre-update data backup too. Restoring a backup loses edits made after that backup, so coordinate with users.

Example restore, **inside DERMS**, after choosing the correct archive:

```bash
cd /home/sonali/pwrlab-latex/labtex-beta || exit
sudo docker compose stop labtex
sudo mv labtex-data "labtex-data.before-restore-$(date +%Y%m%d-%H%M%S)"
sudo tar -xzf ../labtex-backups/labtex-YYYYMMDD-HHMMSS.tgz
```

Replace the archive filename first. If extraction fails, do not start the app with a missing or incomplete database. The archive restores both data and the Compose file from that backup. Check its image tag and ensure that image is loaded, then:

```bash
sudo docker compose config --quiet && sudo docker compose up -d --no-build
```

The renamed data directory preserves the failed version's data for investigation. Do not delete it until recovery is confirmed.

## 7. Routine commands

Run these **inside DERMS** from `/home/sonali/pwrlab-latex/labtex-beta`:

```bash
sudo docker compose ps                 # Running state and health
sudo docker compose logs --tail=100    # Recent application messages
sudo docker stats --no-stream          # Container memory and CPU usage
sudo docker compose restart labtex    # Restart application, retain data
sudo docker compose stop labtex       # Stop application
sudo docker compose start labtex      # Start existing container
df -h /                               # Ubuntu disk capacity
free -h                               # Ubuntu memory availability
```

`restart` does not apply changed environment settings or switch images. After Compose changes, use `up -d --no-build` instead.

For proxy checks:

```bash
sudo nginx -t
sudo tail -n 60 /var/log/nginx/error.log
curl -fsS http://127.0.0.1:3000/api/config
curl -fsS http://127.0.0.1:8080/api/config
```

If port 3000 works but 8080 fails, investigate Nginx. If both work locally but a tester cannot connect, investigate DNS, routing, or campus firewall access. After editing Nginx, apply changes with `sudo nginx -t && sudo systemctl reload nginx`.

## 8. Important lessons from recovery

- The Unraid host has roughly 16 GB RAM. At deployment time, its running VMs were configured for a combined 48.5 GiB. Guest-reported free memory is not the host's available memory.
- Unraid killed the DERMS QEMU process during host memory exhaustion. A VM abruptly disappearing can be a host issue, not an SSH issue.
- DERMS's PCI bridge for the disk needed function zero at slot `0x02`, with `multifunction='on'`. Changing VM form settings had left the disk invisible to the guest. Save a known-working VM XML after recovery.
- The Ubuntu installer ISO is still attached as a second boot option. A language-selection or "Configure proxy" screen is the installer, not the installed system. Do not proceed through installation or disk formatting to fix a login problem.
- VNC authentication and Ubuntu login use separate passwords. The temporary VNC password used during recovery was disclosed in this conversation; replace it in the saved VM configuration during planned maintenance. Runtime monitor changes may not survive a restart.
- Verify changed SSH host keys through VNC before accepting them. RAM changes alone do not change an installed system's SSH keys.
- `/etc/ssl` previously lacked directory execute permissions and prevented VS Code Server from reading OpenSSL configuration. Its access was repaired; avoid recursive permission changes to system directories.

To save the VM configuration, run **on Unraid (`root@Tower`)**:

```bash
virsh dumpxml psuegotderms --inactive > /boot/config/psuegotderms-working.xml
```

Keep another copy off the host. This XML saves configuration only, not the virtual disk or LabTeX data. Never copy a writable VM disk while the VM is actively changing it and assume the result is a reliable backup.

## 9. Before inviting more testers

Keep off-server backups, test a restore, monitor RAM and free disk space, and retain one concurrent compilation until usage is understood. Avoid publishing sensitive documents over this HTTP beta. For broader use, add HTTPS, review registration and abuse controls, and plan maintenance of Ubuntu 20.04 and the lab host's RAM allocations.

The simplest update rule is: **build locally, back up server data, load a new image, change its tag, recreate the container, and verify existing projects. Keep the same data directory throughout.**
