const express = require('express');
const multer = require('multer');
const cors = require('cors');
const libreoffice = require('libreoffice-convert');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');

const convert = promisify(libreoffice.convert);
const app = express();
const PORT = process.env.PORT || 3000;
const TEMP_DIR = path.join(__dirname, 'temp');

if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR);
}

app.use(cors());
app.use('/files', express.static(TEMP_DIR));

const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
});

app.post('/api/convert', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ code: -1, message: '未收到文件' });
    }

    const { sourceFormat, targetFormat, fileName } = req.body;
    if (!sourceFormat || !targetFormat) {
      return res.status(400).json({ code: -1, message: '缺少格式参数' });
    }

    const ext = '.' + targetFormat;
    const baseName = (fileName || 'document').replace(/\.[^.]+$/, '');
    const resultFileName = baseName + '_converted' + ext;
    const taskId = Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const outputPath = path.join(TEMP_DIR, taskId + '_' + resultFileName);

    console.log(`[Convert] ${fileName} (${sourceFormat} → ${targetFormat})`);

    let resultBuffer;
    try {
      resultBuffer = await convert(req.file.buffer, ext, undefined);
    } catch (convertErr) {
      console.error('[Convert] libreoffice error:', convertErr);
      return res.status(500).json({
        code: -1,
        message: '文件转换失败：' + (convertErr.message || 'LibreOffice 错误'),
      });
    }

    if (!resultBuffer || resultBuffer.length === 0) {
      return res.status(500).json({
        code: -1,
        message: '转换结果为空，可能不支持该格式转换',
      });
    }

    fs.writeFileSync(outputPath, resultBuffer);

    const baseUrl = req.protocol + '://' + req.get('host');
    const resultUrl = baseUrl + '/files/' + taskId + '_' + encodeURIComponent(resultFileName);

    console.log(`[Convert] success: ${resultFileName} (${resultBuffer.length} bytes)`);

    res.json({
      code: 0,
      message: 'success',
      data: { resultUrl, resultFileName },
    });
  } catch (err) {
    console.error('[Convert] error:', err);
    res.status(500).json({ code: -1, message: err.message || '转换失败' });
  }
});

// 定时清理过期文件
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
  } catch (e) {
    // 忽略
  }
}, 1800000);

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'convert-server' });
});

app.listen(PORT, () => {
  console.log(`Convert server running on port ${PORT}`);
});
