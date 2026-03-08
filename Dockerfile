FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY src ./src

ARG BUILD_SHA=dev
ENV BUILD_SHA=${BUILD_SHA}
ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "src/index.js"]
