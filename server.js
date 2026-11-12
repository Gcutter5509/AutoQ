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
app.set('trust proxy', 1);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static frontend files
app.use('/static', express.static(path.join(__dirname, 'static')));

// Database connection (Turso cloud or local sqlite file fallback)
const dbUrl = (process.env.TURSO_DATABASE_URL || 'libsql://autoq-gcutter5509.aws-eu-north-1.turso.io').trim();
const authToken = (process.env.TURSO_AUTH_TOKEN || 'eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJpYXQiOjE3OTQxOTczNTUsImlkIjoiMDFhMWJlN2QtM2UwMS03NDEzLWE5ZGYtZGM5MDk3YWVhZWE5Iiwia2lkIjoiZ1BxM01OS2NpV0lSdVI4cXBfU3FZUjNlM001QXFOaHI2bVdzbnJzQXNpWSIsInJpZCI6ImIwNzRlYjAyLTE2NGUtNDdiMi1hMGQ2LTliYTIxZTgyYjc5MiJ9.Rltiv16QtTohQ4kF2LYoYs6DmcFl95Qoh4TUmcIRR4wrqtKdXshe3uWujWCDuqjQY4d5KMH3f6rB9tTBB_VpAQ').trim();
const isCloudTurso = !dbUrl.startsWith('file:');

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
    const lastSlot = res.rows.length > 0 ? String(res.rows[0].value ?? res.rows[0][0] ?? '') : '';

    if (lastSlot && lastSlot < slotStr) {
      console.log(`[${formatRuDate(nowUtc5)}] 🧹 Database cleared according to schedule (slot: ${slotStr}, prev: ${lastSlot})`);
      await db.execute('DELETE FROM names');
      try {
        await db.execute("DELETE FROM sqlite_sequence WHERE name = 'names'");
      } catch {
        // sqlite_sequence may not exist yet, safe to ignore
      }
      await db.execute({
        sql: "INSERT OR REPLACE INTO system_meta (key, value) VALUES ('last_cleanup_slot', ?)",
        args: [slotStr]
      });
      await db.execute({
        sql: "INSERT OR REPLACE INTO system_meta (key, value) VALUES ('last_cleanup_time', ?)",
        args: [nowUtc5.toISOString()]
      });
      return true;
    } else if (!lastSlot) {
      // First run or missing slot metadata: record current slot without deleting data!
      await db.execute({
        sql: "INSERT OR REPLACE INTO system_meta (key, value) VALUES ('last_cleanup_slot', ?)",
        args: [slotStr]
      });
    }
  } catch (err) {
    console.error('Scheduled cleanup check error:', err.message);
  }
  return false;
}

// Helper to extract device ID
function getDeviceId(req) {
  return String(
    req.body?.deviceId ||
    req.headers['x-device-id'] ||
    req.query?.deviceId ||
    ''
  ).trim();
}

// Helper to extract real client IP address
function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) {
    const first = xff.split(',')[0].trim();
    if (first) return first;
  }
  const cf = req.headers['cf-connecting-ip'];
  if (cf) return String(cf).trim();
  const xReal = req.headers['x-real-ip'];
  if (xReal) return String(xReal).trim();
  return String(req.ip || req.socket?.remoteAddress || '127.0.0.1').trim();
}

