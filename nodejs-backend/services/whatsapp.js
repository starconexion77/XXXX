const { default: makeWASocket, useMultiFileAuthState, makeInMemoryStore, fetchLatestBaileysVersion, downloadContentFromMessage, DisconnectReason } = require('@whiskeysockets/baileys');
const fs = require('fs');
const path = require('path');
const rimraf = require('rimraf');
const logger = require('../config/logger');
const { broadcast } = require('./socket');
const { incrementMessageCount, checkMessageLimit } = require('../utils/helpers');
const db = require('../config/db');
const { getChatCompletion } = require('./openai');
const { downloadAudioMessage, convertAudioToText } = require('./media');
const qr = require('qr-image');
const redisClient = require('../config/redisClient');
const { v4: uuidv4 } = require('uuid');

// Sistema de gestión de conversaciones mejorado
const conversations = {};

// Inicializar o obtener un contexto de conversación
const getConversation = (chatId) => {
  if (!conversations[chatId]) {
    conversations[chatId] = {
      state: 'active', // 'active' o 'paused'
      context: [],
      lastQuestion: null,
      lastMediaPrompt: null,
      awaitingResponse: false,
      conversationId: uuidv4()
    };
  }
  return conversations[chatId];
};

// Función para detectar si un mensaje es una respuesta afirmativa simple
const isAffirmativeResponse = (text) => {
  const affirmativeResponses = ['sí', 'si', 'yes', 'ok', 'claro', 'por supuesto', 'dale', 'bueno', 'está bien'];
  return affirmativeResponses.includes(text.toLowerCase().trim());
};

// Función para detectar si un mensaje es una respuesta negativa simple
const isNegativeResponse = (text) => {
  const negativeResponses = ['no', 'nope', 'para nada', 'no gracias', 'no quiero'];
  return negativeResponses.includes(text.toLowerCase().trim());
};

// Función para extraer etiquetas de medios de un mensaje
const extractMediaTags = (message) => {
  const imageTags = Array.from(message.matchAll(/\[imagen[1-7]\]/g)).map(match => match[0]);
  const videoTags = Array.from(message.matchAll(/\[video[1-4]\]/g)).map(match => match[0]);
  
  return [...imageTags, ...videoTags];
};

// Función para detectar si un mensaje contiene una pregunta
const containsQuestion = (text) => {
  return text.includes('?') || text.includes('¿');
};

// Función para procesar respuestas con medios
const processMediaResponse = async (sock, chatId, reply, rows) => {
  // Mapear las etiquetas a sus URLs
  const mediaMap = {
    '[imagen1]': { type: 'image', url: rows.image_url },
    '[imagen2]': { type: 'image', url: rows.image_url_1 },
    '[imagen3]': { type: 'image', url: rows.image_url_2 },
    '[imagen4]': { type: 'image', url: rows.image_url_3 },
    '[imagen5]': { type: 'image', url: rows.image_url_4 },
    '[imagen6]': { type: 'image', url: rows.image_url_5 },
    '[imagen7]': { type: 'image', url: rows.image_url_6 },
    '[video1]': { type: 'video', url: rows.video_url_1 },
    '[video2]': { type: 'video', url: rows.video_url_2 },
    '[video3]': { type: 'video', url: rows.video_url_3 },
    '[video4]': { type: 'video', url: rows.video_url_4 }
  };

  // Buscar etiquetas de medios en la respuesta
  const mediaTags = extractMediaTags(reply);
  
  if (mediaTags.length === 0) {
    // No se encontraron etiquetas de medios, enviar solo texto
    await sock.sendMessage(chatId, { text: reply });
    return;
  }

  // Procesar cada etiqueta de medios encontrada
  for (const tag of mediaTags) {
    const media = mediaMap[tag];
    
    if (!media || !media.url) {
      continue; // Omitir si no se encuentra medio para esta etiqueta
    }
    
    // Reemplazar la etiqueta actual en el mensaje
    const cleanReply = reply.replace(tag, '').trim();
    
    try {
      const mediaMessage = {
        [media.type]: { url: media.url },
        caption: cleanReply
      };
      
      await sock.sendMessage(chatId, mediaMessage);
      logger.info(`Mensaje de medios enviado correctamente: ${media.type}`);
      
      // Almacenar el medio enviado como contexto
      const conversation = getConversation(chatId);
      conversation.lastMediaPrompt = tag;
      
      // Hemos enviado el medio, así que retornamos
      return;
    } catch (error) {
      logger.error(`Error al enviar mensaje de medios para la etiqueta ${tag}:`, error);
      // Continuar para probar otros medios o recurrir a texto
    }
  }
  
  // Retroceder a texto si todos los envíos de medios fallaron
  await sock.sendMessage(chatId, { text: reply });
};

