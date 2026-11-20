- On your local computer, put the updated source in your chosen source folder, then build:

```
cd /path/to/updated/labtex
sudo docker build --platform linux/amd64 -t labtex-beta:beta-# .
```

Change the beta-# to the latest version + 1. Then test the feature with separate test data. If you changed the database schema, test migrations against a copy of a production backup before deploying.

- Locally, export and transfer the image:
```
sudo docker save labtex-beta:beta-# | gzip > /tmp/labtex-beta-#.tar.gz
gzip -t /tmp/labtex-beta-#.tar.gz &&
scp /tmp/labtex-beta-#.tar.gz sonali@psuegotderms.ece.pdx.edu:~/
```

- Inside DERMS, from any folder, load it:
```
sudo docker load -i ~/labtex-beta-#.tar.gz
sudo docker image ls labtex-beta
```

- Inside DERMS, ask users to pause editing, then stop and back up the app:

```
cd /home/sonali/pwrlab-latex/labtex-beta || exit
mkdir -p ../labtex-backups
backup_file="../labtex-backups/before-beta-#-$(date +%Y%m%d-%H%M%S).tgz"

sudo docker compose stop labtex &&
sudo tar -czf "$backup_file" labtex-data docker-compose.yml &&
sudo tar -tzf "$backup_file" >/dev/null &&
echo "Backup verified: $backup_file"
```
**Continue only after “Backup verified” appears.**

- Save the existing configuration and edit its image tag:
```
cp -a docker-compose.yml docker-compose.yml.before-beta-#
nano docker-compose.yml
```

> Set: image: labtex-beta:beta-#

Keep ./labtex-data:/data and the other production settings unchanged.

- Start and check the new version:
```
sudo docker compose config --quiet &&
sudo docker compose up -d --no-build

sudo docker compose ps
sudo docker compose logs --tail=60
curl -fsS http://127.0.0.1:8080/api/config
```
