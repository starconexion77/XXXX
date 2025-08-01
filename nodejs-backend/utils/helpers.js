const db = require('../config/db');
const logger = require('../config/logger');

const incrementMessageCount = async (userId) => {
  const connection = await db.getConnection();
  try {
    await connection.execute('UPDATE users SET msn = msn + 1 WHERE id = ?', [userId]);
  } finally {
    await connection.release();
  }
};

const checkMessageLimit = async (userId) => {
  const connection = await db.getConnection();
  try {
    const [userRows] = await connection.execute('SELECT id_plan, msn, fecha_inicio, fecha_fin FROM users WHERE id = ?', [userId]);

    if (userRows.length > 0) {
      const idPlan = userRows[0].id_plan;
      let userMessages = userRows[0].msn;
      const fechaInicio = new Date(userRows[0].fecha_inicio);
      const fechaFin = new Date(userRows[0].fecha_fin);
      const fechaActual = new Date();

      userMessages = Number(userMessages);
      logger.debug('User Messages:', userMessages, 'Type:', typeof userMessages);

      const [planRows] = await connection.execute('SELECT planes.message FROM planes WHERE planes.id_plan = ?', [idPlan]);

      if (planRows.length > 0) {
        let maxMessages = Number(planRows[0].message);
        logger.debug('Max Messages:', maxMessages, 'Type:', typeof maxMessages);
        logger.debug('Comparing:', userMessages, '>=', maxMessages);

        if (userMessages >= maxMessages) {
          logger.info('User has exceeded the number of messages');
          return { canSendMessage: false, message: 'Has superado el número de mensajes permitidos.' };
        }

        if (fechaActual < fechaInicio || fechaActual > fechaFin) {
          return { canSendMessage: false, message: 'Tu período de facturación ha vencido. Debes renovar tu plan.' };
        }

        return { canSendMessage: true };
      }
    }
  } finally {
    await connection.release();
  }
  return { canSendMessage: false, message: 'Error verificando el límite de mensajes o el período de facturación.' };
};

const loadPromptsAndMediaFromDB = async () => {
  const connection = await db.getConnection();
  const [rows] = await connection.execute(
    `SELECT promp.numcel, promp.prompt, promp.image_url, promp.image_url_1, 
            promp.image_url_2, promp.image_url_3, promp.image_url_4, 
            promp.image_url_5, promp.image_url_6, promp.video_url_1, 
            promp.video_url_2, promp.video_url_3, promp.video_url_4 
     FROM chatbots, promp 
     WHERE promp.numcel = chatbots.number`
  );
  await connection.release();

  const prompts = {};
  const images = {};
  const videos = {};
  rows.forEach(row => {
    prompts[row.numcel] = row.prompt;
    images[row.numcel] = [
      row.image_url, row.image_url_1, row.image_url_2,
      row.image_url_3, row.image_url_4, row.image_url_5,
      row.image_url_6
    ];
    videos[row.numcel] = [
      row.video_url_1, row.video_url_2, row.video_url_3, row.video_url_4
    ];
  });
  return { prompts, images, videos };
};

module.exports = {
  incrementMessageCount,
  checkMessageLimit,
  loadPromptsAndMediaFromDB,
};
