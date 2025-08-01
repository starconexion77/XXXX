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

const conversationStates = {}; // { chatId: 'paused' or 'active' }

const isGenericResponse = (text) => {
    const genericResponses = ['sí', 'no', 'ok', 'bueno', 'vale', 'entendido'];
    return genericResponses.includes(text.toLowerCase());
};

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

            if (isGroup) {
                continue; // Ignora mensajes en grupos
            }

            const text = msg.message.conversation || msg.message.extendedTextMessage?.text;

            console.log('Número del remitente:', senderNumber, 'Mensaje:', text);

            // Comprobar comandos para pausar y reanudar
            if (text === '/agente') {
                conversationStates[chatId] = 'paused'; // Pausar para toda la conversación
                await sock.sendMessage(chatId, { text: 'Cambiando de Operador!!.' });
                continue; // Detener el procesamiento de mensajes normales
            } else if (text === '/boot') {
                conversationStates[chatId] = 'active'; // Reanudar para toda la conversación
                await sock.sendMessage(chatId, { text: 'Reanudado su operación en esta conversación.' });
                continue; // Reanuda el procesamiento de mensajes normales
            }

            // Verificar si la conversación está en pausa
            if (conversationStates[chatId] === 'paused') {
                console.log('La conversación está en pausa para chatId:', chatId);
                continue; // Ignorar mensajes mientras está pausado
            }

                if (text) {
                    const { canSendMessage, message } = await checkMessageLimit(userId);

                    if (!canSendMessage) {
                        logger.info(`Limit or billing period exceeded for user: ${userId}`);
                        await sock.sendMessage(chatId, { text: message });
                        continue;
                    }

                    await sock.sendPresenceUpdate('composing', chatId);

                    const connection = await db.getConnection();

                    const [rows] = await connection.execute('SELECT promp.cod_prom, promp.prompt, promp.image_url, promp.image_url_1, promp.image_url_2, promp.image_url_3, promp.image_url_4, promp.image_url_5, promp.image_url_6, promp.video_url_1, promp.video_url_2, promp.video_url_3, promp.video_url_4, chatbots.user_id FROM chatbots, promp WHERE promp.numcel = chatbots.number AND chatbots.number = ?', [number]);
                    if (rows.length === 0) {
                        logger.error('No prompt found for number:', number);
                        await connection.release();
                        continue;
                    }

                    const prompt = rows[0].prompt;
                    const idProm = rows[0].cod_prom;

                    let response = await getChatCompletion(prompt, text);

                    let reply = response.split(' ').slice(0, 200).join(' ');

                    if (!/[.!?]$/.test(reply.trim())) {
                        const remainingWords = response.split(' ').slice(200).join(' ');
                        const nextSentence = remainingWords.match(/^.*?[.!?]/);
                        if (nextSentence) {
                            reply += ' ' + nextSentence[0];
                        }
                    }

                    reply = reply.replace(/^(hola|¡hola!|hello|hi)\s*[,!?]*\s*/i, '')
                        .replace(/User:\s*/g, '')
                        .replace(/Bot:\s*/g, '')
                        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$2');

                    let mediaToSend = null;

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

                    

                    if (reply.includes('[imagen1]')) {
                        mediaToSend = { type: 'image', url: imageUrls[0] };
                    } else if (reply.includes('[imagen2]')) {
                        mediaToSend = { type: 'image', url: imageUrls[1] };
                    } else if (reply.includes('[video1]')) {
                        mediaToSend = { type: 'video', url: videoUrls[0] };
                    }

                    if (mediaToSend) {
                        try {
                            let mediaMessage;
                            if (mediaToSend.type === 'image') {
                                mediaMessage = { image: { url: mediaToSend.url }, caption: reply.replace(/\[imagen\d\]/, '').trim() };
                            } else if (mediaToSend.type === 'video') {
                                mediaMessage = { video: { url: mediaToSend.url }, caption: reply.replace(/\[video\d\]/, '').trim() };
                            }
                            await sock.sendMessage(chatId, mediaMessage);
                            logger.info('Mensaje multimedia enviado correctamente.');
                        } catch (error) {
                            logger.error('Error al enviar el mensaje multimedia:', error);
                        }
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
            }
        }
    });

    sock.ev.on('connection.error', (error) => {
        logger.error('Connection error', JSON.stringify(error, null, 2));
        sendErrorResponse('Connection error. Unable to generate QR code.');
    });

    global.sockets[number] = sock;
};

module.exports = { startSock };
