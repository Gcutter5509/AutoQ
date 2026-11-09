import express from 'express';
import { createClient } from '@libsql/client';
import cron from 'node-cron';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static frontend files
app.use('/static', express.static(path.join(__dirname, 'static')));

// Database connection (Turso cloud or local sqlite file fallback)
const dbUrl = process.env.TURSO_DATABASE_URL || 'file:names.db';
const authToken = process.env.TURSO_AUTH_TOKEN || undefined;

const db = createClient({
  url: dbUrl,
  authToken: authToken,
});

// Schedule constants (UTC+5, Mon/Wed/Fri at 14:00)
const CLEANUP_WEEKDAYS = [1, 3, 5]; // 1=Mon, 3=Wed, 5=Fri
const CLEANUP_HOUR = 14;
const CLEANUP_MINUTE = 0;

const RU_WEEKDAYS = {
  0: 'Воскресенье',
  1: 'Понедельник',
  2: 'Вторник',
  3: 'Среда',
  4: 'Четверг',
  5: 'Пятница',
  6: 'Суббота'
};

const RU_MONTHS = {
  0: 'января', 1: 'февраля', 2: 'марта', 3: 'апреля',
  4: 'мая', 5: 'июня', 6: 'июля', 7: 'августа',
  8: 'сентября', 9: 'октября', 10: 'ноября', 11: 'декабря'
};

function getUtc5Date(now = new Date()) {
  return new Date(now.getTime() + 5 * 3600 * 1000);
}

function formatRuDate(utc5Date) {
  const weekday = RU_WEEKDAYS[utc5Date.getUTCDay()];
  const day = utc5Date.getUTCDate();
  const month = RU_MONTHS[utc5Date.getUTCMonth()];
  const hh = String(utc5Date.getUTCHours()).padStart(2, '0');
  const mm = String(utc5Date.getUTCMinutes()).padStart(2, '0');
  return `${weekday}, ${day} ${month} в ${hh}:${mm} (UTC+5)`;
}

function getMostRecentCleanupSlot(utc5Now) {
  let cur = new Date(utc5Now.getTime());
  cur.setUTCHours(CLEANUP_HOUR, CLEANUP_MINUTE, 0, 0);
  if (cur > utc5Now) {
    cur.setUTCDate(cur.getUTCDate() - 1);
  }
  while (!CLEANUP_WEEKDAYS.includes(cur.getUTCDay())) {
    cur.setUTCDate(cur.getUTCDate() - 1);
  }
  return cur;
}

function getNextCleanupSlot(utc5Now) {
  let cur = new Date(utc5Now.getTime());
  cur.setUTCHours(CLEANUP_HOUR, CLEANUP_MINUTE, 0, 0);
  if (cur <= utc5Now) {
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  while (!CLEANUP_WEEKDAYS.includes(cur.getUTCDay())) {
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return cur;
}

// Perform scheduled cleanup if due
async function performCleanupIfDue() {
  const nowUtc5 = getUtc5Date();
  const recentSlot = getMostRecentCleanupSlot(nowUtc5);
  const slotStr = recentSlot.toISOString();

  try {
    const res = await db.execute({
      sql: "SELECT value FROM system_meta WHERE key = 'last_cleanup_slot'",
      args: []
    });
    const lastSlot = res.rows.length > 0 ? String(res.rows[0].value) : '';

    if (lastSlot < slotStr) {
      await db.batch([
        { sql: 'DELETE FROM names', args: [] },
        { sql: "DELETE FROM sqlite_sequence WHERE name = 'names'", args: [] },
        { sql: "INSERT OR REPLACE INTO system_meta (key, value) VALUES ('last_cleanup_slot', ?)", args: [slotStr] },
        { sql: "INSERT OR REPLACE INTO system_meta (key, value) VALUES ('last_cleanup_time', ?)", args: [nowUtc5.toISOString()] }
      ]);
      console.log(`[${formatRuDate(nowUtc5)}] 🧹 Database cleared according to schedule (slot: ${slotStr})`);
      return true;
    }
  } catch (err) {
    // If sqlite_sequence doesn't exist yet, delete names and update slot individually
    try {
      await db.execute('DELETE FROM names');
      await db.execute({
        sql: "INSERT OR REPLACE INTO system_meta (key, value) VALUES ('last_cleanup_slot', ?)",
        args: [slotStr]
      });
      await db.execute({
        sql: "INSERT OR REPLACE INTO system_meta (key, value) VALUES ('last_cleanup_time', ?)",
        args: [nowUtc5.toISOString()]
      });
      console.log(`[${formatRuDate(nowUtc5)}] 🧹 Database cleared according to schedule (fallback slot: ${slotStr})`);
      return true;
    } catch (fallbackErr) {
      console.error('Error during cleanup:', fallbackErr.message);
    }
  }
  return false;
}

// Initialize tables and metadata
async function initDb() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS names (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS system_meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  const curSlot = await db.execute({
    sql: "SELECT value FROM system_meta WHERE key = 'last_cleanup_slot'",
    args: []
  });

  if (curSlot.rows.length === 0) {
    const nowUtc5 = getUtc5Date();
    const slot = getMostRecentCleanupSlot(nowUtc5);
    await db.execute({
      sql: "INSERT OR REPLACE INTO system_meta (key, value) VALUES ('last_cleanup_slot', ?)",
      args: [slot.toISOString()]
    });
  }
}

// Root page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'templates', 'index.html'));
});

