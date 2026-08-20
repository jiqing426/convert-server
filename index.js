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

// 格式 → soffice filter 映射
const SOFFICE_FILTER = {
  pdf: 'pdf:writer_pdf_Export',
  docx: 'docx:MS Word 2007 XML',
  doc: 'doc:MS Word 97',
  txt: 'txt:Text',
  rtf: 'rtf:Rich Text Format',
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
    const finalPath = path.join(TEMP_DIR, taskId + '_' + resultFileName);

    console.log(`[Convert] ${fileName} (${sourceFormat} → ${targetFormat})`);

    // PDF → TXT：使用 pdftotext（poppler-utils）
    if (sourceFormat === 'pdf' && targetFormat === 'txt') {
      try {
        await execFileAsync('pdftotext', [inputPath, finalPath], {
          timeout: 60000,
          env: { ...process.env, HOME: '/tmp' },
        });
        if (fs.existsSync(finalPath) && fs.statSync(finalPath).size > 0) {
          fs.unlinkSync(inputPath);
          const baseUrl = req.protocol + '://' + req.get('host');
          const resultUrl = baseUrl + '/files/' + taskId + '_' + encodeURIComponent(resultFileName);
          console.log(`[Convert] success (pdftotext): ${resultFileName}`);
          return res.json({
            code: 0,
            message: 'success',
            data: { resultUrl, resultFileName },
          });
        }
      } catch (err) {
        console.error('[Convert] pdftotext error:', err.message);
        return res.status(500).json({
          code: -1,
          message: 'PDF 文本提取失败：' + (err.message || ''),
        });
      }
    }

    // 其他格式：使用 soffice
    const outputDir = path.join(TEMP_DIR, 'out_' + taskId);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir);
    }

    const filter = SOFFICE_FILTER[targetFormat] || targetFormat;
    const args = [
      '--headless',
      '--nologo',
      '--nofirststartwizard',
      '--norestore',
      '--convert-to', filter,
      '--outdir', outputDir,
      inputPath,
    ];

    try {
      const { stdout, stderr } = await execFileAsync('soffice', args, {
        timeout: 120000,
        env: { ...process.env, HOME: '/tmp' },
      });
      if (stdout) console.log('[Convert] soffice stdout:', stdout);
      if (stderr) console.log('[Convert] soffice stderr:', stderr);
    } catch (execErr) {
      console.error('[Convert] soffice error:', execErr.message);
      return res.status(500).json({
        code: -1,
        message: `转换失败：不支持 ${sourceFormat} → ${targetFormat}`,
      });
    }

    // 查找输出文件
    const inputBaseName = path.basename(inputPath, path.extname(inputPath));
    const expectedOutput = path.join(outputDir, inputBaseName + '.' + targetFormat);

    let outputFile = null;
    if (fs.existsSync(expectedOutput) && fs.statSync(expectedOutput).size > 0) {
      outputFile = expectedOutput;
    } else {
      // 尝试输出目录中的任意文件
      const files = fs.readdirSync(outputDir).filter(f => !f.startsWith('.'));
      if (files.length > 0) {
        outputFile = path.join(outputDir, files[0]);
      }
    }

    if (!outputFile) {
      // 清理
      try { fs.rmSync(outputDir, { recursive: true }); } catch(e) {}
      fs.unlinkSync(inputPath);
      return res.status(500).json({
        code: -1,
        message: `转换失败：不支持 ${sourceFormat} → ${targetFormat}`,
      });
    }

    // 复制到最终路径
    fs.copyFileSync(outputFile, finalPath);
    try { fs.rmSync(outputDir, { recursive: true }); } catch(e) {}
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
  } catch (e) {}
}, 1800000);

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'convert-server' });
});

app.listen(PORT, () => {
  console.log(`Convert server running on port ${PORT}`);
});
