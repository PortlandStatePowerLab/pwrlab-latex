# Full TeX Live by default. Override with --build-arg TEXLIVE_IMAGE=... if needed.
ARG TEXLIVE_IMAGE=texlive/texlive:latest

# ---------- Build stage: install deps and bundle the frontend ----------
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY client ./client
COPY public ./public
COPY server ./server
RUN npm run build && npm prune --omit=dev && rm -f public/app.js.map

# ---------- Runtime: full TeX Live + Node ----------
# texlive/texlive:latest is the complete TeX Live distribution (~5 GB), so every
# package your lab might use is available, along with latexmk, biber and synctex.
FROM ${TEXLIVE_IMAGE}
RUN apt-get update \
 && apt-get install -y --no-install-recommends libstdc++6 ca-certificates sudo util-linux python3 \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /usr/local/bin/node /usr/local/bin/node

# Two accounts: "labtex" runs the web server and owns the data; "texrunner" runs TeX.
# TeX can therefore never read the database, even via LuaTeX's io.open.
RUN useradd --create-home --uid 10001 labtex \
 && useradd --create-home --uid 10002 texrunner \
 && echo 'labtex ALL=(texrunner) NOPASSWD: /usr/bin/env' > /etc/sudoers.d/labtex \
 && chmod 440 /etc/sudoers.d/labtex \
 && mkdir -p /data /var/lib/labtex-builds

WORKDIR /app
COPY --from=build /app /app
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 755 /usr/local/bin/docker-entrypoint.sh

ENV NODE_ENV=production PORT=3000 DATA_DIR=/data BUILD_DIR=/var/lib/labtex-builds COMPILE_USER=texrunner
EXPOSE 3000
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "fetch('http://localhost:3000/api/config').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "server/index.js"]
