const express = require('express');
const cookieParser = require('cookie-parser');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const USERS_FILE = path.join(__dirname, 'users.json');
const SESSIONS_FILE = path.join(__dirname, 'sessions.json');

// ═══════════════════════════════════════════════════════
// ХРАНИЛИЩЕ СЕССИЙ (сохраняется в файл)
// ═══════════════════════════════════════════════════════
let sessions = {};

function loadSessions() {
  try {
    if (fs.existsSync(SESSIONS_FILE)) {
      const raw = fs.readFileSync(SESSIONS_FILE, 'utf8');
      sessions = JSON.parse(raw);
    }
  } catch (e) {
    console.error('sessions.json не прочитан:', e.message);
    sessions = {};
  }
}

function saveSessions() {
  try {
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2), 'utf8');
  } catch (e) {
    console.error('sessions.json не сохранён:', e.message);
  }
}

// ═══════════════════════════════════════════════════════
// РАБОТА С ФАЙЛОМ ПОЛЬЗОВАТЕЛЕЙ
// ═══════════════════════════════════════════════════════
function loadUsers() {
  try {
    const raw = fs.readFileSync(USERS_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    console.error('users.json не прочитан:', e.message);
    return {};
  }
}

function saveUsers(users) {
  try {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf8');
  } catch (e) {
    console.error('users.json не сохранён:', e.message);
  }
}

// Загружаем сессии при старте
loadSessions();

// ═══════════════════════════════════════════════════════
// MIDDLEWARE
// ═══════════════════════════════════════════════════════
app.use(express.json());
app.use(cookieParser());
app.use(express.static(__dirname, { index: 'index.html' }));

// Простое логирование запросов
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
  const users = loadUsers();
  const u = users[req.login];
  if (!u || u.role !== 'admin') {
    return res.status(403).json({ error: 'Только для админа' });
  }
  next();
}

function requireStaff(req, res, next) {
  const users = loadUsers();
  const u = users[req.login];
  if (!u || (u.role !== 'admin' && u.role !== 'helper')) {
    return res.status(403).json({ error: 'Только для админа или хелпера' });
  }
  next();
}

// ═══════════════════════════════════════════════════════
// АВТОРИЗАЦИЯ
// ═══════════════════════════════════════════════════════
app.post('/api/login', (req, res) => {
  const { login, password } = req.body || {};
  console.log('Попытка входа:', login);

  if (!login || !password) {
    return res.status(400).json({ error: 'Введите логин и пароль' });
  }

  const users = loadUsers();
  const user = users[login];
  if (!user) {
    console.log('  ✗ Логин не найден');
    return res.status(401).json({ error: 'Неверный логин или пароль' });
  }

  if (user.password !== password) {
    console.log('  ✗ Неверный пароль');
    return res.status(401).json({ error: 'Неверный логин или пароль' });
  }

  console.log('  ✓ Успешный вход');

  const token = crypto.randomBytes(24).toString('hex');
  sessions[token] = login;
  saveSessions();

  res.cookie('token', token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000
  });

  res.json({
    ok: true,
    login: login,
    role: user.role,
    coins: user.coins,
    clickPower: user.clickPower
  });
});

app.post('/api/logout', requireAuth, (req, res) => {
  const token = req.cookies.token;
  delete sessions[token];
  saveSessions();
  res.clearCookie('token');
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════
// ТЕКУЩИЙ ИГРОК
// ═══════════════════════════════════════════════════════
app.get('/api/me', requireAuth, (req, res) => {
  const users = loadUsers();
  const u = users[req.login];
  if (!u) return res.status(401).json({ error: 'Аккаунт не найден' });

  res.json({
    login: req.login,
    role: u.role,
    coins: u.coins,
    clickPower: u.clickPower
  });
});

// ═══════════════════════════════════════════════════════
// КЛИК
// ═══════════════════════════════════════════════════════
app.post('/api/click', requireAuth, (req, res) => {
  const users = loadUsers();
  const u = users[req.login];
  if (!u) return res.status(401).json({ error: 'Аккаунт не найден' });

  u.coins += u.clickPower;
  saveUsers(users);

  res.json({ coins: u.coins, clickPower: u.clickPower });
});

// ═══════════════════════════════════════════════════════
// СПИСОК ИГРОКОВ
// ═══════════════════════════════════════════════════════
app.get('/api/players', requireStaff, (req, res) => {
  const users = loadUsers();
  const list = Object.keys(users).map(login => ({
    login: login,
    role: users[login].role,
    coins: users[login].coins,
    clickPower: users[login].clickPower
  }));

  list.sort((a, b) => b.coins - a.coins);
  res.json({ players: list });
});

// ═══════════════════════════════════════════════════════
// ТОП-1
// ═══════════════════════════════════════════════════════
app.get('/api/top', requireAuth, (req, res) => {
  const users = loadUsers();
  let best = null;

  for (const login in users) {
    if (login === req.login) continue;
    const u = users[login];
    if (!best || u.coins > best.coins) {
      best = { login: login, coins: u.coins, clickPower: u.clickPower };
    }
  }

  res.json({ top: best });
});

// ═══════════════════════════════════════════════════════
// ИЗМЕНЕНИЕ ДАННЫХ (только админ)
// ═══════════════════════════════════════════════════════
app.post('/api/set', requireAuth, requireAdmin, (req, res) => {
  const { login, coins, clickPower } = req.body || {};
  const users = loadUsers();

  if (!login || !Object.prototype.hasOwnProperty.call(users, login)) {
    return res.status(400).json({ error: 'Игрок не найден' });
  }

  const u = users[login];

  if (typeof coins === 'number' && coins >= 0) u.coins = Math.floor(coins);
  if (typeof clickPower === 'number' && clickPower >= 1) u.clickPower = Math.floor(clickPower);

  saveUsers(users);

  res.json({ ok: true, login: login, coins: u.coins, clickPower: u.clickPower });
});

// ═══════════════════════════════════════════════════════
// СТАРТ
// ═══════════════════════════════════════════════════════
app.listen(PORT, () => {
  console.log('========================================');
  console.log('Сервер запущен на порту ' + PORT);
  console.log('========================================');
});