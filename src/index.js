const express = require('express');
const cors = require('cors');
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

// Convert endpoint
app.post('/convert', requireApiKey, upload.fields([
  { name: 'video', maxCount: 1 },
  { name: 'audio', maxCount: 1 }
]), async (req, res) => {
  const conversionId = uuidv4();
  let videoPath = null;
  let audioPath = null;
  let outputPath = null;

  try {
    if (!req.files || !req.files.video) {
      return res.status(400).json({ error: 'No video file provided' });
    }

    videoPath = req.files.video[0].path;
    audioPath = req.files.audio ? req.files.audio[0].path : null;
    outputPath = path.join(tempDir, `${conversionId}.mp4`);

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

    console.log(`[${conversionId}] Starting conversion...`);
    console.log(`  Video: ${videoPath}`);
    console.log(`  Audio: ${audioPath || 'none'}`);
    console.log(`  Quality: ${options.quality}`);
    console.log(`  FPS: ${options.fps}`);

    // Initialize progress tracking
    activeConversions.set(conversionId, { progress: 0, status: 'processing' });

    await new Promise((resolve, reject) => {
      // Build FFmpeg arguments
      const args = ['-y', '-i', videoPath];
      
      if (audioPath) {
        args.push('-i', audioPath);
      }

      // Video encoding
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

      // Audio options
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

      // Progress output
      args.push('-progress', 'pipe:1');
      args.push(outputPath);

      console.log(`[${conversionId}] FFmpeg command: ffmpeg ${args.join(' ')}`);

      const ffmpegProcess = spawn('ffmpeg', args);
      let duration = null;

      ffmpegProcess.stderr.on('data', (data) => {
        const output = data.toString();
        // Extract duration from input
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
        // Parse progress from ffmpeg output
        const timeMatch = output.match(/out_time_ms=(\d+)/);
        if (timeMatch && duration) {
          const currentTime = parseInt(timeMatch[1]) / 1000000;
          const percent = Math.min((currentTime / duration) * 100, 99);
          activeConversions.set(conversionId, { progress: percent, status: 'processing' });
          console.log(`[${conversionId}] Progress: ${percent.toFixed(1)}%`);
        }
      });

      ffmpegProcess.on('close', (code) => {
        if (code === 0) {
          console.log(`[${conversionId}] Conversion complete`);
          activeConversions.set(conversionId, { progress: 100, status: 'complete' });
          resolve();
        } else {
          reject(new Error(`FFmpeg exited with code ${code}`));
        }
      });

      ffmpegProcess.on('error', (err) => {
        console.error(`[${conversionId}] Error: ${err.message}`);
        activeConversions.delete(conversionId);
        reject(err);
      });
    });

    // Send the converted file
    const stat = fs.statSync(outputPath);
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Content-Disposition', `attachment; filename="${options.filename}"`);

    const readStream = fs.createReadStream(outputPath);
    readStream.pipe(res);

    readStream.on('end', () => {
      // Cleanup files after sending
      cleanup(videoPath, audioPath, outputPath);
      activeConversions.delete(conversionId);
    });

    readStream.on('error', (err) => {
      console.error(`[${conversionId}] Stream error: ${err.message}`);
      cleanup(videoPath, audioPath, outputPath);
      activeConversions.delete(conversionId);
    });

  } catch (error) {
    console.error(`Conversion error: ${error.message}`);
    cleanup(videoPath, audioPath, outputPath);
    activeConversions.delete(conversionId);
    
    if (!res.headersSent) {
      res.status(500).json({ error: 'Conversion failed', details: error.message });
    }
  }
});

// Progress endpoint
app.get('/progress/:id', requireApiKey, (req, res) => {
  const conversion = activeConversions.get(req.params.id);
  if (!conversion) {
    return res.status(404).json({ error: 'Conversion not found' });
  }
  res.json(conversion);
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
