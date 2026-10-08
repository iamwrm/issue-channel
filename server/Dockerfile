FROM node:24-slim
WORKDIR /app
COPY server.mjs ./
ENV NODE_ENV=production DB_PATH=/data/events.db PORT=8787 HOST=0.0.0.0
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:8787/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "server.mjs"]
