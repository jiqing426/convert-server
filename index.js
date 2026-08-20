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
const CONVERTAPI_SECRET = process.env.CONVERTAPI_SECRET;

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

// ============================================
// CloudConvert API（优先，10次/天免费）
// ============================================
function ccRequest(method, apiPath, { body } = {}) {
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
      method, headers, timeout: 180000,
    };
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8');
        try {
          const json = JSON.parse(text);
          if (res.statusCode >= 400) {
            const err = new Error(json.message || json.error || `HTTP ${res.statusCode}`);
            err.statusCode = res.statusCode;
            reject(err);
          } else resolve(json);
        } catch (e) {
          reject(new Error('解析响应失败: ' + text.slice(0, 300)));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')); });
    if (bodyData) req.write(bodyData);
    req.end();
  });
}

async function convertViaCloudConvert(inputPath, sourceFormat, targetFormat, fileName) {
  // Step 1: 创建 Job
  const job = await ccRequest('POST', '/jobs', {
    body: {
      tasks: [
        { name: 'import', operation: 'import/upload' },
        { name: 'convert', operation: 'convert', input: 'import', output_format: targetFormat },
        { name: 'export', operation: 'export/url', input: 'convert' },
      ],
    },
  });
  const jobId = job.data.id;
  const importTask = job.data.tasks.find((t) => t.name === 'import');
  const uploadUrl = importTask.result.url;
  const uploadForm = importTask.result.form || {};

  // Step 2: 上传文件
  await new Promise((resolve, reject) => {
    const fileData = fs.readFileSync(inputPath);
    const boundary = '----ccupload' + Date.now();
    const parts = [];
    for (const [key, value] of Object.entries(uploadForm)) {
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`));
    }
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${encodeURIComponent(fileName)}"\r\nContent-Type: application/octet-stream\r\n\r\n`));
    parts.push(fileData);
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
    const body = Buffer.concat(parts);
    const parsedUrl = new URL(uploadUrl);
    const uploadReq = https.request({
      hostname: parsedUrl.hostname, path: parsedUrl.pathname + parsedUrl.search,
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length },
      timeout: 120000,
    }, (uploadRes) => {
      if (uploadRes.statusCode >= 200 && uploadRes.statusCode < 300) resolve();
      else { uploadRes.on('data', () => {}); uploadRes.on('end', () => reject(new Error('上传失败: HTTP ' + uploadRes.statusCode))); }
    });
    uploadReq.on('error', reject);
    uploadReq.on('timeout', () => { uploadReq.destroy(); reject(new Error('上传超时')); });
    uploadReq.write(body);
    uploadReq.end();
  });

  // Step 3: 轮询
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const jobStatus = await ccRequest('GET', '/jobs/' + jobId);
    const tasks = jobStatus.data.tasks || [];
    const errorTask = tasks.find((t) => t.status === 'error');
    if (errorTask) throw new Error(errorTask.message || '转换失败');
    const exportTask = tasks.find((t) => t.name === 'export');
    if (exportTask && exportTask.status === 'finished') {
      const url = exportTask.result?.files?.[0]?.url;
      if (url) {
        // Step 4: 下载
        const fileBuffer = await new Promise((resolve, reject) => {
          const parsedUrl = new URL(url);
          https.get({ hostname: parsedUrl.hostname, path: parsedUrl.pathname + parsedUrl.search, timeout: 120000 }, (dlRes) => {
            const chunks = [];
            dlRes.on('data', (c) => chunks.push(c));
            dlRes.on('end', () => resolve(Buffer.concat(chunks)));
          }).on('error', reject);
        });
        return fileBuffer;
      }
    }
    if (jobStatus.data.status === 'finished') {
      const url = exportTask?.result?.files?.[0]?.url;
      if (url) {
        const fileBuffer = await new Promise((resolve, reject) => {
          const parsedUrl = new URL(url);
          https.get({ hostname: parsedUrl.hostname, path: parsedUrl.pathname + parsedUrl.search, timeout: 120000 }, (dlRes) => {
            const chunks = [];
            dlRes.on('data', (c) => chunks.push(c));
            dlRes.on('end', () => resolve(Buffer.concat(chunks)));
          }).on('error', reject);
        });
        return fileBuffer;
      }
      throw new Error('任务完成但无下载地址');
    }
  }
  throw new Error('转换超时');
}

