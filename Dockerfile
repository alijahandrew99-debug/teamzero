# TeamZero Cloud — zero-dependency Node app. Deploys anywhere that runs Node 18+.
FROM node:20-alpine
WORKDIR /app
COPY . .
# No `npm install` needed — the app has zero dependencies.
ENV PORT=8090
EXPOSE 8090
CMD ["node", "server.js"]
