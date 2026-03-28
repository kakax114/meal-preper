FROM node:20-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js index.html ./
COPY detail-cache/ ./detail-cache/
EXPOSE 8080
CMD ["node", "server.js"]
