const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;
const TEMP_DIR = path.join(__dirname, 'temp');
const CONVERT_FAST_API_KEY = process.env.CONVERT_FAST_API_KEY;

app.set('trust proxy', true);

if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR);

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
const upload = multer({ storage, limits: { fileSize: 20 * 1024 * 1024 } });

/** 提交转换任务到 Convert.Fast */
function submitConvertFastJob(inputPath, sourceFormat, targetFormat, fileName) {
  return new Promise((resolve, reject) => {
    const boundary = '----' + Date.now() + Math.random().toString(36).slice(2);
    const fileData = fs.readFileSync(inputPath);
    const header = Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${encodeURIComponent(fileName)}"\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n`
    );
    const fields = Buffer.from(
      `\r\n--${boundary}\r\n` +
      `Content-Disposition: form-data; name="targetFormat"\r\n\r\n${targetFormat}` +
      `\r\n--${boundary}--\r\n`
    );
    const body = Buffer.concat([header, fileData, fields]);

    const options = {
      hostname: 'api.tools.fast',
      path: '/convert',
      method: 'POST',
      headers: {
        'X-Fast-Api-Key': CONVERT_FAST_API_KEY,
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
          if (result.id) {
            resolve(result.id);
          } else {
            const msg = result.detail || result.error || data.slice(0, 300);
            reject(new Error(msg));
          }
        } catch (e) {
          reject(new Error('解析 Convert.Fast 响应失败: ' + data.slice(0, 300)));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('提交转换任务超时')); });
    req.write(body);
    req.end();
  });
}

/** 轮询任务状态 */
function pollJobStatus(jobId) {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const maxAttempts = 60;

    function poll() {
      attempts++;
      if (attempts > maxAttempts) return reject(new Error('转换超时，请重试'));

      const options = {
        hostname: 'api.tools.fast',
        path: `/jobs/${encodeURIComponent(jobId)}`,
        method: 'GET',
        headers: { 'X-Fast-Api-Key': CONVERT_FAST_API_KEY },
        timeout: 30000,
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            const result = JSON.parse(data);
            if (result.status === 'Succeeded' || result.status === 'Completed') {
              const downloadUrl = result.outputUrl || result.result?.url || result.files?.[0]?.url;
              if (downloadUrl) {
                resolve(downloadUrl);
              } else {
                reject(new Error('转换成功但未返回下载地址'));
              }
            } else if (result.status === 'Failed' || result.status === 'Error') {
              reject(new Error(result.error || result.detail || '转换失败'));
            } else {
              setTimeout(poll, 3000);
            }
          } catch (e) {
            reject(e);
          }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('轮询超时')); });
      req.end();
    }
    poll();
  });
}

/** 从 URL 下载文件 */
function downloadFromUrl(url) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    https.get({
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      headers: { 'X-Fast-Api-Key': CONVERT_FAST_API_KEY },
      timeout: 120000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

app.post('/api/convert', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ code: -1, message: '未收到文件' });
    if (!CONVERT_FAST_API_KEY) {
      return res.status(500).json({ code: -1, message: '服务器未配置 CONVERT_FAST_API_KEY' });
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

    // Step 1: 提交任务
    const jobId = await submitConvertFastJob(inputPath, sourceFormat, targetFormat, fileName);
    console.log(`[Convert] job: ${jobId}`);

    // Step 2: 轮询结果
    const downloadUrl = await pollJobStatus(jobId);
    console.log('[Convert] job done, downloading...');

    // Step 3: 下载文件
    const fileBuffer = await downloadFromUrl(downloadUrl);
    fs.writeFileSync(finalPath, fileBuffer);
    fs.unlinkSync(inputPath);

    const resultUrl = getBaseUrl(req) + '/files/' + taskId + '_' + encodeURIComponent(resultFileName);
    console.log(`[Convert] success: ${resultFileName} (${fileBuffer.length} bytes)`);

    res.json({ code: 0, message: 'success', data: { resultUrl, resultFileName } });
  } catch (err) {
    console.error('[Convert] error:', err.message);
    if (req.file) { try { fs.unlinkSync(req.file.path); } catch(e) {} }
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
  res.json({
    status: 'ok',
    service: 'convert-server',
    apiKeyConfigured: !!CONVERT_FAST_API_KEY,
  });
});

app.listen(PORT, () => {
  console.log(`Convert server running on port ${PORT}`);
  if (!CONVERT_FAST_API_KEY) console.warn('WARNING: CONVERT_FAST_API_KEY not set!');
});