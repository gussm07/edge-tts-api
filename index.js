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

  const tmpDir = `/tmp/${crypto.randomUUID()}`;
  await fs.promises.mkdir(tmpDir, { recursive: true });

  try {
    // Dividir texto en chunks de 4500 bytes
    const chunks = [];
    const sentences = text.split(/(?<=[.!?])\s+/);
    let current = '';

    for (const sentence of sentences) {
      const candidate = current ? current + ' ' + sentence : sentence;
      if (Buffer.byteLength(candidate, 'utf8') > 4500) {
        if (current) chunks.push(current);
        current = sentence;
      } else {
        current = candidate;
      }
    }
    if (current) chunks.push(current);

    // Generar audio para cada chunk
    const chunkPaths = [];
    for (const [i, chunk] of chunks.entries()) {
      const chunkPath = `${tmpDir}/chunk_${i}.mp3`;

      const ttsResponse = await fetch(
        `https://texttospeech.googleapis.com/v1/text:synthesize?key=${process.env.GOOGLE_TTS_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            input: { text: chunk },
            voice: { languageCode: 'es-US', name: voice },
            audioConfig: { audioEncoding: 'MP3' }
          })
        }
      );

      const ttsData = await ttsResponse.json();
      if (!ttsData.audioContent) throw new Error(`TTS chunk ${i} failed: ${JSON.stringify(ttsData)}`);

      await fs.promises.writeFile(chunkPath, Buffer.from(ttsData.audioContent, 'base64'));
      chunkPaths.push(chunkPath);
    }

    // Concatenar todos los chunks de audio
    const outputPath = `${tmpDir}/narration.mp3`;

    if (chunkPaths.length === 1) {
      await fs.promises.copyFile(chunkPaths[0], outputPath);
    } else {
      const concatFile = `${tmpDir}/concat_audio.txt`;
      await fs.promises.writeFile(concatFile, chunkPaths.map(p => `file '${p}'`).join('\n'));
      await new Promise((resolve, reject) => {
        exec(`ffmpeg -f concat -safe 0 -i ${concatFile} -c:a copy ${outputPath}`,
          err => err ? reject(err) : resolve());
      });
    }

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Disposition', 'attachment; filename="narration.mp3"');
    const stream = fs.createReadStream(outputPath);
    stream.pipe(res);
    stream.on('end', () => fs.rm(tmpDir, { recursive: true }, () => {}));

  } catch (err) {
    console.error('TTS error:', err);
    fs.rm(tmpDir, { recursive: true }, () => {});
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

app.post('/assemble', async (req, res) => {
  const { clips, archive_images, subtitles, map_base64, audio_base64 } = req.body;

  const tmpDir = `/tmp/${crypto.randomUUID()}`;
  await fs.promises.mkdir(tmpDir, { recursive: true });

  try {
    // Descargar clips Veo 3
    const clipPaths = await Promise.all(clips.map(async (url, i) => {
      const path = `${tmpDir}/clip_${i}.mp4`;
      const r = await fetch(url);
      await fs.promises.writeFile(path, Buffer.from(await r.arrayBuffer()));
      return path;
    }));

    // Descargar imágenes Pexels
    const imgPaths = await Promise.all(archive_images.slice(0, 3).map(async (url, i) => {
      const path = `${tmpDir}/archive_${i}.jpg`;
      try {
        const r = await fetch(url);
        await fs.promises.writeFile(path, Buffer.from(await r.arrayBuffer()));
        return path;
      } catch { return null; }
    }));

    // Guardar mapa desde base64
    const mapPath = `${tmpDir}/map.png`;
    if (map_base64) {
      await fs.promises.writeFile(mapPath, Buffer.from(map_base64, 'base64'));
    }

    // Guardar audio desde base64
    const audioPath = `${tmpDir}/narration.mp3`;
    if (audio_base64) {
      await fs.promises.writeFile(audioPath, Buffer.from(audio_base64, 'base64'));
    }

    // Convertir imágenes a video 5 seg
    const imgVideoPaths = [];
    for (const [i, imgPath] of imgPaths.entries()) {
      if (!imgPath) continue;
      const outPath = `${tmpDir}/img_video_${i}.mp4`;
      await new Promise((resolve, reject) => {
        exec(`ffmpeg -loop 1 -i ${imgPath} -c:v libx264 -t 5 -pix_fmt yuv420p -vf "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2" ${outPath}`,
          err => err ? reject(err) : resolve());
      });
      imgVideoPaths.push(outPath);
    }

    // Convertir mapa a video 8 seg
    const mapVideoPath = `${tmpDir}/map_video.mp4`;
    if (map_base64) {
      await new Promise((resolve, reject) => {
        exec(`ffmpeg -loop 1 -i ${mapPath} -c:v libx264 -t 8 -pix_fmt yuv420p -vf "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2" ${mapVideoPath}`,
          err => err ? reject(err) : resolve());
      });
    }

    // Crear concat.txt
    const segments = [];
    segments.push(`file '${clipPaths[0]}'`);
    if (map_base64) segments.push(`file '${mapVideoPath}'`);
    segments.push(`file '${clipPaths[1]}'`);
    if (imgVideoPaths[0]) segments.push(`file '${imgVideoPaths[0]}'`);
    segments.push(`file '${clipPaths[2]}'`);
    segments.push(`file '${clipPaths[3]}'`);
    if (imgVideoPaths[1]) segments.push(`file '${imgVideoPaths[1]}'`);
    segments.push(`file '${clipPaths[4]}'`);
    segments.push(`file '${clipPaths[5]}'`);
    if (imgVideoPaths[2]) segments.push(`file '${imgVideoPaths[2]}'`);
    segments.push(`file '${clipPaths[6]}'`);
    segments.push(`file '${clipPaths[7]}'`);

    const concatFile = `${tmpDir}/concat.txt`;
    await fs.promises.writeFile(concatFile, segments.join('\n'));

    // Concatenar
    const concatPath = `${tmpDir}/concat.mp4`;
    await new Promise((resolve, reject) => {
      exec(`ffmpeg -f concat -safe 0 -i ${concatFile} -c:v libx264 -pix_fmt yuv420p ${concatPath}`,
        err => err ? reject(err) : resolve());
    });

    // Quemar subtítulos
    const subsArr = typeof subtitles === 'string' ? JSON.parse(subtitles) : subtitles;
    const filters = subsArr.map(s => {
      const clean = s.text
        .replace(/'/g, '\u2019')
        .replace(/:/g, '\\:')
        .replace(/[^\w\s\u00C0-\u024F\u2019\?\!\.\,👇]/g, '');
      return `drawtext=text='${clean}':fontsize=36:fontcolor=white:bordercolor=black:borderw=3:x=(w-text_w)/2:y=h-80:enable='between(t\\,${s.time}\\,${s.time + 5})'`;
    }).join(',');

    const subtitledPath = `${tmpDir}/subtitled.mp4`;
    await new Promise((resolve, reject) => {
      exec(`ffmpeg -i ${concatPath} -vf "${filters}" -c:v libx264 -c:a copy ${subtitledPath}`,
        err => err ? reject(err) : resolve());
    });

    // Mezclar audio
    const outputPath = `${tmpDir}/final.mp4`;
    if (audio_base64) {
      await new Promise((resolve, reject) => {
        exec(`ffmpeg -i ${subtitledPath} -i ${audioPath} \
          -filter_complex "[0:a]volume=0.1[ambient];[1:a]volume=1.0[narration];[ambient][narration]amix=inputs=2:duration=longest[aout]" \
          -map 0:v -map "[aout]" -c:v copy -c:a aac ${outputPath}`,
          err => err ? reject(err) : resolve());
      });
    } else {
      await fs.promises.copyFile(subtitledPath, outputPath);
    }

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', 'attachment; filename="truecrime.mp4"');
    const stream = fs.createReadStream(outputPath);
    stream.pipe(res);
    stream.on('end', () => fs.rm(tmpDir, { recursive: true }, () => {}));

  } catch (err) {
    console.error('Assemble error:', err);
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