// 1. Get list of names and queue status
app.get('/api/names', async (req, res) => {
  try {
    await performCleanupIfDue();
    const nowUtc5 = getUtc5Date();
    const nextSlot = getNextCleanupSlot(nowUtc5);

    const result = await db.execute('SELECT id, name, created_at FROM names ORDER BY id ASC');
    const names = result.rows.map(row => ({
      id: Number(row.id),
      name: String(row.name),
      created_at: String(row.created_at)
    }));

    const yyyy = nowUtc5.getUTCFullYear();
    const MM = String(nowUtc5.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(nowUtc5.getUTCDate()).padStart(2, '0');
    const hh = String(nowUtc5.getUTCHours()).padStart(2, '0');
    const mm = String(nowUtc5.getUTCMinutes()).padStart(2, '0');
    const ss = String(nowUtc5.getUTCSeconds()).padStart(2, '0');
    const serverTime = `${yyyy}-${MM}-${dd} ${hh}:${mm}:${ss} (UTC+5)`;

    res.json({
      success: true,
      count: names.length,
      names: names,
      server_time: serverTime,
      next_cleanup: {
        iso: nextSlot.toISOString(),
        formatted: formatRuDate(nextSlot)
      }
    });
  } catch (err) {
    console.error('Error fetching names:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 2. Add name to queue
app.post('/api/names', async (req, res) => {
  const name = (req.body?.name || '').trim();

  if (!name) {
    return res.status(400).json({ success: false, error: 'Имя не может быть пустым' });
  }
  if (name.length > 100) {
    return res.status(400).json({ success: false, error: 'Имя слишком длинное (максимум 100 символов)' });
  }

  const nowUtc5 = getUtc5Date();
  const dd = String(nowUtc5.getUTCDate()).padStart(2, '0');
  const mm = String(nowUtc5.getUTCMonth() + 1).padStart(2, '0');
  const yyyy = nowUtc5.getUTCFullYear();
  const hh = String(nowUtc5.getUTCHours()).padStart(2, '0');
  const min = String(nowUtc5.getUTCMinutes()).padStart(2, '0');
  const ss = String(nowUtc5.getUTCSeconds()).padStart(2, '0');
  const createdAtStr = `${dd}.${mm}.${yyyy} ${hh}:${min}:${ss}`;

  try {
    const result = await db.execute({
      sql: 'INSERT INTO names (name, created_at) VALUES (?, ?)',
      args: [name, createdAtStr]
    });

    const insertedId = result.lastInsertRowid !== undefined ? Number(result.lastInsertRowid) : null;

    res.status(201).json({
      success: true,
      item: {
        id: insertedId,
        name: name,
        created_at: createdAtStr
      }
    });
  } catch (err) {
    console.error('Error inserting name:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3. Manual reset endpoint
app.post('/api/admin/clear', async (req, res) => {
  const nowUtc5 = getUtc5Date();
  try {
    await db.batch([
      { sql: 'DELETE FROM names', args: [] },
      { sql: "DELETE FROM sqlite_sequence WHERE name = 'names'", args: [] },
      { sql: "INSERT OR REPLACE INTO system_meta (key, value) VALUES ('manual_cleanup_time', ?)", args: [nowUtc5.toISOString()] }
    ]);
    res.json({ success: true, message: 'Список успешно очищен вручную' });
  } catch (err) {
    try {
      await db.execute('DELETE FROM names');
      res.json({ success: true, message: 'Список успешно очищен вручную' });
    } catch (fallbackErr) {
      console.error('Manual clear error:', fallbackErr);
      res.status(500).json({ success: false, error: fallbackErr.message });
    }
  }
});

// Cron job: cleanup every Mon, Wed, Fri at 14:00 (UTC+5 / Asia/Almaty)
cron.schedule('0 14 * * 1,3,5', async () => {
  try {
    await performCleanupIfDue();
    console.log('[CRON] Проверка автоочистки по расписанию выполнена');
  } catch (err) {
    console.error('[CRON Error]:', err.message);
  }
}, {
  timezone: 'Asia/Almaty'
});

// Polling check every 15 seconds to ensure catch-up if server was inactive
setInterval(() => {
  performCleanupIfDue().catch(err => console.error('Background interval error:', err.message));
}, 15000);

// Initialize DB and start server
const PORT = process.env.PORT || 3000;

initDb()
  .then(() => {
    app.listen(PORT, '0.0.0.0', () => {
      const nowUtc5 = getUtc5Date();
      console.log('='.repeat(50));
      console.log(`🚀 Сервер очереди AutoQ запущен на порту ${PORT}!`);
      console.log(`🕒 Текущее серверное время: ${nowUtc5.toISOString().replace('T', ' ').slice(0, 19)} (UTC+5)`);
      console.log(`🧹 Следующая автоочистка: ${formatRuDate(getNextCleanupSlot(nowUtc5))}`);
      console.log(`🌐 Локальный адрес: http://127.0.0.1:${PORT}`);
      console.log('='.repeat(50));
    });
  })
  .catch(err => {
    console.error('Ошибка инициализации базы данных:', err);
  });
