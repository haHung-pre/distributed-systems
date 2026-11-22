# Single image, the role is chosen by the command (see docker-compose.yml).
FROM node:20-alpine
WORKDIR /app
RUN apk add --no-cache curl tini
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY src ./src
COPY scripts ./scripts
COPY tests ./tests
RUN addgroup -S coedit && adduser -S coedit -G coedit \
 && mkdir -p /app/data && chown -R coedit:coedit /app
USER coedit
ENV NODE_ENV=production LOG_FORMAT=json COEDIT_DATA_DIR=/app/data
ENTRYPOINT ["/sbin/tini","--"]
CMD ["node","src/collab/server.js"]
