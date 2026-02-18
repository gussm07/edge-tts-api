const express = require('express');
const { MsEdgeTTS, OUTPUT_FORMAT } = require('edge-tts-node');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '10mb' }));

app.post('/tts', async (req, res) => {
  const { text, voice = 'es-MX-JorgeNeural' } = req.body;

  if (!text) {
    return res.status(400).json({ error: 'text is required' });
  }

  const filename = crypto.randomUUID() + '.mp3';
  const outputPath = path.join('/tmp', filename);

  try {
    const tts = new MsEdgeTTS();
    await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);
    const readable = await tts.toStream(text);

    const writeStream = fs.createWriteStream(outputPath);
    readable.pipe(writeStream);

    writeStream.on('finish', () => {
      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      const readStream = fs.createReadStream(outputPath);
      readStream.pipe(res);
      readStream.on('end', () => fs.unlink(outputPath, () => {}));
    });

    writeStream.on('error', (err) => {
      console.error(err);
      res.status(500).json({ error: err.message });
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Edge TTS API corriendo en puerto ${PORT}`));