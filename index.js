const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;
const TEMP_DIR = path.join(__dirname, 'temp');
const CLOUDCONVERT_API_KEY = process.env.CLOUDCONVERT_API_KEY;

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

/** CloudConvert API 请求封装 */
function ccRequest(method, path, { body, formData, isBinary } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {
      'Authorization': 'Bearer ' + CLOUDCONVERT_API_KEY,
      'Accept': 'application/json',
    };

    let bodyData = null;

    if (formData) {
      const boundary = '----cc' + Date.now();
      headers['Content-Type'] = `multipart/form-data; boundary=${boundary}`;
      const parts = [];
      for (const [key, value] of Object.entries(formData)) {
        if (value.file) {
          const fileData = fs.readFileSync(value.file);
          parts.push(Buffer.from(
            `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="${key}"; filename="${encodeURIComponent(value.filename)}"\r\n` +
            `Content-Type: application/octet-stream\r\n\r\n`
          ));
          parts.push(fileData);
          parts.push(Buffer.from('\r\n'));
        } else {
          parts.push(Buffer.from(
            `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`
          ));
        }
      }
      parts.push(Buffer.from(`--${boundary}--\r\n`));
      bodyData = Buffer.concat(parts);
      headers['Content-Length'] = bodyData.length;
    } else if (body) {
      bodyData = JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(bodyData);
    }

    const options = {
      hostname: 'api.cloudconvert.com',
      path: '/v2' + path,
      method,
      headers,
      timeout: 180000,
    };

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const data = Buffer.concat(chunks);
        const text = data.toString('utf-8');
        try {
          const json = JSON.parse(text);
          if (res.statusCode >= 400) {
            reject(new Error(json.message || json.error || `HTTP ${res.statusCode}`));
          } else {
            resolve(isBinary ? data : json);
          }
        } catch (e) {
          if (isBinary) {
            resolve(data);
          } else {
            reject(new Error('解析响应失败: ' + text.slice(0, 300)));
          }
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')); });
    if (bodyData) req.write(bodyData);
    req.end();
  });
}

/** 等待 CloudConvert 任务完成 */
function waitForTask(taskId) {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const maxAttempts = 60;

    function poll() {
      attempts++;
      if (attempts > maxAttempts) return reject(new Error('转换超时'));

      ccRequest('GET', '/tasks/' + taskId).then((result) => {
        const task = result.data;
        if (task.status === 'finished') {
          const url = task.result?.files?.[0]?.url || task.result?.url;
          if (url) resolve(url);
          else reject(new Error('转换完成但无下载地址'));
        } else if (task.status === 'error') {
          reject(new Error(task.message || '转换失败'));
        } else {
          setTimeout(poll, 3000);
        }
      }).catch(reject);
    }
    poll();
  });
}

app.post('/api/convert', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ code: -1, message: '未收到文件' });
    if (!CLOUDCONVERT_API_KEY) {
      return res.status(500).json({ code: -1, message: '服务器未配置 CLOUDCONVERT_API_KEY' });
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

    // Step 1: 创建 upload 任务
    const uploadTask = await ccRequest('POST', '/upload', {
      body: { filename: fileName },
    });
    const uploadUrl = uploadTask.data.result.url;
    const uploadForm = uploadTask.data.result.form || {};

    // Step 2: 上传文件到 CloudConvert
    await new Promise((resolve, reject) => {
      const fileData = fs.readFileSync(inputPath);
      const boundary = '----upload' + Date.now();
      const parts = [];

      for (const [key, value] of Object.entries(uploadForm)) {
        parts.push(Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`
        ));
      }
      parts.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${encodeURIComponent(fileName)}"\r\nContent-Type: application/octet-stream\r\n\r\n`
      ));
      parts.push(fileData);
      parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
      const body = Buffer.concat(parts);

      const parsedUrl = new URL(uploadUrl);
      const uploadReq = https.request({
        hostname: parsedUrl.hostname,
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length,
        },
        timeout: 120000,
      }, (uploadRes) => {
        uploadRes.on('data', () => {});
        uploadRes.on('end', () => resolve());
      });
      uploadReq.on('error', reject);
      uploadReq.on('timeout', () => { uploadReq.destroy(); reject(new Error('上传超时')); });
      uploadReq.write(body);
      uploadReq.end();
    });
    console.log('[Convert] file uploaded');

    // Step 3: 创建转换任务
    const convertTask = await ccRequest('POST', '/convert', {
      body: {
        name: resultFileName,
        input: uploadTask.data.id,
        output_format: targetFormat,
      },
    });
    const convertTaskId = convertTask.data.id;
    console.log(`[Convert] convert task: ${convertTaskId}`);

    // Step 4: 等待转换完成
    const downloadUrl = await waitForTask(convertTaskId);
    console.log('[Convert] convert done, downloading...');

    // Step 5: 下载文件
    const fileBuffer = await ccRequest('GET', downloadUrl.replace('https://api.cloudconvert.com', ''), { isBinary: true });
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
      if (now - stats.mtimeMs > 3600000) fs.unlinkSync(filePath);
    });
  } catch (e) {}
}, 1800000);

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'convert-server', apiKeyConfigured: !!CLOUDCONVERT_API_KEY });
});

app.listen(PORT, () => {
  console.log(`Convert server running on port ${PORT}`);
  if (!CLOUDCONVERT_API_KEY) console.warn('WARNING: CLOUDCONVERT_API_KEY not set!');
});