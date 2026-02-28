const express = require('express');
const fs = require('fs');
const crypto = require('crypto');
const { exec } = require('child_process');
const jwt = require('jsonwebtoken');

const app = express();
app.use(express.json({ limit: '10mb' }));

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.post('/tts', async (req, res) => {
  const { text, voice = 'es-US-Neural2-B' } = req.body;
  if (!text) return res.status(400).json({ error: 'text is required' });
  try {
    const response = await fetch('https://texttospeech.googleapis.com/v1/text:synthesize', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${await getAccessToken()}`
      },
      body: JSON.stringify({
        input: { text },
        voice: { languageCode: 'es-US', name: voice, ssmlGender: 'MALE' },
        audioConfig: { audioEncoding: 'MP3', speakingRate: 0.95, pitch: -1.0 }
      })
    });
    const data = await response.json();
    if (!response.ok) return res.status(500).json({ error: data.error?.message });
    const audioBuffer = Buffer.from(data.audioContent, 'base64');
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Disposition', 'attachment; filename="audio.mp3"');
    res.send(audioBuffer);
  } catch (err) {
    console.error('TTS error:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

app.post('/merge', async (req, res) => {
  const { video_url, audio_url } = req.body;
  if (!video_url || !audio_url) return res.status(400).json({ error: 'video_url and audio_url are required' });
  const videoPath = `/tmp/${crypto.randomUUID()}.mp4`;
  const audioPath = `/tmp/${crypto.randomUUID()}.mp3`;
  const outputPath = `/tmp/${crypto.randomUUID()}_final.mp4`;
  try {
    const [videoRes, audioRes] = await Promise.all([fetch(video_url), fetch(audio_url)]);
    await Promise.all([
      fs.promises.writeFile(videoPath, Buffer.from(await videoRes.arrayBuffer())),
      fs.promises.writeFile(audioPath, Buffer.from(await audioRes.arrayBuffer()))
    ]);
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

app.post('/kling-token', (req, res) => {
  const accessKey = process.env.KLING_ACCESS_KEY;
  const secretKey = process.env.KLING_SECRET_KEY;

  const payload = {
    iss: accessKey,
    exp: Math.floor(Date.now() / 1000) + 1800,
    nbf: Math.floor(Date.now() / 1000) - 5
  };

  const token = jwt.sign(payload, secretKey, { algorithm: 'HS256', header: { alg: 'HS256', typ: 'JWT' } });
  res.json({ token });
});

const multer = require('multer');
const upload = multer({ dest: '/tmp/' });

app.post('/mix', upload.single('narration'), async (req, res) => {
  const { video_url } = req.body;
  const narrationFile = req.file;

  if (!video_url || !narrationFile) {
    return res.status(400).json({ error: 'video_url and narration file required' });
  }

  const tmpDir = `/tmp/${crypto.randomUUID()}`;
  await fs.promises.mkdir(tmpDir);

  const videoPath = `${tmpDir}/video.mp4`;
  const narrationPath = narrationFile.path;
  const outputPath = `${tmpDir}/final.mp4`;

  try {
    const videoRes = await fetch(video_url);
    await fs.promises.writeFile(videoPath, Buffer.from(await videoRes.arrayBuffer()));

    await new Promise((resolve, reject) => {
      exec(
        `ffmpeg -i ${videoPath} -i ${narrationPath} \
        -filter_complex "[0:a]volume=0.15[ambient];[1:a]volume=1.0[narration];[ambient][narration]amix=inputs=2:duration=longest[aout]" \
        -map 0:v -map "[aout]" -c:v copy -c:a aac -shortest ${outputPath}`,
        (error) => { if (error) reject(error); else resolve(); }
      );
    });

    res.setHeader('Content-Type', 'video/mp4');
    const stream = fs.createReadStream(outputPath);
    stream.pipe(res);
    stream.on('end', () => {
      fs.rm(tmpDir, { recursive: true }, () => {});
      fs.unlink(narrationPath, () => {});
    });

  } catch (err) {
    console.error('Mix error:', err);
    fs.rm(tmpDir, { recursive: true }, () => {});
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

async function getAccessToken() {
  const response = await fetch(
    'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
    { headers: { 'Metadata-Flavor': 'Google' } }
  );
  const data = await response.json();
  return data.access_token;
}

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`API corriendo en puerto ${PORT}`));
