const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;
const TEMP_DIR = path.join(__dirname, 'temp');

// CloudConvert 密钥（在 Render 环境变量中设置）
const CLOUDCONVERT_API_KEY = process.env.CLOUDCONVERT_API_KEY;

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

/** 创建 CloudConvert Job */
function createCloudConvertJob(inputPath, sourceFormat, targetFormat, fileName) {
  return new Promise((resolve, reject) => {
    const boundary = '----' + Date.now();
    const jsonData = JSON.stringify({
      api_key: CLOUDCONVERT_API_KEY,
      input: 'upload',
      conversion: {
        import: {
          encoding: 'binary',
          filename: fileName.replace(/\.[^.]+$/, '.' + targetFormat),
        },
        export: {
          engine: 'convert',
        },
        tasks: {
          import_upload: {
            engine: 'import/upload',
          },
          convert: {
            engine: 'convert',
            input: 'import_upload',
            options: {
              conversion: {
                show: {
                  import_export_filenames: true,
                },
              },
            },
          },
          export_download: {
            engine: 'export/download',
            input: 'convert',
          },
        },
      },
    });

    const header = Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="input"\r\n` +
      `Content-Type: application/json\r\n\r\n`
    );
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
    const jsonBody = Buffer.from(jsonData, 'utf-8');
    const body = Buffer.concat([header, jsonBody, footer]);

    const options = {
      hostname: 'api.cloudconvert.com',
      path: '/v2/jobs',
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
      },
      timeout: 180000, // 3 minutes for CloudConvert jobs
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          if (result.data && result.data.id) {
            resolve(result.data.id);
          } else {
            const msg = result.message || result.error?.message || JSON.stringify(result);
            reject(new Error(msg));
          }
        } catch (e) {
          reject(new Error('解析响应失败: ' + data.slice(0, 300)));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')); });
    req.write(body);
    req.end();
  });
}

/** 上传文件到 CloudConvert Job */
function uploadToJob(jobId, inputPath, fileName) {
  return new Promise((resolve, reject) => {
    const fileData = fs.readFileSync(inputPath);
    const boundary = '----' + Date.now();
    const fileNameSafe = encodeURIComponent(fileName);

    const header = Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${fileNameSafe}"\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n`
    );
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([header, fileData, footer]);

    const options = {
      hostname: 'api.cloudconvert.com',
      path: `/v2/jobs/${encodeURIComponent(jobId)}/tasks/import_upload/upload`,
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
          if (result.data) resolve(true);
          else reject(new Error('上传失败'));
        } catch (e) {
          reject(new Error('解析响应失败'));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('上传超时')); });
    req.write(body);
    req.end();
  });
}

/** 等待 Job 完成并获取下载 URL */
function waitForJobCompletion(jobId) {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const maxAttempts = 30;
    const pollInterval = 5000; // 5 seconds

    function poll() {
      attempts++;
      if (attempts > maxAttempts) {
        return reject(new Error('转换超时'));
      }

      const options = {
        hostname: 'api.cloudconvert.com',
        path: `/v2/jobs/${encodeURIComponent(jobId)}`,
        method: 'GET',
        headers: { 'Accept': 'application/json' },
        timeout: 30000,
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            const result = JSON.parse(data);
            if (!result.data) return reject(new Error('无法获取任务状态'));

            const task = result.data.tasks?.[0];
            if (task.status === 'finished') {
              // 获取 download_url
              const dlUrl = task.result?.download_url || result.data.tasks?.[2]?.result?.download_url;
              if (dlUrl) {
                resolve(dlUrl);
              } else {
                reject(new Error('转换成功但无下载链接'));
              }
            } else if (task.status === 'error') {
              reject(new Error(task.message || '转换失败'));
            } else {
              // Still processing, wait and poll again
              setTimeout(poll, pollInterval);
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
    const options = {
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      headers: { 'Accept': 'application/octet-stream' },
      timeout: 120000,
    };

    https.get(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve(Buffer.concat(chunks));
      });
    }).on('error', reject);
  });
}

app.post('/api/convert', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ code: -1, message: '未收到文件' });
    }

    if (!CLOUDCONVERT_API_KEY) {
      return res.status(500).json({
        code: -1,
        message: '服务器未配置 CloudConvert API Key，请在 Render 环境变量中设置',
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

    // Step 1: Create CloudConvert Job
    const jobId = await createCloudConvertJob(inputPath, sourceFormat, targetFormat, fileName);
    console.log(`[Convert] job created: ${jobId}`);

    // Step 2: Upload file to Job
    await uploadToJob(jobId, inputPath, fileName);
    console.log('[Convert] file uploaded');

    // Step 3: Wait for completion
    const downloadUrl = await waitForJobCompletion(jobId);
    console.log('[Convert] job finished, downloading...');

    // Step 4: Download converted file
    const fileBuffer = await downloadFromUrl(downloadUrl);
    console.log(`[Convert] downloaded ${fileBuffer.length} bytes`);

    // Save file
    fs.writeFileSync(finalPath, fileBuffer);
    fs.unlinkSync(inputPath);

    const resultUrl = getBaseUrl(req) + '/files/' + taskId + '_' + encodeURIComponent(resultFileName);
    console.log(`[Convert] success: ${resultFileName}`);

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
  if (!CLOUDCONVERT_API_KEY) {
    console.warn('WARNING: CLOUDCONVERT_API_KEY not set!');
  }
});