// ============================================
// ConvertAPI（降级方案）
// ============================================
function convertViaConvertAPI(inputPath, sourceFormat, targetFormat) {
  return new Promise((resolve, reject) => {
    const boundary = '----ca' + Date.now();
    const fileName = path.basename(inputPath);
    const fileData = fs.readFileSync(inputPath);
    const header = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`
    );
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([header, fileData, footer]);

    const req = https.request({
      hostname: 'v2.convertapi.com',
      path: `/convert/${sourceFormat}/to/${targetFormat}?Secret=${CONVERTAPI_SECRET}`,
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length },
      timeout: 120000,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          if (result.Files && result.Files.length > 0) {
            const file = result.Files[0];
            if (file.FileData) {
              resolve(Buffer.from(file.FileData, 'base64'));
            } else if (file.Url) {
              https.get(file.Url, (dlRes) => {
                const chunks = [];
                dlRes.on('data', (c) => chunks.push(c));
                dlRes.on('end', () => resolve(Buffer.concat(chunks)));
              }).on('error', reject);
            } else {
              reject(new Error('ConvertAPI 返回格式异常'));
            }
          } else {
            reject(new Error(result.Message || result.Error || '转换失败'));
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

// ============================================
// 主转换接口
// ============================================
app.post('/api/convert', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ code: -1, message: '未收到文件' });

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

    let fileBuffer = null;
    let usedService = null;

    // 优先 CloudConvert（10次/天免费）
    if (CLOUDCONVERT_API_KEY) {
      try {
        console.log('[Convert] trying CloudConvert...');
        fileBuffer = await convertViaCloudConvert(inputPath, sourceFormat, targetFormat, fileName);
        usedService = 'CloudConvert';
      } catch (ccErr) {
        console.log('[Convert] CloudConvert failed:', ccErr.message);
        // 如果是额度不足(402)，降级到 ConvertAPI
        if (ccErr.statusCode === 402 || ccErr.message.includes('credit') || ccErr.message.includes('limit')) {
          console.log('[Convert] CloudConvert credits exhausted, falling back to ConvertAPI');
        } else if (!CONVERTAPI_SECRET) {
          throw ccErr; // 没有 ConvertAPI 则直接报错
        }
      }
    }

    // 降级 ConvertAPI（暂时禁用，测试 CloudConvert）
    // if (!fileBuffer && CONVERTAPI_SECRET) {
    //   try {
    //     console.log('[Convert] trying ConvertAPI...');
    //     fileBuffer = await convertViaConvertAPI(inputPath, sourceFormat, targetFormat);
    //     usedService = 'ConvertAPI';
    //   } catch (caErr) {
    //     console.log('[Convert] ConvertAPI failed:', caErr.message);
    //     if (!fileBuffer) throw caErr;
    //   }
    // }

    if (!fileBuffer) {
      throw new Error('所有转换服务均不可用，请稍后重试');
    }

    fs.writeFileSync(finalPath, fileBuffer);
    fs.unlinkSync(inputPath);

    const resultUrl = getBaseUrl(req) + '/files/' + taskId + '_' + encodeURIComponent(resultFileName);
    console.log(`[Convert] success via ${usedService}: ${resultFileName} (${fileBuffer.length} bytes)`);

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
  res.json({
    status: 'ok',
    service: 'convert-server',
    cloudconvert: !!CLOUDCONVERT_API_KEY,
    convertapi: !!CONVERTAPI_SECRET,
  });
});

app.listen(PORT, () => {
  console.log(`Convert server running on port ${PORT}`);
  console.log(`  CloudConvert: ${CLOUDCONVERT_API_KEY ? 'configured' : 'NOT set'}`);
  console.log(`  ConvertAPI: ${CONVERTAPI_SECRET ? 'configured' : 'NOT set'}`);
});