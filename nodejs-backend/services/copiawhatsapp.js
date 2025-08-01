const { default: makeWASocket, useMultiFileAuthState, makeInMemoryStore, fetchLatestBaileysVersion, downloadContentFromMessage, DisconnectReason } = require('@whiskeysockets/baileys');
const fs = require('fs');
const path = require('path');
const rimraf = require('rimraf');
const logger = require('../config/logger');
const { broadcast } = require('./socket');
const { incrementMessageCount, checkMessageLimit } = require('../utils/helpers');
const db = require('../config/db');
const { getChatCompletion, convertAudioToText } = require('./openai');
const qr = require('qr-image');
const redisClient = require('../config/redisClient');

const startSock = async (number, userId, res = null) => {
  const authPath = `./auth_info/${number}`;

  if (!fs.existsSync(authPath)) {
    fs.mkdirSync(authPath, { recursive: true });
  }

  const { state, saveCreds } = await useMultiFileAuthState(authPath);
  const store = makeInMemoryStore({ logger });

  const sock = makeWASocket({
    auth: state,
    logger: logger.child({ level: 'debug' }),
    printQRInTerminal: true,
    version: (await fetchLatestBaileysVersion()).version,
    keepAliveIntervalMs: 60000,
    connectTimeoutMs: 60000
  });

  store.bind(sock.ev);

  let qrSent = false;
  let connected = false;

  const sendQrCode = (qrCode) => {
    if (qrCode && res && !qrSent) {
      const qrPng = qr.image(qrCode, { type: 'png' });
      const qrCodePath = path.join(__dirname, '../uploads', `${number}.png`);
      qrPng.pipe(fs.createWriteStream(qrCodePath));

      res.json({ qr_code_url: `http://localhost:3000/uploads/${number}.png` });
      qrSent = true;
      broadcast({ number, message: 'WhatsBoot no está conectado. Por favor, genere un nuevo código QR.' });
    }
  };

  const sendErrorResponse = (message) => {
    if (res && !qrSent) {
      res.status(500).send(message);
      qrSent = true;
    }
  };

  sock.ev.on('connection.update', (update) => {
    const { connection, qr: qrCode, lastDisconnect } = update;

    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut);
      connected = false;
      broadcast({ number, message: 'WhatsBoot no está conectado. Por favor, genere un nuevo código QR.' });
      if (shouldReconnect) {
        logger.info('Reconnecting...');
        startSock(number, userId);
      } else {
        logger.info('Connection closed. Please delete auth_info and generate a new QR code.');
        sendErrorResponse('Connection closed. Unable to generate QR code.');
        rimraf.sync(authPath);
      }
    } else if (qrCode) {
      sendQrCode(qrCode);
      if (!connected) {
        broadcast({ number, message: 'WhatsBoot no está conectado. Por favor, genere un nuevo código QR.' });
      }
    } else if (connection === 'open') {
      logger.info('Connection opened');
      connected = true;
      if (res && !qrSent) {
        res.json({ message: 'Conexión exitosa' });
        qrSent = true;
      }
      broadcast({ number, message: 'Conexión exitosa' });
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type === 'notify') {
      for (const msg of messages) {
        if (!msg.message) continue;

        const chatId = msg.key.remoteJid;
        const senderNumber = msg.key.participant || chatId;
        const isGroup = chatId.endsWith('@g.us');

        if (msg.key.fromMe || msg.key.participant) {
          continue;
        }

        if (isGroup) {
          continue;
        }

        const senderNumberClean = senderNumber.replace('@s.whatsapp.net', '');
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text;

        if (text) {
          const { canSendMessage, message } = await checkMessageLimit(userId);

          if (!canSendMessage) {
            logger.info(`Limit or billing period exceeded for user: ${userId}`);
            await sock.sendMessage(chatId, { text: message });
            continue;
          }

          await sock.sendPresenceUpdate('composing', chatId);

          const connection = await db.getConnection();

          // Recuperar el prompt y otros datos necesarios, incluyendo el id_prom
          const [rows] = await connection.execute('SELECT promp.cod_prom, promp.numcel, promp.prompt, promp.image_url, promp.image_url_1, promp.image_url_2, promp.image_url_3, promp.image_url_4, promp.image_url_5, promp.image_url_6, promp.video_url_1, promp.video_url_2, promp.video_url_3, promp.video_url_4, chatbots.user_id FROM chatbots,promp where promp.numcel = chatbots.number AND chatbots.number = ?', [number]);
          if (rows.length === 0) {
            logger.error('No prompt found for number:', number);
            await connection.release();
            continue;
          }

          const prompt = rows[0].prompt;
          const idProm = rows[0].cod_prom;
          const imageUrls = [
            rows[0].image_url,
            rows[0].image_url_1,
            rows[0].image_url_2,
            rows[0].image_url_3,
            rows[0].image_url_4,
            rows[0].image_url_5,
            rows[0].image_url_6
          ];
          const videoUrls = [
            rows[0].video_url_1,
            rows[0].video_url_2,
            rows[0].video_url_3,
            rows[0].video_url_4
          ];

          // Recuperar el último mensaje significativo del usuario que coincida con el mismo id_prom
          const [lastMessageRow] = await connection.execute(
            'SELECT message FROM messages WHERE sender_number = ? AND id_prom = ? ORDER BY received_at DESC LIMIT 1',
            [senderNumberClean, idProm]
          );

          const lastMessage = lastMessageRow.length > 0 ? lastMessageRow[0].message : null;

          // Recuperar las últimas 5 preguntas y respuestas del usuario con el mismo id_prom
          const [recentMessages] = await connection.execute(
            'SELECT question, message FROM messages WHERE sender_number = ? AND id_prom = ? ORDER BY received_at DESC LIMIT 5',
            [senderNumberClean, idProm]
          );

          // Crear el contexto de la conversación basado en las últimas interacciones
          let conversationContext = '';
          recentMessages.forEach(row => {
            conversationContext += `User: ${row.question}\nBot: ${row.message}\n`;
          });

          // Verificar si el usuario ya fue saludado antes
          if (text.toLowerCase().includes('hola') && lastMessage) {
            const responseMessage = `Ya nos saludamos antes 😊. ${lastMessage}`;
            await sock.sendMessage(chatId, { text: responseMessage });
            await connection.release();
            continue;
          }

          // Manejar respuestas sin contexto
          const lowContextResponses = ["ok", "bien", "sí", "no", "tal vez", "gracias"];
          if (lowContextResponses.includes(text.toLowerCase())) {
            const responseMessage = `Entiendo. ${lastMessage || "¿Hay algo más con lo que te pueda ayudar?"}`;
            await sock.sendMessage(chatId, { text: responseMessage });
            await connection.release();
            continue;
          }

          const response = await getChatCompletion(prompt, conversationContext + text);

          let reply = response;

          // Limitar la respuesta a 100 palabras
          reply = reply.split(' ').slice(0, 100).join(' ');

          // Eliminar cualquier forma de saludo "Hola" o similar al inicio de la respuesta
          reply = reply.replace(/^(hola|¡hola!|hello|hi)\s*[,!?]*\s*/i, '');

          let mediaToSend = null;

          if (reply.includes('[imagen1]')) {
            mediaToSend = { type: 'image', url: imageUrls[0] };
          } else if (reply.includes('[imagen2]')) {
            mediaToSend = { type: 'image', url: imageUrls[1] };
          } else if (reply.includes('[imagen3]')) {
            mediaToSend = { type: 'image', url: imageUrls[2] };
          } else if (reply.includes('[imagen4]')) {
            mediaToSend = { type: 'image', url: imageUrls[3] };
          } else if (reply.includes('[imagen5]')) {
            mediaToSend = { type: 'image', url: imageUrls[4] };
          } else if (reply.includes('[imagen6]')) {
            mediaToSend = { type: 'image', url: imageUrls[5] };
          } else if (reply.includes('[imagen7]')) {
            mediaToSend = { type: 'image', url: imageUrls[6] };
          } else if (reply.includes('[video1]')) {
            mediaToSend = { type: 'video', url: videoUrls[0] };
          } else if (reply.includes('[video2]')) {
            mediaToSend = { type: 'video', url: videoUrls[1] };
          } else if (reply.includes('[video3]')) {
            mediaToSend = { type: 'video', url: videoUrls[2] };
          } else if (reply.includes('[video4]')) {
            mediaToSend = { type: 'video', url: videoUrls[3] };
          }

          await new Promise(resolve => setTimeout(resolve, 3000));

          await sock.sendPresenceUpdate('paused', chatId);

          if (mediaToSend) {
            const mediaMessage = mediaToSend.type === 'image'
              ? { image: { url: mediaToSend.url }, caption: reply.replace(/\[imagen\d\]/, '').trim() }
              : { video: { url: mediaToSend.url }, caption: reply.replace(/\[video\d\]/, '').trim() };

            await sock.sendMessage(chatId, mediaMessage);
          } else {
            await sock.sendMessage(chatId, { text: reply });
          }

          try {
            await connection.execute('INSERT INTO messages (user_id, number, sender_number, id_prom, question, message, type, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, NOW())', [userId, number, senderNumberClean, idProm, text, reply, 'response']);
            await incrementMessageCount(userId);
            logger.info(`Message saved to database: ${reply}`);
          } catch (error) {
            logger.error('Error inserting message into database:', error);
          } finally {
            await connection.release();
          }
        }

        if (msg.message.audioMessage) {
          const { canSendMessage, message } = await checkMessageLimit(userId);

          if (!canSendMessage) {
            logger.info(`Limit or billing period exceeded for user: ${userId}`);
            await sock.sendMessage(chatId, { text: message });
            continue;
          }

          await sock.sendPresenceUpdate('composing', chatId);

          const audioBuffer = await downloadAudioMessage(msg.message.audioMessage);
          const audioText = await convertAudioToText(audioBuffer);

          if (audioText) {
            const connection = await db.getConnection();
            const [rows] = await connection.execute('SELECT promp.cod_prom, promp.prompt, chatbots.user_id FROM chatbots, promp WHERE promp.numcel = chatbots.number AND chatbots.number = ?', [number]);
            await connection.release();

            if (rows.length > 0) {
              const prompt = rows[0].prompt;
              const userId = rows[0].user_id;
              const idProm = rows[0].cod_prom;

              const response = await getChatCompletion(prompt, audioText);

              let replyText = response;

              // Limitar la respuesta a 100 palabras
              replyText = replyText.split(' ').slice(0, 100).join(' ');

              // Eliminar cualquier saludo "Hola" o similar
              replyText = replyText.replace(/^(hola|¡hola!|hello|hi)\s*[,!?]*\s*/i, '');

              await sock.sendMessage(chatId, { text: replyText });

              try {
                await connection.execute('INSERT INTO messages (user_id, number, sender_number, id_prom, question, message, type, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, NOW())', [userId, number, senderNumberClean, idProm, audioText, replyText, 'response']);
                await incrementMessageCount(userId);
                logger.info(`Audio message saved to database: ${replyText}`);
              } catch (error) {
                logger.error('Error inserting audio message into database:', error);
              }
            }
          } else {
            await sock.sendMessage(chatId, { text: 'Lo siento, no pude convertir el audio a texto en este momento.' });
          }

          await sock.sendPresenceUpdate('paused', chatId);
        }
      }
    }
  });

  sock.ev.on('connection.error', (error) => {
    logger.error('Connection error', JSON.stringify(error, null, 2));
    sendErrorResponse('Connection error. Unable to generate QR code.');
  });

  global.sockets[number] = sock;
};

// Función para descargar el audio del mensaje
const downloadAudioMessage = async (message) => {
  const stream = await downloadContentFromMessage(message, 'audio');
  let buffer = Buffer.from([]);

  for await (const chunk of stream) {
    buffer = Buffer.concat([buffer, chunk]);
  }

  return buffer;
};

module.exports = { startSock };