// Initialize tables and metadata
async function initDb() {
  try {
    const tableInfo = await db.execute("PRAGMA table_info(names)");
    const cols = tableInfo.rows.map(r => String(r.name ?? r[1] ?? ''));
    if (cols.length > 0 && (!cols.includes('slot') || !cols.includes('device_id'))) {
      await db.execute("DROP TABLE names");
    } else if (cols.length > 0 && !cols.includes('ip_address')) {
      await db.execute("ALTER TABLE names ADD COLUMN ip_address TEXT DEFAULT ''");
    }
  } catch {
    // Table may not exist yet, ignore
  }

  await db.execute(`
    CREATE TABLE IF NOT EXISTS names (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slot INTEGER NOT NULL UNIQUE CHECK(slot >= 1 AND slot <= 15),
      name TEXT NOT NULL,
      device_id TEXT NOT NULL,
      ip_address TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
  `);

  // Remove any spam entries with length < 2
  try {
    await db.execute("DELETE FROM names WHERE LENGTH(TRIM(name)) < 2");
  } catch {}

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
    const deviceId = getDeviceId(req);
    const clientIp = getClientIp(req);

    const result = await db.execute('SELECT id, slot, name, device_id, ip_address, created_at FROM names ORDER BY slot ASC');
    let userBooking = null;
    const names = result.rows.map(row => {
      const rowDeviceId = String(row.device_id ?? '');
      const rowIp = String(row.ip_address ?? '');
      const isMine = Boolean(
        (deviceId && rowDeviceId === deviceId) ||
        (clientIp && rowIp && rowIp === clientIp)
      );
      const item = {
        id: Number(row.id),
        slot: Number(row.slot),
        name: String(row.name),
        created_at: String(row.created_at),
        is_mine: isMine
      };
      if (isMine && !userBooking) {
        userBooking = {
          id: item.id,
          slot: item.slot,
          name: item.name,
          created_at: item.created_at
        };
      }
      return item;
    });

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
      max_slots: 15,
      names: names,
      user_booking: userBooking,
      client_ip: clientIp,
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
  const slotRaw = req.body?.slot;
  const deviceId = getDeviceId(req);
  const clientIp = getClientIp(req);

  if (!name) {
    return res.status(400).json({ success: false, error: 'Имя не может быть пустым' });
  }
  if (name.length < 2) {
    return res.status(400).json({ success: false, error: 'Имя должно содержать минимум 2 символа (введите имя или фамилию)' });
  }
  if (name.length > 100) {
    return res.status(400).json({ success: false, error: 'Имя слишком длинное (максимум 100 символов)' });
  }

  if (slotRaw === undefined || slotRaw === null || slotRaw === '') {
    return res.status(400).json({ success: false, error: 'Не выбрано место в очереди (1–15)' });
  }

  const slot = parseInt(slotRaw, 10);
  if (isNaN(slot) || slot < 1 || slot > 15) {
    return res.status(400).json({ success: false, error: 'Номер места должен быть целым числом от 1 до 15' });
  }

  if (!deviceId) {
    return res.status(400).json({ success: false, error: 'Не удалось определить устройство (отсутствует deviceId)' });
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
    // 1. IP check: strictly 1 spot per IP address
    if (clientIp) {
      const existingIp = await db.execute({
        sql: 'SELECT slot, name FROM names WHERE ip_address = ?',
        args: [clientIp]
      });
      if (existingIp.rows.length > 0) {
        const ipSlot = existingIp.rows[0].slot ?? existingIp.rows[0][0];
        const ipName = existingIp.rows[0].name ?? existingIp.rows[0][1];
        return res.status(409).json({
          success: false,
          error: `С вашего IP-адреса (${clientIp}) уже забронировано место №${ipSlot} (${ipName}). С одного IP разрешено занять только 1 место!`
        });
      }
    }

    // 2. Device check
    const existingDev = await db.execute({
      sql: 'SELECT slot, name FROM names WHERE device_id = ?',
      args: [deviceId]
    });
    if (existingDev.rows.length > 0) {
      const devSlot = existingDev.rows[0].slot ?? existingDev.rows[0][0];
      const devName = existingDev.rows[0].name ?? existingDev.rows[0][1];
      return res.status(409).json({
        success: false,
        error: `С вашего устройства уже забронировано место №${devSlot} (${devName}). Одно устройство может занять только одно место!`
      });
    }

    // 3. Slot check
    const existingSlot = await db.execute({
      sql: 'SELECT name FROM names WHERE slot = ?',
      args: [slot]
    });
    if (existingSlot.rows.length > 0) {
      const slotOccupant = existingSlot.rows[0].name ?? existingSlot.rows[0][0];
      return res.status(409).json({
        success: false,
        error: `Место №${slot} уже занято (${slotOccupant}). Пожалуйста, выберите другое свободное место.`
      });
    }

    // 4. Insert
    const result = await db.execute({
      sql: 'INSERT INTO names (slot, name, device_id, ip_address, created_at) VALUES (?, ?, ?, ?, ?)',
      args: [slot, name, deviceId, clientIp, createdAtStr]
    });

    const insertedId = result.lastInsertRowid !== undefined ? Number(result.lastInsertRowid) : null;

    res.status(201).json({
      success: true,
      item: {
        id: insertedId,
        slot: slot,
        name: name,
        created_at: createdAtStr,
        is_mine: true
      }
    });
  } catch (err) {
    console.error('Error inserting name:', err);
    res.status(409).json({
      success: false,
      error: 'Не удалось занять место: возможно, оно только что было занято другим участником.'
    });
  }
});

