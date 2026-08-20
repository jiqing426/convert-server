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

/** CloudConvert API 请求 */
function ccRequest(method, apiPath, { body, isBinary } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {
      'Authorization': 'Bearer ' + CLOUDCONVERT_API_KEY,
      'Accept': 'application/json',
    };

    let bodyData = null;
    if (body) {
      bodyData = JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(bodyData);
    }

    const options = {
      hostname: 'api.cloudconvert.com',
      path: '/v2' + apiPath,
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
            console.error('[CC] error response:', text.slice(0, 500));
            reject(new Error(json.message || json.error || `HTTP ${res.statusCode}`));
          } else {
            resolve(isBinary ? data : json);
          }
        } catch (e) {
          if (isBinary) resolve(data);
          else reject(new Error('解析响应失败: ' + text.slice(0, 300)));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')); });
    if (bodyData) req.write(bodyData);
    req.end();
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

    // Step 1: 创建 Job（import/upload → convert → export/url）
    const job = await ccRequest('POST', '/jobs', {
      body: {
        tasks: [
          { name: 'import', operation: 'import/upload' },
          {
            name: 'convert',
            operation: 'convert',
            input: 'import',
            output_format: targetFormat,
          },
          { name: 'export', operation: 'export/url', input: 'convert' },
        ],
      },
    });

    const jobId = job.data.id;
    console.log(`[Convert] job created: ${jobId}`);

    // Step 2: 获取上传地址
    const importTask = job.data.tasks.find((t) => t.name === 'import');
    if (!importTask || !importTask.result || !importTask.result.url) {
      throw new Error('无法获取上传地址');
    }
    const uploadUrl = importTask.result.url;
    const uploadForm = importTask.result.form || {};
    console.log('[Convert] upload URL obtained');

    // Step 3: 上传文件到 CloudConvert S3
    await new Promise((resolve, reject) => {
      const fileData = fs.readFileSync(inputPath);
      const boundary = '----ccupload' + Date.now();
      const parts = [];

      // 添加 form 字段
      for (const [key, value] of Object.entries(uploadForm)) {
        parts.push(Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`
        ));
      }
      // 添加文件
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
        uploadRes.on('end', () => {
          console.log('[Convert] upload status:', uploadRes.statusCode);
          if (uploadRes.statusCode >= 200 && uploadRes.statusCode < 300) {
            resolve();
          } else {
            let errBody = '';
            uploadRes.on('data', (c) => errBody += c);
            uploadRes.on('end', () => {
              reject(new Error('上传失败: HTTP ' + uploadRes.statusCode + ' ' + errBody.slice(0, 200)));
            });
          }
        });
      });
      uploadReq.on('error', reject);
      uploadReq.on('timeout', () => { uploadReq.destroy(); reject(new Error('上传超时')); });
      uploadReq.write(body);
      uploadReq.end();
    });
    console.log('[Convert] file uploaded');

    // Step 4: 轮询 Job 状态
    let downloadUrl = null;
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      const jobStatus = await ccRequest('GET', '/jobs/' + jobId);
      const tasks = jobStatus.data.tasks || [];

      // 检查是否有错误
      const errorTask = tasks.find((t) => t.status === 'error');
      if (errorTask) {
        throw new Error(errorTask.message || '转换任务失败');
      }

      // 检查是否全部完成
      const exportTask = tasks.find((t) => t.name === 'export');
      if (exportTask && exportTask.status === 'finished') {
        downloadUrl = exportTask.result?.files?.[0]?.url;
        if (downloadUrl) break;
      }

      // 检查 job 状态
      if (jobStatus.data.status === 'finished') {
        downloadUrl = exportTask?.result?.files?.[0]?.url;
        if (downloadUrl) break;
        throw new Error('任务完成但无下载地址');
      }
    }

    if (!downloadUrl) {
      throw new Error('转换超时，请重试');
    }
    console.log('[Convert] job finished, downloading...');

    // Step 5: 下载转换后的文件
    const fileBuffer = await new Promise((resolve, reject) => {
      const parsedUrl = new URL(downloadUrl);
      https.get({
        hostname: parsedUrl.hostname,
        path: parsedUrl.pathname + parsedUrl.search,
        timeout: 120000,
      }, (dlRes) => {
        const chunks = [];
        dlRes.on('data', (c) => chunks.push(c));
        dlRes.on('end', () => resolve(Buffer.concat(chunks)));
      }).on('error', reject);
    });

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