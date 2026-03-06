const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3001;
const API_KEY = process.env.API_KEY || 'your-secret-api-key';
const MAX_FILE_SIZE = (parseInt(process.env.MAX_FILE_SIZE_MB) || 500) * 1024 * 1024;

// Parse allowed origins
const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:5173,http://localhost:3000')
  .split(',')
  .map(origin => origin.trim());

// Trust proxy (needed for rate limiting behind Traefik)
app.set('trust proxy', 1);

// Rate limiting - 10 conversions per hour per IP
const convertLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10, // 10 requests per hour
  message: { error: 'Too many conversion requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip
});

// General rate limiting - 100 requests per 15 minutes
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  message: { error: 'Too many requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false
});

app.use(generalLimiter);

// CORS configuration
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, curl, etc.)
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin) || allowedOrigins.includes('*')) {
      return callback(null, true);
    }
    return callback(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-API-Key'],
  exposedHeaders: ['Content-Disposition']
}));

// Temp directory
const tempDir = path.join(__dirname, '../temp');
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir, { recursive: true });
}

// Multer configuration
const storage = multer.diskStorage({
  destination: tempDir,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.webm';
    cb(null, `${uuidv4()}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE }
});

// API Key middleware
const requireApiKey = (req, res, next) => {
  const apiKey = req.headers['x-api-key'];
  if (apiKey !== API_KEY) {
    return res.status(401).json({ error: 'Invalid API key' });
  }
  next();
};

// Track active conversions for progress
const activeConversions = new Map();

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    version: '1.0.0',
    ffmpeg: true
  });
});

// Convert endpoint — returns job ID immediately, processes FFmpeg in background
// to avoid proxy/gateway timeouts during long conversions
app.post('/convert', convertLimiter, requireApiKey, upload.fields([
  { name: 'video', maxCount: 1 },
  { name: 'audio', maxCount: 1 }
]), (req, res) => {
  const conversionId = uuidv4();

  if (!req.files || !req.files.video) {
    return res.status(400).json({ error: 'No video file provided' });
  }

  const videoPath = req.files.video[0].path;
  const audioPath = req.files.audio ? req.files.audio[0].path : null;
  const outputPath = path.join(tempDir, `${conversionId}.mp4`);

  const options = {
    quality: req.body.quality || 'high',
    fps: parseInt(req.body.fps) || 30,
    filename: req.body.filename || 'export.mp4'
  };

  // Quality presets
  const qualityPresets = {
    low: { videoBitrate: '2000k', audioBitrate: '128k', preset: 'veryfast' },
    medium: { videoBitrate: '5000k', audioBitrate: '192k', preset: 'medium' },
    high: { videoBitrate: '10000k', audioBitrate: '256k', preset: 'slow' }
  };

  const preset = qualityPresets[options.quality] || qualityPresets.high;

  console.log(`[${conversionId}] Starting async conversion...`);
  console.log(`  Video: ${videoPath}`);
  console.log(`  Audio: ${audioPath || 'none'}`);
  console.log(`  Quality: ${options.quality}`);
  console.log(`  FPS: ${options.fps}`);

  // Initialize progress tracking before responding
  activeConversions.set(conversionId, {
    progress: 0,
    status: 'processing',
    filename: options.filename,
    outputPath,
    videoPath,
    audioPath,
  });

  // Respond immediately with the job ID — prevents proxy timeouts
  res.json({ id: conversionId });

  // Run FFmpeg in background (fire and forget — progress tracked in activeConversions)
  const args = ['-y', '-i', videoPath];

  if (audioPath) {
    args.push('-i', audioPath);
  }

  args.push(
    '-c:v', 'libx264',
    '-b:v', preset.videoBitrate,
    '-preset', preset.preset,
    '-profile:v', 'high',
    '-level', '4.1',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    '-r', String(options.fps)
  );

  if (audioPath) {
    args.push(
      '-c:a', 'aac',
      '-b:a', preset.audioBitrate,
      '-ar', '44100',
      '-map', '0:v:0',
      '-map', '1:a:0',
      '-shortest'
    );
  } else {
    args.push('-an');
  }

  args.push('-progress', 'pipe:1');
  args.push(outputPath);

  console.log(`[${conversionId}] FFmpeg command: ffmpeg ${args.join(' ')}`);

  const ffmpegProcess = spawn('ffmpeg', args);
  let duration = null;

  ffmpegProcess.stderr.on('data', (data) => {
    const output = data.toString();
    const durationMatch = output.match(/Duration: (\d{2}):(\d{2}):(\d{2}\.\d{2})/);
    if (durationMatch) {
      const hours = parseInt(durationMatch[1]);
      const minutes = parseInt(durationMatch[2]);
      const seconds = parseFloat(durationMatch[3]);
      duration = hours * 3600 + minutes * 60 + seconds;
    }
  });

  ffmpegProcess.stdout.on('data', (data) => {
    const output = data.toString();
    const timeMatch = output.match(/out_time_ms=(\d+)/);
    if (timeMatch && duration) {
      const currentTime = parseInt(timeMatch[1]) / 1000000;
      const percent = Math.min((currentTime / duration) * 100, 99);
      const current = activeConversions.get(conversionId);
      if (current) {
        activeConversions.set(conversionId, { ...current, progress: percent });
      }
      console.log(`[${conversionId}] Progress: ${percent.toFixed(1)}%`);
    }
  });

  ffmpegProcess.on('close', (code) => {
    const current = activeConversions.get(conversionId);
    if (!current) return;
    if (code === 0) {
      console.log(`[${conversionId}] Conversion complete`);
      activeConversions.set(conversionId, { ...current, progress: 100, status: 'complete' });
      // Clean up input files now that output is ready
      cleanup(videoPath, audioPath);
    } else {
      console.error(`[${conversionId}] FFmpeg exited with code ${code}`);
      activeConversions.set(conversionId, { ...current, status: 'error', error: `FFmpeg exited with code ${code}` });
      cleanup(videoPath, audioPath, outputPath);
    }
  });

  ffmpegProcess.on('error', (err) => {
    console.error(`[${conversionId}] Spawn error: ${err.message}`);
    const current = activeConversions.get(conversionId);
    if (current) {
      activeConversions.set(conversionId, { ...current, status: 'error', error: err.message });
    }
    cleanup(videoPath, audioPath, outputPath);
  });
});

// Progress endpoint
app.get('/progress/:id', requireApiKey, (req, res) => {
  const conversion = activeConversions.get(req.params.id);
  if (!conversion) {
    return res.status(404).json({ error: 'Conversion not found' });
  }
  const { outputPath, videoPath, audioPath, filename, ...safeFields } = conversion;
  res.json(safeFields);
});

// Download endpoint — streams the completed MP4 then cleans up
app.get('/download/:id', requireApiKey, (req, res) => {
  const conversion = activeConversions.get(req.params.id);
  if (!conversion) {
    return res.status(404).json({ error: 'Conversion not found' });
  }
  if (conversion.status !== 'complete') {
    return res.status(409).json({ error: 'Conversion not ready', status: conversion.status });
  }

  const { outputPath, filename } = conversion;

  if (!fs.existsSync(outputPath)) {
    activeConversions.delete(req.params.id);
    return res.status(410).json({ error: 'Output file no longer available' });
  }

  const stat = fs.statSync(outputPath);
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Length', stat.size);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  const readStream = fs.createReadStream(outputPath);
  readStream.pipe(res);

  readStream.on('end', () => {
    cleanup(outputPath);
    activeConversions.delete(req.params.id);
  });

  readStream.on('error', (err) => {
    console.error(`[${req.params.id}] Stream error: ${err.message}`);
    cleanup(outputPath);
    activeConversions.delete(req.params.id);
  });
});

// Cleanup helper
function cleanup(...paths) {
  paths.forEach(p => {
    if (p && fs.existsSync(p)) {
      try {
        fs.unlinkSync(p);
        console.log(`Cleaned up: ${p}`);
      } catch (err) {
        console.error(`Failed to cleanup ${p}: ${err.message}`);
      }
    }
  });
}

// Periodic cleanup of old temp files (older than 1 hour)
setInterval(() => {
  const now = Date.now();
  const maxAge = 60 * 60 * 1000; // 1 hour

  fs.readdir(tempDir, (err, files) => {
    if (err) return;

    files.forEach(file => {
      const filePath = path.join(tempDir, file);
      fs.stat(filePath, (err, stat) => {
        if (err) return;
        if (now - stat.mtimeMs > maxAge) {
          fs.unlink(filePath, (err) => {
            if (!err) console.log(`Cleaned up old file: ${file}`);
          });
        }
      });
    });
  });
}, 15 * 60 * 1000); // Run every 15 minutes

// Error handling
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'File too large' });
    }
  }
  
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║           Video Export Server v1.0.0                       ║
╠═══════════════════════════════════════════════════════════╣
║  Status:   Running                                         ║
║  Port:     ${PORT}                                            ║
║  Origins:  ${allowedOrigins.join(', ').substring(0, 40).padEnd(41)}║
║  Max Size: ${MAX_FILE_SIZE / 1024 / 1024}MB                                          ║
╚═══════════════════════════════════════════════════════════╝
  `);
});
