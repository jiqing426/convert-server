FROM node:18-slim

# 安装 LibreOffice
RUN apt-get update && \
    apt-get install -y --no-install-recommends libreoffice libreoffice-writer && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY . .

EXPOSE 3000

CMD ["node", "index.js"]
