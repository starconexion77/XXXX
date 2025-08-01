const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { startSock } = require('./services/whatsapp');
const { initializeWebSocket } = require('./services/socket');
const { loadPromptsAndMediaFromDB } = require('./utils/helpers');
const logger = require('./config/logger');
const db = require('./config/db');


global.sockets = {}; 
const app = express();
app.use(express.json());

const server = http.createServer(app);
initializeWebSocket(server);

app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

app.post('/create-bot', async (req, res) => {
  const { user_id, number } = req.body;

  const [userRows] = await db.query('SELECT id FROM users WHERE id = ?', [user_id]);

  if (userRows.length === 0) {
    res.status(400).send({ error: 'El user_id proporcionado no existe en la tabla users.' });
    return;
  }

  startSock(number, user_id, res);
});

app.post('/regenerate_qr', async (req, res) => {
  const { number } = req.body;
  
  if (!number) {
    return res.status(400).json({ error: 'Number is required' });
  }
  
  const authPath = `./auth_info/${number}`;
  
  if (fs.existsSync(authPath)) {
    rimraf.sync(authPath);
  }

  startSock(number, null, res);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
  logger.info(`API running on port ${PORT}`);

  const { prompts, images, videos } = await loadPromptsAndMediaFromDB();
  global.prompts = prompts;
  global.images = images;
  global.videos = videos;

  const bots = fs.readdirSync('./auth_info');
  for (const bot of bots) {
    const [rows] = await db.query('SELECT user_id FROM chatbots WHERE number = ?', [bot]);

    if (rows.length > 0) {
      const userId = rows[0].user_id;
      startSock(bot, userId);
      logger.info(`Loaded prompt for ${bot}: ${global.prompts[bot]}`);
    }
  }
});

process.on('SIGINT', () => {
  logger.info('Process interrupted, closing gracefully...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  logger.info('Process terminated, closing gracefully...');
  process.exit(0);
});
