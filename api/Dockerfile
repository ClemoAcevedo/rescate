FROM node:24.14.0-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY migrations ./migrations
RUN npm run build
# Volumen de fotos de Compose: un volumen nuevo hereda este dueño.
RUN mkdir -p /app/photo-storage && chown node:node /app/photo-storage
USER node
EXPOSE 3000
CMD ["node", "dist/index.js"]
