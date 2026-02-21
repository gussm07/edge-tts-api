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
      const { exec } = require('child_process');
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