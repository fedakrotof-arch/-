const express = require('express');
const cookieParser = require('cookie-parser');
const { Pool } = require('pg');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// Подключение к базе данных Neon через переменную окружения
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const sessions = {};

// ═══════════════════════════════════════════════════════
// ИНИЦИАЛИЗАЦИЯ БАЗЫ ДАННЫХ
// ═══════════════════════════════════════════════════════
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      login VARCHAR(50) PRIMARY KEY,
      password VARCHAR(100) NOT NULL,
      role VARCHAR(20) NOT NULL,
      coins BIGINT DEFAULT 0,
      click_power INTEGER DEFAULT 1
    );
  `);

  const players = [
    ['Krotov',   'Dycuvgd',     'admin'],
    ['helper',  'helper123', 'helper'],
    ['player1', 'qwerty',    'player'],
    ['player2', 'password',  'player'],
    ['dima',    'dima2025',  'player'],
    ['vasya',   'vasya228',  'player']
  ];

  for (const [login, password, role] of players) {
    await pool.query(
      `INSERT INTO users (login, password, role, coins, click_power)
       VALUES ($1, $2, $3, 0, 1)
       ON CONFLICT (login) DO NOTHING`,
      [login, password, role]
    );
  }
  console.log('База данных готова');
}

// ═══════════════════════════════════════════════════════
// MIDDLEWARE
// ═══════════════════════════════════════════════════════
app.use(express.json());
app.use(cookieParser());
app.use(express.static(__dirname, { index: 'index.html' }));

app.use((req, res, next) => {
  console.log(req.method + ' ' + req.url);
  next();
});

function requireAuth(req, res, next) {
  const token = req.cookies.token;
  if (!token || !sessions[token]) {
    return res.status(401).json({ error: 'Не авторизован' });
  }
  req.login = sessions[token];
  next();
}

function requireAdmin(req, res, next) {
  pool.query('SELECT role FROM users WHERE login = $1', [req.login])
    .then(result => {
      if (result.rows.length === 0 || result.rows[0].role !== 'admin') {
        return res.status(403).json({ error: 'Только для админа' });
      }
      next();
    })
    .catch(() => res.status(500).json({ error: 'Ошибка БД' }));
}

function requireStaff(req, res, next) {
  pool.query('SELECT role FROM users WHERE login = $1', [req.login])
    .then(result => {
      const role = result.rows.length > 0 ? result.rows[0].role : '';
      if (role !== 'admin' && role !== 'helper') {
        return res.status(403).json({ error: 'Только для админа или хелпера' });
      }
      next();
    })
    .catch(() => res.status(500).json({ error: 'Ошибка БД' }));
}

// ═══════════════════════════════════════════════════════
// АВТОРИЗАЦИЯ
// ═══════════════════════════════════════════════════════
app.post('/api/login', async (req, res) => {
  const { login, password } = req.body || {};
  if (!login || !password) {
    return res.status(400).json({ error: 'Введите логин и пароль' });
  }

  const result = await pool.query('SELECT * FROM users WHERE login = $1', [login]);
  if (result.rows.length === 0) {
    return res.status(401).json({ error: 'Неверный логин или пароль' });
  }

  const user = result.rows[0];
  if (user.password !== password) {
    return res.status(401).json({ error: 'Неверный логин или пароль' });
  }

  const token = crypto.randomBytes(24).toString('hex');
  sessions[token] = login;

  res.cookie('token', token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000
  });

  res.json({
    ok: true,
    login: user.login,
    role: user.role,
    coins: Number(user.coins),
    clickPower: user.click_power
  });
});

app.post('/api/logout', requireAuth, (req, res) => {
  delete sessions[req.cookies.token];
  res.clearCookie('token');
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════
// ДАННЫЕ
// ═══════════════════════════════════════════════════════
app.get('/api/me', requireAuth, async (req, res) => {
  const result = await pool.query('SELECT * FROM users WHERE login = $1', [req.login]);
  if (result.rows.length === 0) return res.status(401).json({ error: 'Аккаунт не найден' });
  const u = result.rows[0];
  res.json({
    login: u.login,
    role: u.role,
    coins: Number(u.coins),
    clickPower: u.click_power
  });
});

app.post('/api/click', requireAuth, async (req, res) => {
  const result = await pool.query(
    'UPDATE users SET coins = coins + click_power WHERE login = $1 RETURNING coins, click_power',
    [req.login]
  );
  if (result.rows.length === 0) return res.status(401).json({ error: 'Аккаунт не найден' });
  res.json({
    coins: Number(result.rows[0].coins),
    clickPower: result.rows[0].click_power
  });
});

app.get('/api/players', requireAuth, requireStaff, async (req, res) => {
  const result = await pool.query(
    'SELECT login, role, coins, click_power FROM users ORDER BY coins DESC'
  );
  res.json({
    players: result.rows.map(u => ({
      login: u.login,
      role: u.role,
      coins: Number(u.coins),
      clickPower: u.click_power
    }))
  });
});

app.get('/api/top', requireAuth, async (req, res) => {
  const result = await pool.query(
    'SELECT login, coins, click_power FROM users WHERE login != $1 ORDER BY coins DESC LIMIT 1',
    [req.login]
  );
  if (result.rows.length === 0) return res.json({ top: null });
  const u = result.rows[0];
  res.json({
    top: {
      login: u.login,
      coins: Number(u.coins),
      clickPower: u.click_power
    }
  });
});

app.post('/api/set', requireAuth, requireAdmin, async (req, res) => {
  const { login, coins, clickPower } = req.body || {};
  const result = await pool.query(
    'UPDATE users SET coins = $1, click_power = $2 WHERE login = $3 RETURNING login, coins, click_power',
    [Math.max(0, Math.floor(coins)), Math.max(1, Math.floor(clickPower)), login]
  );
  if (result.rows.length === 0) return res.status(400).json({ error: 'Игрок не найден' });
  const u = result.rows[0];
  res.json({
    ok: true,
    login: u.login,
    coins: Number(u.coins),
    clickPower: u.click_power
  });
});

// ═══════════════════════════════════════════════════════
// СТАРТ
// ═══════════════════════════════════════════════════════
initDb().then(() => {
  app.listen(PORT, () => {
    console.log('========================================');
    console.log('Сервер запущен на порту ' + PORT);
    console.log('========================================');
  });
}).catch(err => {
  console.error('Ошибка инициализации БД:', err);
  process.exit(1);
});