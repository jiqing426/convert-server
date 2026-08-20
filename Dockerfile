FROM node:18-slim

# 安装 LibreOffice + Java + 中文字体
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    libreoffice \
    libreoffice-writer \
    openjdk-17-jre-headless \
    fonts-dejavu \
    fonts-noto-cjk \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# LibreOffice 需要 HOME 目录存放用户配置
ENV HOME=/tmp
ENV LANG=C.UTF-8

WORKDIR /app
COPY package.json ./
RUN npm install --production
COPY . .

EXPOSE 3000
CMD ["node", "index.js"]