// 3. Cancel own booking endpoint
app.post('/api/names/cancel', async (req, res) => {
  const deviceId = getDeviceId(req);
  const clientIp = getClientIp(req);

  try {
    const existing = await db.execute({
      sql: 'SELECT id, slot, name FROM names WHERE (device_id != "" AND device_id = ?) OR (ip_address != "" AND ip_address = ?)',
      args: [deviceId, clientIp]
    });
    if (existing.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'У вас нет активной записи в очереди' });
    }

    const slotFreed = existing.rows[0].slot ?? existing.rows[0][0];
    const rowId = existing.rows[0].id ?? existing.rows[0][0];
    await db.execute({
      sql: 'DELETE FROM names WHERE id = ?',
      args: [rowId]
    });

    res.json({
      success: true,
      message: `Место №${slotFreed} успешно освобождено`,
      freed_slot: Number(slotFreed)
    });
  } catch (err) {
    console.error('Error cancelling booking:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4. Manual reset endpoint
app.post('/api/admin/clear', async (req, res) => {
  const nowUtc5 = getUtc5Date();
  try {
    await db.execute('DELETE FROM names');
    try {
      await db.execute("DELETE FROM sqlite_sequence WHERE name = 'names'");
    } catch {
      // sqlite_sequence may not exist yet, safe to ignore
    }
    await db.execute({
      sql: "INSERT OR REPLACE INTO system_meta (key, value) VALUES ('manual_cleanup_time', ?)",
      args: [nowUtc5.toISOString()]
    });
    res.json({ success: true, message: 'Список успешно очищен вручную' });
  } catch (err) {
    console.error('Manual clear error:', err);
    res.status(500).json({ success: false, error: err.message });
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
      console.log('='.repeat(55));
      console.log(`🚀 Сервер очереди AutoQ запущен на порту ${PORT}!`);
      if (isCloudTurso) {
        console.log(`✅ База данных: Turso Cloud (${dbUrl})`);
      } else {
        console.warn(`⚠️ ВНИМАНИЕ: Переменная TURSO_DATABASE_URL не найдена!`);
        console.warn(`   Сервер работает с локальным файлом: ${dbUrl}`);
        console.warn(`   В облаке (Render/Railway) при 'засыпании' сайта данные будут СТЁРТЫ!`);
        console.warn(`   Укажите TURSO_DATABASE_URL и TURSO_AUTH_TOKEN в настройках хостинга.`);
      }
      console.log(`🕒 Текущее серверное время: ${nowUtc5.toISOString().replace('T', ' ').slice(0, 19)} (UTC+5)`);
      console.log(`🧹 Следующая автоочистка: ${formatRuDate(getNextCleanupSlot(nowUtc5))}`);
      console.log(`🌐 Локальный адрес: http://127.0.0.1:${PORT}`);
      console.log('='.repeat(55));
    });
  })
  .catch(err => {
    console.error('❌ Ошибка инициализации базы данных:', err);
  });
