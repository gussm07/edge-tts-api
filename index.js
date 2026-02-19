const express = require('express');
const app = express();
app.use(express.json({ limit: '10mb' }));

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
    console.error('Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Obtiene el access token del service account de Cloud Run automáticamente
async function getAccessToken() {
  const response = await fetch(
    'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
    { headers: { 'Metadata-Flavor': 'Google' } }
  );
  const data = await response.json();
  return data.access_token;
}

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`TTS API corriendo en puerto ${PORT}`));