// Función para procesar respuestas OpenAI con contexto
const processOpenAIResponse = async (chatId, message, number, userId, senderNumberClean, sock, conversation) => {
  const connection = await db.getConnection();
  try {
    const [rows] = await connection.execute(
      'SELECT promp.cod_prom, promp.prompt, promp.image_url, promp.image_url_1, promp.image_url_2, promp.image_url_3, promp.image_url_4, promp.image_url_5, promp.image_url_6, promp.video_url_1, promp.video_url_2, promp.video_url_3, promp.video_url_4, chatbots.user_id FROM chatbots, promp WHERE promp.numcel = chatbots.number AND chatbots.number = ?',
      [number]
    );

    if (rows.length === 0) {
      logger.error('No prompt found for number:', number);
      return;
    }

    const prompt = rows[0].prompt;
    const idProm = rows[0].cod_prom;

    // Construir prompt con contexto
    let contextualPrompt = prompt + "\n\n" + message;

    let response = await getChatCompletion(contextualPrompt, message);
    
    // Procesar respuesta como antes
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

    // Verificar si hay preguntas en la respuesta
    if (containsQuestion(reply)) {
      conversation.lastQuestion = reply;
      conversation.awaitingResponse = true;
      
      // Verificar si la pregunta menciona medios
      const mediaTags = extractMediaTags(reply);
      if (mediaTags.length > 0) {
        conversation.lastMediaPrompt = mediaTags[0];
      } else {
        conversation.lastMediaPrompt = null;
      }
    } else {
      conversation.lastQuestion = null;
      conversation.awaitingResponse = false;
      conversation.lastMediaPrompt = null;
    }

    // Procesar y enviar medios
    await processMediaResponse(sock, chatId, reply, rows[0]);
    
    // Agregar al contexto
    conversation.context.push({
      role: 'assistant',
      content: reply
    });

    // Guardar en la base de datos
    await connection.execute(
      'INSERT INTO messages (user_id, number, sender_number, id_prom, question, message, type, received_at, conversation_id) VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), ?)',
      [userId, number, senderNumberClean, idProm, message, reply, 'response', conversation.conversationId]
    );
    
    await incrementMessageCount(userId);

  } catch (error) {
    logger.error('Error en processOpenAIResponse:', error);
    
  } finally {
    await connection.release();
  }
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
        const senderNumberClean = senderNumber.replace(/[^0-9]/g, '');
        const isGroup = chatId.endsWith('@g.us');

        if (isGroup) {
          continue;
        }

        // Obtener o inicializar contexto de conversación
        const conversation = getConversation(chatId);

        let text = msg.message.conversation || msg.message.extendedTextMessage?.text;
        
        // Corrige el manejo de mensajes de audio en el evento messages.upsert
// Reemplaza el bloque de código actual de procesamiento de audio con este:
// Actualiza este bloque en tu archivo principal para manejar correctamente los mensajes de audio

// Reemplaza el bloque de manejo de audio en tu archivo principal con este código

// Reemplaza el bloque de manejo de audio en tu archivo principal con este código

// Manejo de mensajes de audio
if (msg.message.audioMessage) {
  try {
    // Indicar que estamos escribiendo/grabando sin enviar un mensaje
    await sock.sendPresenceUpdate('recording', chatId);
    
    logger.info('Procesando mensaje de audio:', {
      mimetype: msg.message.audioMessage.mimetype,
      seconds: msg.message.audioMessage.seconds,
      fileLength: msg.message.audioMessage.fileLength
    });
    
    // Descargar el audio con metadata (sin notificar al usuario)
    const audioData = await downloadAudioMessage(msg.message.audioMessage);
    logger.info('Audio descargado correctamente:', { 
      size: audioData.buffer.length,
      mimetype: audioData.mimetype,
      path: audioData.path
    });
    
    // Transcribir el audio sin notificar al usuario
    const apiKey = "sk-v1sLERgwDDBja_qN5wHyFM1JVpWncWRLc2IBvyJWXST3BlbkFJhERoWyvZTcPM9r8IYyVZKQz98LOTjJi33vzsMMluYA";
    logger.info('Usando API key para transcripción');
    
    const transcribedText = await convertAudioToText(audioData, apiKey);
    
    if (!transcribedText || transcribedText.trim().length === 0) {
      throw new Error('TRANSCRIPTION_EMPTY');
    }

    // Usar directamente el texto transcrito sin mostrar la transcripción
    text = transcribedText;
    logger.info('Audio transcrito exitosamente:', { text: transcribedText });
    
    // Continuar con el flujo normal de procesamiento de mensajes usando el texto transcrito
    // No necesitamos hacer nada más aquí, ya que el código siguiente
    // procesará 'text' como si fuera un mensaje de texto normal
  } catch (error) {
    logger.error('Error en procesamiento de audio:', {
      error: error.message,
      details: error.response?.data,
      stack: error.stack
    });
    
    let errorMessage;
    switch(error.message) {
      case 'API_KEY_NOT_CONFIGURED':
        errorMessage = 'Error de configuración del servicio. Por favor, contacta al administrador.';
        break;
      case 'API_KEY_INVALID':
        errorMessage = 'Error de autenticación del servicio. Por favor, contacta al administrador.';
        break;
      case 'TRANSCRIPTION_EMPTY':
        errorMessage = 'No se pudo extraer texto del audio. Por favor, intenta con un audio más claro.';
        break;
      case 'AUDIO_FILE_TOO_LARGE':
        errorMessage = 'El audio es demasiado largo. Por favor, envía un mensaje más corto.';
        break;
      case 'RATE_LIMIT_EXCEEDED':
        errorMessage = 'Hemos alcanzado el límite de solicitudes. Por favor, intenta más tarde.';
        break;
      case 'AUDIO_FILE_NOT_FOUND':
        errorMessage = 'Hubo un problema al procesar el archivo de audio. Por favor, intenta de nuevo.';
        break;
      default:
        errorMessage = 'Hubo un problema al procesar el audio. Por favor, intenta de nuevo.';
    }
    
    await sock.sendMessage(chatId, { text: errorMessage });
    continue;
  }
}

        console.log('Número del remitente:', senderNumber, 'Mensaje:', text);

        // Manejar comandos
        if (text === '/agente') {
          conversation.state = 'paused';
          await sock.sendMessage(chatId, { text: 'Cambiando de Operador! Un agente humano atenderá tu consulta pronto.' });
          continue;
        } else if (text === '/boot') {
          conversation.state = 'active';
          await sock.sendMessage(chatId, { text: 'Chatbot reanudado. ¿En qué puedo ayudarte?' });
          continue;
        }

        if (conversation.state === 'paused') {
          console.log('La conversación está en pausa para chatId:', chatId);
          continue;
        }

        if (text) {
          // Verificar límites de mensajes
          const { canSendMessage, message } = await checkMessageLimit(userId);

          if (!canSendMessage) {
            logger.info(`Limit or billing period exceeded for user: ${userId}`);
            await sock.sendMessage(chatId, { text: message });
            continue;
          }

          await sock.sendPresenceUpdate('composing', chatId);

          // Manejar respuestas simples a preguntas anteriores
          if (conversation.awaitingResponse && conversation.lastQuestion) {
            if (isAffirmativeResponse(text)) {
              // El usuario respondió afirmativamente a nuestra última pregunta
              if (conversation.lastMediaPrompt) {
                // Dijeron que sí a un prompt de medios, enviar los medios
                const connection = await db.getConnection();
                try {
                  const [rows] = await connection.execute(
                    'SELECT promp.cod_prom, promp.prompt, promp.image_url, promp.image_url_1, promp.image_url_2, promp.image_url_3, promp.image_url_4, promp.image_url_5, promp.image_url_6, promp.video_url_1, promp.video_url_2, promp.video_url_3, promp.video_url_4, chatbots.user_id FROM chatbots, promp WHERE promp.numcel = chatbots.number AND chatbots.number = ?',
                    [number]
                  );

                  if (rows.length > 0) {
                    const mediaTag = conversation.lastMediaPrompt;
                    const mediaMap = {
                      '[imagen1]': { type: 'image', url: rows[0].image_url },
                      '[imagen2]': { type: 'image', url: rows[0].image_url_1 },
                      '[imagen3]': { type: 'image', url: rows[0].image_url_2 },
                      '[imagen4]': { type: 'image', url: rows[0].image_url_3 },
                      '[imagen5]': { type: 'image', url: rows[0].image_url_4 },
                      '[imagen6]': { type: 'image', url: rows[0].image_url_5 },
                      '[imagen7]': { type: 'image', url: rows[0].image_url_6 },
                      '[video1]': { type: 'video', url: rows[0].video_url_1 },
                      '[video2]': { type: 'video', url: rows[0].video_url_2 },
                      '[video3]': { type: 'video', url: rows[0].video_url_3 },
                      '[video4]': { type: 'video', url: rows[0].video_url_4 }
                    };

                    const media = mediaMap[mediaTag];
                    if (media && media.url) {
                      await sock.sendMessage(chatId, {
                        [media.type]: { url: media.url },
                        caption: '¡Aquí tienes! ¿Hay algo más en lo que pueda ayudarte?'
                      });
                      
                      // Agregar al contexto
                      conversation.context.push({
                        role: 'assistant',
                        content: `Mostró ${media.type}: ${mediaTag}`
                      });
                      
                      // Guardar en la base de datos
                      await connection.execute(
                        'INSERT INTO messages (user_id, number, sender_number, id_prom, question, message, type, received_at, conversation_id) VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), ?)',
                        [userId, number, senderNumberClean, rows[0].cod_prom, text, `Envió ${media.type} en respuesta a una afirmación`, 'response', conversation.conversationId]
                      );
                      
                      await incrementMessageCount(userId);
                    }
                  }
                } catch (error) {
                  logger.error('Error al procesar respuesta de medios:', error);
                  await sock.sendMessage(chatId, { text: 'Lo siento, hubo un problema al mostrar el contenido que solicitaste.' });
                } finally {
                  await connection.release();
                }
              } else {
                // Dijeron que sí a un tipo diferente de pregunta, generar respuesta contextual
                const contextMessage = `El usuario respondió afirmativamente a mi pregunta: "${conversation.lastQuestion}". Debo continuar la conversación de forma natural sin repetir la información anterior. ¿Cuál sería una buena respuesta de seguimiento?`;
                
                // Agregar este contexto a nuestra conversación
                conversation.context.push({
                  role: 'user',
                  content: 'Sí'
                });
                
                // Procesar con OpenAI con contexto específico
                await processOpenAIResponse(
                  chatId, 
                  contextMessage, 
                  number, 
                  userId, 
                  senderNumberClean, 
                  sock, 
                  conversation
                );
              }
              
              // Reiniciar el indicador de espera de respuesta
              conversation.awaitingResponse = false;
              conversation.lastQuestion = null;
              
              continue;
            } else if (isNegativeResponse(text)) {
              // Manejar respuesta negativa
              const contextMessage = `El usuario respondió negativamente a mi pregunta: "${conversation.lastQuestion}". Debo responder adecuadamente y ofrecer alternativas o continuar la conversación de manera natural.`;
              
              // Agregar al contexto
              conversation.context.push({
                role: 'user',
                content: 'No'
              });
              
              // Procesar con OpenAI
              await processOpenAIResponse(
                chatId, 
                contextMessage, 
                number, 
                userId, 
                senderNumberClean, 
                sock, 
                conversation
              );
              
              // Reiniciar
              conversation.awaitingResponse = false;
              conversation.lastQuestion = null;
              
              continue;
            }
            // Si llegamos aquí, el usuario no dio un simple sí/no, así que procesaremos normalmente
          }

          // Procesamiento normal de mensajes
          const connection = await db.getConnection();
          try {
            const [rows] = await connection.execute(
              'SELECT promp.cod_prom, promp.prompt, promp.image_url, promp.image_url_1, promp.image_url_2, promp.image_url_3, promp.image_url_4, promp.image_url_5, promp.image_url_6, promp.video_url_1, promp.video_url_2, promp.video_url_3, promp.video_url_4, chatbots.user_id FROM chatbots, promp WHERE promp.numcel = chatbots.number AND chatbots.number = ?',
              [number]
            );

            if (rows.length === 0) {
              logger.error('No prompt found for number:', number);
              continue;
            }

            const prompt = rows[0].prompt;
            const idProm = rows[0].cod_prom;

            // Agregar mensaje del usuario al contexto
            conversation.context.push({
              role: 'user',
              content: text
            });

            // Construir prompt con contexto
            let contextualPrompt = prompt;
            if (conversation.context.length > 1) {
              contextualPrompt += "\n\nHistorial de la conversación:\n";
              // Agregar los últimos mensajes para contexto (limitar para evitar desbordamiento de tokens)
              const recentContext = conversation.context.slice(-5);
              for (const ctx of recentContext) {
                contextualPrompt += `${ctx.role === 'user' ? 'Usuario' : 'Asistente'}: ${ctx.content}\n`;
              }
            }

            let response = await getChatCompletion(contextualPrompt, text);
            
            // Recortar a longitud razonable (primeras 200 palabras, completar la oración)
            let reply = response.split(' ').slice(0, 200).join(' ');
            if (!/[.!?]$/.test(reply.trim())) {
              const remainingWords = response.split(' ').slice(200).join(' ');
              const nextSentence = remainingWords.match(/^.*?[.!?]/);
              if (nextSentence) {
                reply += ' ' + nextSentence[0];
              }
            }

            // Limpiar la respuesta
            reply = reply.replace(/^(hola|¡hola!|hello|hi)\s*[,!?]*\s*/i, '')
              .replace(/User:\s*/g, '')
              .replace(/Bot:\s*/g, '')
              .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$2');

            // Verificar si la respuesta contiene una pregunta
            if (containsQuestion(reply)) {
              conversation.lastQuestion = reply;
              conversation.awaitingResponse = true;
              
              // Verificar si la pregunta menciona medios
              const mediaTags = extractMediaTags(reply);
              if (mediaTags.length > 0) {
                conversation.lastMediaPrompt = mediaTags[0]; // Recordar qué medio se ofreció
              } else {
                conversation.lastMediaPrompt = null;
              }
            } else {
              conversation.lastQuestion = null;
              conversation.awaitingResponse = false;
              conversation.lastMediaPrompt = null;
            }

            // Procesar y enviar la respuesta con medios si están presentes
            await processMediaResponse(sock, chatId, reply, rows[0]);
            
            // Agregar respuesta del asistente al contexto
            conversation.context.push({
              role: 'assistant',
              content: reply
            });

            // Guardar mensaje en la base de datos
            await connection.execute(
              'INSERT INTO messages (user_id, number, sender_number, id_prom, question, message, type, received_at, conversation_id) VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), ?)',
              [userId, number, senderNumberClean, idProm, text, reply, 'response', conversation.conversationId]
            );
            
            await incrementMessageCount(userId);
            logger.info(`Message saved to database: ${reply}`);

          } catch (error) {
            logger.error('Error processing message:', error);
            
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