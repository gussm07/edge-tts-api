const express = require('express');
const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');
const fs = require('fs');
const crypto = require('crypto');
const { exec } = require('child_process');

const app = express();
app.use(express.json({ limit: '10mb' }));

// ─── Health Check ────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// ─── Text To Speech ──────────────────────────────────────────────
app.post('/tts', async (req, res) => {
  const { text, voice = 'es-US-Neural2-B' } = req.body;

  if (!text) {
    return res.status(400).json({ error: 'text is required' });
  }

  try {
    const response = await fetch('https://texttospeech.googleapis.com/v1/text:synthesize', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${await getAccessToken()}`
      },
      body: JSON.stringify({
        input: { text },
        voice: {
          languageCode: 'es-US',
          name: voice,
          ssmlGender: 'MALE'
        },
        audioConfig: {
          audioEncoding: 'MP3',
          speakingRate: 0.95,
          pitch: -1.0
        }
      })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('TTS API error:', data);
      return res.status(500).json({ error: data.error?.message || 'TTS API error' });
    }

    const audioBuffer = Buffer.from(data.audioContent, 'base64');
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Disposition', 'attachment; filename="audio.mp3"');
    res.send(audioBuffer);

  } catch (err) {
    console.error('TTS error:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// ─── Merge Video + Audio con FFmpeg ──────────────────────────────
app.post('/merge', async (req, res) => {
  const { video_url, audio_url } = req.body;

  if (!video_url || !audio_url) {
    return res.status(400).json({ error: 'video_url and audio_url are required' });
  }

  const videoPath = `/tmp/${crypto.randomUUID()}.mp4`;
  const audioPath = `/tmp/${crypto.randomUUID()}.mp3`;
  const outputPath = `/tmp/${crypto.randomUUID()}_final.mp4`;

  try {
    // Descargar video y audio en paralelo
    const [videoRes, audioRes] = await Promise.all([
      fetch(video_url),
      fetch(audio_url)
    ]);

    await Promise.all([
      fs.promises.writeFile(videoPath, Buffer.from(await videoRes.arrayBuffer())),
      fs.promises.writeFile(audioPath, Buffer.from(await audioRes.arrayBuffer()))
    ]);

    // Unir video + audio con FFmpeg
    await new Promise((resolve, reject) => {
      exec(
        `ffmpeg -i ${videoPath} -i ${audioPath} -map 0:v -map 1:a -c:v copy -c:a aac -shortest ${outputPath}`,
        (error) => { if (error) reject(error); else resolve(); }
      );
    });

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', 'attachment; filename="final.mp4"');
    const stream = fs.createReadStream(outputPath);
    stream.pipe(res);
    stream.on('end', () => {
      fs.unlink(videoPath, () => {});
      fs.unlink(audioPath, () => {});
      fs.unlink(outputPath, () => {});
    });

  } catch (err) {
    console.error('Merge error:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// ─── Access Token GCP ─────────────────────────────────────────────
async function getAccessToken() {
  const response = await fetch(
    'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
    { headers: { 'Metadata-Flavor': 'Google' } }
  );
  const data = await response.json();
  return data.access_token;
}

// ─── Server ───────────────────────────────────────────────────────
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`API corriendo en puerto ${PORT}`));