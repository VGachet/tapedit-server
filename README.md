# Video Export Server

Serveur Docker dédié à l'export vidéo avec FFmpeg pour conversion WebM → MP4 H.264.

## 🚀 Démarrage rapide

### Avec Docker Compose (recommandé)

```bash
# Créer le fichier .env
cp .env.example .env

# Editer les variables d'environnement
nano .env

# Démarrer le serveur
docker-compose up -d

# Voir les logs
docker-compose logs -f
```

### Sans Docker (développement)

```bash
# Prérequis: FFmpeg installé sur le système
# macOS: brew install ffmpeg
# Ubuntu: apt install ffmpeg

# Installer les dépendances
npm install

# Démarrer en mode développement
npm run dev
```

## 📡 API Endpoints

### Health Check
```
GET /health
```
Réponse:
```json
{
  "status": "ok",
  "timestamp": "2025-01-29T12:00:00.000Z",
  "version": "1.0.0",
  "ffmpeg": true
}
```

### Convert Video
```
POST /convert
Headers:
  X-API-Key: your-secret-api-key
  Content-Type: multipart/form-data

Body (form-data):
  video: <file>          # Fichier vidéo WebM (obligatoire)
  audio: <file>          # Fichier audio (optionnel)
  quality: high|medium|low
  fps: 30
  filename: export.mp4

Response: video/mp4 file stream
```

## ⚙️ Configuration

| Variable | Description | Défaut |
|----------|-------------|--------|
| `API_KEY` | Clé d'authentification | `your-secret-api-key` |
| `PORT` | Port du serveur | `3001` |
| `MAX_FILE_SIZE_MB` | Taille max fichier (MB) | `500` |
| `ALLOWED_ORIGINS` | Origins CORS autorisées | `localhost:5173,localhost:3000` |

## 🎬 Qualité Video

| Preset | Video Bitrate | Audio | FFmpeg Preset |
|--------|--------------|-------|---------------|
| low | 2 Mbps | 128k | veryfast |
| medium | 5 Mbps | 192k | medium |
| high | 10 Mbps | 256k | slow |

## 🔒 Sécurité

- Authentification par API Key (header `X-API-Key`)
- CORS configuré pour les origines autorisées
- Nettoyage automatique des fichiers temporaires (1h)
- Limite de taille de fichier configurable

## 🐳 Production

Pour la production, utilisez des valeurs sécurisées:

```bash
# Générer une API key sécurisée
openssl rand -hex 32

# Dans .env
API_KEY=<votre-clé>
ALLOWED_ORIGINS=https://votre-app.com
```

## 📊 Logs

Les logs indiquent:
- Début de conversion avec ID unique
- Progression en pourcentage
- Erreurs éventuelles
- Nettoyage des fichiers

```
[abc123] Starting conversion...
  Video: /app/temp/input.webm
  Audio: /app/temp/audio.mp3
  Quality: high
  FPS: 30
[abc123] Progress: 45.2%
[abc123] Conversion complete
Cleaned up: /app/temp/input.webm
```
