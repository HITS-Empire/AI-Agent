# Headless Chromium для чтения публичных страниц (поиск маркетплейсов). Только рендер страницы:
# без входа в аккаунты, без stealth-плагинов и подмены отпечатка, свежий контекст на каждый запрос.
FROM mcr.microsoft.com/playwright:v1.65.1-noble

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY server.mjs ./

USER pwuser
ENV NODE_ENV=production PORT=3100
EXPOSE 3100
CMD ["node", "server.mjs"]
