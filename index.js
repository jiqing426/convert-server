const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;
const TEMP_DIR = path.join(__dirname, 'temp');

// ConvertAPI 密钥（在 Render 环境变量中设置）
const CONVERTAPI_SECRET = process.env.CONVERTAPI_SECRET;

app.set('trust proxy', true);

if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR);
}

app.use(cors());
app.use('/files', express.static(TEMP_DIR));

function getBaseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.get('host');
  return proto + '://' + host;
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, TEMP_DIR),
  filename: (req, file, cb) => {
    const taskId = Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const ext = path.extname(file.originalname) || '.bin';
    cb(null, taskId + ext);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
});

/** 调用 ConvertAPI 执行转换 */
function convertViaConvertAPI(inputPath, sourceFormat, targetFormat) {
  return new Promise((resolve, reject) => {
    const boundary = '----' + Date.now();
    const fileName = path.basename(inputPath);
    const fileData = fs.readFileSync(inputPath);

    // 构建 multipart/form-data 请求体
    const header = Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n`
    );
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([header, fileData, footer]);

    const options = {
      hostname: 'v2.convertapi.com',
      path: `/convert/${sourceFormat}/to/${targetFormat}?Secret=${CONVERTAPI_SECRET}`,
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
      },
      timeout: 120000,
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          if (result.Files && result.Files.length > 0) {
            const file = result.Files[0];
            if (file.FileData) {
              resolve({
                buffer: Buffer.from(file.FileData, 'base64'),
                fileName: file.FileName,
              });
            } else if (file.Url) {
              https.get(file.Url, (dlRes) => {
                const chunks = [];
                dlRes.on('data', (c) => chunks.push(c));
                dlRes.on('end', () => {
                  resolve({
                    buffer: Buffer.concat(chunks),
                    fileName: file.FileName,
                  });
                });
              }).on('error', reject);
            } else {
              reject(new Error('ConvertAPI 返回格式异常'));
            }
          } else {
            const msg = result.Message || result.Error || '转换失败';
            reject(new Error(msg));
          }
        } catch (e) {
          reject(new Error('解析 ConvertAPI 响应失败'));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('ConvertAPI 请求超时')); });
    req.write(body);
    req.end();
  });
}

app.post('/api/convert', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ code: -1, message: '未收到文件' });
    }

    if (!CONVERTAPI_SECRET) {
      return res.status(500).json({
        code: -1,
        message: '服务器未配置 ConvertAPI 密钥，请在 Render 环境变量中设置 CONVERTAPI_SECRET',
      });
    }

    const { sourceFormat, targetFormat, fileName } = req.body;
    if (!sourceFormat || !targetFormat) {
      return res.status(400).json({ code: -1, message: '缺少格式参数' });
    }

    const inputPath = req.file.path;
    const baseName = (fileName || 'document').replace(/\.[^.]+$/, '');
    const resultFileName = baseName + '_converted.' + targetFormat;
    const taskId = Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const finalPath = path.join(TEMP_DIR, taskId + '_' + resultFileName);

    console.log(`[Convert] ${fileName} (${sourceFormat} → ${targetFormat})`);

    // 调用 ConvertAPI
    const result = await convertViaConvertAPI(inputPath, sourceFormat, targetFormat);

    // 保存转换后的文件
    fs.writeFileSync(finalPath, result.buffer);
    fs.unlinkSync(inputPath);

    const resultUrl = getBaseUrl(req) + '/files/' + taskId + '_' + encodeURIComponent(resultFileName);
    const fileSize = fs.statSync(finalPath).size;
    console.log(`[Convert] success: ${resultFileName} (${fileSize} bytes)`);

    res.json({
      code: 0,
      message: 'success',
      data: { resultUrl, resultFileName },
    });
  } catch (err) {
    console.error('[Convert] error:', err.message);
    if (req.file) {
      try { fs.unlinkSync(req.file.path); } catch(e) {}
    }
    res.status(500).json({ code: -1, message: '转换失败：' + (err.message || '') });
  }
});

// 定时清理
setInterval(() => {
  try {
    const files = fs.readdirSync(TEMP_DIR);
    const now = Date.now();
    files.forEach((file) => {
      const filePath = path.join(TEMP_DIR, file);
      const stats = fs.statSync(filePath);
      if (now - stats.mtimeMs > 3600000) {
        fs.unlinkSync(filePath);
        console.log('[Clean] deleted:', file);
      }
    });
  } catch (e) {}
}, 1800000);

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'convert-server' });
});

app.listen(PORT, () => {
  console.log(`Convert server running on port ${PORT}`);
  if (!CONVERTAPI_SECRET) {
    console.warn('WARNING: CONVERTAPI_SECRET not set!');
  }
});