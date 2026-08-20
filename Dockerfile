FROM node:18-slim

# 安装 LibreOffice + Java + 中文字体 + poppler-utils(支持PDF转TXT)
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    libreoffice \
    libreoffice-writer \
    openjdk-17-jre-headless \
    fonts-dejavu \
    fonts-noto-cjk \
    poppler-utils \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

ENV HOME=/tmp
ENV LANG=C.UTF-8

WORKDIR /app
COPY package.json ./
RUN npm install --production
COPY . .

EXPOSE 3000
CMD ["node", "index.js"]
