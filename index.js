const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const app = express();
const PORT = process.env.PORT || 3000;
const TEMP_DIR = path.join(__dirname, 'temp');

if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR);
}

app.use(cors());
app.use('/files', express.static(TEMP_DIR));

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

// 格式 → LibreOffice filter 映射
const FILTER_MAP = {
  pdf: 'pdf:writer_pdf_Export',
  docx: 'docx:MS Word 2007 XML',
  doc: 'doc:MS Word 97',
  txt: 'txt:Text',
  rtf: 'rtf:Rich Text Format',
  odt: 'odx:writer8',
};

app.post('/api/convert', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ code: -1, message: '未收到文件' });
    }

    const { sourceFormat, targetFormat, fileName } = req.body;
    if (!sourceFormat || !targetFormat) {
      return res.status(400).json({ code: -1, message: '缺少格式参数' });
    }

    const inputPath = req.file.path;
    const baseName = (fileName || 'document').replace(/\.[^.]+$/, '');
    const resultFileName = baseName + '_converted.' + targetFormat;
    const taskId = Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const outputDir = path.join(TEMP_DIR, 'out_' + taskId);

    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir);
    }

    console.log(`[Convert] ${fileName} (${sourceFormat} → ${targetFormat})`);
    console.log(`[Convert] input: ${inputPath}`);

    // 直接调用 soffice 命令行转换
    const filter = FILTER_MAP[targetFormat] || targetFormat;
    const cmd = 'soffice';
    const args = [
      '--headless',
      '--nologo',
      '--nofirststartwizard',
      '--norestore',
      `--convert-to`,
      filter,
      `--outdir`,
      outputDir,
      inputPath,
    ];

    try {
      const { stdout, stderr } = await execFileAsync(cmd, args, {
        timeout: 120000,
        env: { ...process.env, HOME: '/tmp' },
      });
      if (stdout) console.log('[Convert] soffice stdout:', stdout);
      if (stderr) console.log('[Convert] soffice stderr:', stderr);
    } catch (execErr) {
      console.error('[Convert] soffice error:', execErr);
      return res.status(500).json({
        code: -1,
        message: 'LibreOffice 转换失败：' + (execErr.message || ''),
      });
    }

    // soffice 输出文件名 = 原文件名(去掉原扩展名) + 新扩展名
    const inputBaseName = path.basename(inputPath, path.extname(inputPath));
    const expectedOutput = path.join(outputDir, inputBaseName + '.' + targetFormat);

    if (!fs.existsSync(expectedOutput)) {
      // 尝试查找输出目录中的任何文件
      const files = fs.readdirSync(outputDir);
      if (files.length === 0) {
        return res.status(500).json({
          code: -1,
          message: `转换失败：不支持 ${sourceFormat} → ${targetFormat} 转换`,
        });
      }
      // 使用第一个输出文件
      const actualFile = path.join(outputDir, files[0]);
      const finalPath = path.join(TEMP_DIR, taskId + '_' + resultFileName);
      fs.copyFileSync(actualFile, finalPath);
      fs.rmSync(outputDir, { recursive: true });
      fs.unlinkSync(inputPath);

      const baseUrl = req.protocol + '://' + req.get('host');
      const resultUrl = baseUrl + '/files/' + taskId + '_' + encodeURIComponent(resultFileName);
      console.log(`[Convert] success: ${resultFileName}`);
      return res.json({
        code: 0,
        message: 'success',
        data: { resultUrl, resultFileName },
      });
    }

    // 重命名为友好的文件名
    const finalPath = path.join(TEMP_DIR, taskId + '_' + resultFileName);
    fs.copyFileSync(expectedOutput, finalPath);
    fs.rmSync(outputDir, { recursive: true });
    fs.unlinkSync(inputPath);

    const baseUrl = req.protocol + '://' + req.get('host');
    const resultUrl = baseUrl + '/files/' + taskId + '_' + encodeURIComponent(resultFileName);

    const fileSize = fs.statSync(finalPath).size;
    console.log(`[Convert] success: ${resultFileName} (${fileSize} bytes)`);

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
