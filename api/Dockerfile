FROM node:24.14.0-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY migrations ./migrations
RUN npm run build
ENV NODE_ENV=production
USER node
EXPOSE 3000
CMD ["node", "dist/index.js"]
