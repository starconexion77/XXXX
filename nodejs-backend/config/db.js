const mysql = require('mysql2/promise');

const dbConfig = {
  host: '82.180.134.49',
  user: 'u489675971_botStar',
  password: 'r5i6P#1h',
  database: 'u489675971_botStar'
};

const pool = mysql.createPool(dbConfig);

module.exports = {
  query: (sql, params) => pool.execute(sql, params),
  getConnection: () => pool.getConnection(),
};
