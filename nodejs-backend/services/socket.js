const WebSocket = require('ws');
const logger = require('../config/logger');

let wss;

const initializeWebSocket = (server) => {
  wss = new WebSocket.Server({ server });

  wss.on('connection', (ws) => {
    logger.info('WebSocket client connected');

    ws.on('message', (message) => {
      logger.info(`Received message: ${message}`);
    });

    ws.on('close', () => {
      logger.info('WebSocket client disconnected');
    });
  });
};

const broadcast = (data) => {
  if (!wss) {
    logger.error('WebSocket Server is not initialized');
    return;
  }

  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  });
};

module.exports = { initializeWebSocket, broadcast };
