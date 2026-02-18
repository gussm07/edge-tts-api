const express = require('express');
const edgeTTS = require('edge-tts');
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
    const tts = new edgeTTS.EdgeTTS();
    await tts.tts(text, voice, outputPath);

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    const stream = fs.createReadStream(outputPath);
    stream.pipe(res);

    stream.on('end', () => {
      fs.unlink(outputPath, () => {});
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Edge TTS API corriendo en puerto ${PORT}`));