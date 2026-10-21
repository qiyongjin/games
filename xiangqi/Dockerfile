FROM node:22-alpine
WORKDIR /app
COPY package.json index.html styles.css admin.html admin.css ./
COPY src ./src
COPY scripts ./scripts
COPY deploy ./deploy
RUN npm run build && mkdir -p /data && chown node:node /data
ENV NODE_ENV=production HOST=0.0.0.0 PORT=5173 DATA_DIR=/data
USER node
EXPOSE 5173
CMD ["node", "dist/scripts/serve.mjs"]
