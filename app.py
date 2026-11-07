import os
import sqlite3
import threading
import time
from datetime import datetime, timedelta, timezone
from flask import Flask, render_template, request, jsonify

app = Flask(__name__)

# Paths & Database
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_FILE = os.environ.get('DB_PATH', os.path.join(BASE_DIR, 'names.db'))
db_lock = threading.Lock()

# Schedule constants (UTC+5, Mon/Wed/Fri at 14:00)
UTC5 = timezone(timedelta(hours=5))
CLEANUP_WEEKDAYS = {0, 2, 4}  # 0=Monday, 2=Wednesday, 4=Friday
CLEANUP_HOUR = 14
CLEANUP_MINUTE = 0

RU_WEEKDAYS = {
    0: 'Понедельник',
    1: 'Вторник',
    2: 'Среда',
    3: 'Четверг',
    4: 'Пятница',
    5: 'Суббота',
    6: 'Воскресенье'
}

RU_MONTHS = {
    1: 'января', 2: 'февраля', 3: 'марта', 4: 'апреля',
    5: 'мая', 6: 'июня', 7: 'июля', 8: 'августа',
    9: 'сентября', 10: 'октября', 11: 'ноября', 12: 'декабря'
}

def get_db():
    conn = sqlite3.connect(DB_FILE, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    with db_lock:
        conn = get_db()
        try:
            with conn:
                conn.execute('''
                    CREATE TABLE IF NOT EXISTS names (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        name TEXT NOT NULL,
                        created_at TEXT NOT NULL
                    )
                ''')
                conn.execute('''
                    CREATE TABLE IF NOT EXISTS system_meta (
                        key TEXT PRIMARY KEY,
                        value TEXT
                    )
                ''')
                # Initialize last_cleanup_slot if not set
                cur = conn.cursor()
                cur.execute("SELECT value FROM system_meta WHERE key = 'last_cleanup_slot'")
                if cur.fetchone() is None:
                    now = datetime.now(UTC5)
                    slot = get_most_recent_cleanup_slot(now)
                    conn.execute("INSERT INTO system_meta (key, value) VALUES ('last_cleanup_slot', ?)", (slot.isoformat(),))
        finally:
            conn.close()

def get_most_recent_cleanup_slot(dt: datetime) -> datetime:
    """Returns the most recent scheduled cleanup timestamp <= dt."""
    cur = dt.replace(hour=CLEANUP_HOUR, minute=CLEANUP_MINUTE, second=0, microsecond=0)
    if cur > dt:
        cur -= timedelta(days=1)
    while cur.weekday() not in CLEANUP_WEEKDAYS:
        cur -= timedelta(days=1)
    return cur

def get_next_cleanup_slot(dt: datetime) -> datetime:
    """Returns the next upcoming scheduled cleanup timestamp > dt."""
    cur = dt.replace(hour=CLEANUP_HOUR, minute=CLEANUP_MINUTE, second=0, microsecond=0)
    if cur <= dt:
        cur += timedelta(days=1)
    while cur.weekday() not in CLEANUP_WEEKDAYS:
        cur += timedelta(days=1)
    return cur

def format_ru_date(dt: datetime) -> str:
    """Formats datetime nicely in Russian, e.g. 'Понедельник, 9 ноября в 14:00 (UTC+5)'."""
    weekday = RU_WEEKDAYS.get(dt.weekday(), '')
    month = RU_MONTHS.get(dt.month, '')
    return f"{weekday}, {dt.day} {month} в {dt.strftime('%H:%M')} (UTC+5)"

def perform_cleanup_if_due(now_dt: datetime = None) -> bool:
    """Checks if a scheduled cleanup slot has passed and performs cleanup if needed."""
    if now_dt is None:
        now_dt = datetime.now(UTC5)
    
    recent_slot = get_most_recent_cleanup_slot(now_dt)
    slot_str = recent_slot.isoformat()
    
    with db_lock:
        conn = get_db()
        try:
            with conn:
                cur = conn.cursor()
                cur.execute("SELECT value FROM system_meta WHERE key = 'last_cleanup_slot'")
                row = cur.fetchone()
                last_slot = row[0] if row else ""
                
                if last_slot < slot_str:
                    conn.execute("DELETE FROM names")
                    conn.execute("DELETE FROM sqlite_sequence WHERE name = 'names'")
                    conn.execute("INSERT OR REPLACE INTO system_meta (key, value) VALUES ('last_cleanup_slot', ?)", (slot_str,))
                    conn.execute("INSERT OR REPLACE INTO system_meta (key, value) VALUES ('last_cleanup_time', ?)", (now_dt.isoformat(),))
                    print(f"[{now_dt.strftime('%Y-%m-%d %H:%M:%S UTC+5')}] 🧹 Database cleared according to schedule (slot: {slot_str})")
                    return True
        finally:
            conn.close()
    return False

def scheduler_worker():
    """Background thread checking for cleanup every 5 seconds."""
    while True:
        try:
            perform_cleanup_if_due()
        except Exception as e:
            print(f"Error in cleanup scheduler: {e}")
        time.sleep(5)

@app.before_request
def before_request_hook():
    """Ensure cleanup is up-to-date on every request."""
    perform_cleanup_if_due()

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/api/names', methods=['GET'])
def get_names():
    now = datetime.now(UTC5)
    next_slot = get_next_cleanup_slot(now)
    
    with db_lock:
        conn = get_db()
        try:
            cur = conn.cursor()
            cur.execute("SELECT id, name, created_at FROM names ORDER BY id ASC")
            rows = cur.fetchall()
            names_list = [
                {
                    "id": row["id"],
                    "name": row["name"],
                    "created_at": row["created_at"]
                }
                for row in rows
            ]
        finally:
            conn.close()
            
    return jsonify({
        "success": True,
        "count": len(names_list),
        "names": names_list,
        "server_time": now.strftime('%Y-%m-%d %H:%M:%S (UTC+5)'),
        "next_cleanup": {
            "iso": next_slot.isoformat(),
            "formatted": format_ru_date(next_slot)
        }
    })

@app.route('/api/names', methods=['POST'])
def add_name():
    # Supports JSON payload or standard form data
    data = request.get_json(silent=True) or request.form
    name = (data.get('name') or '').strip()
    
    if not name:
        return jsonify({"success": False, "error": "Имя не может быть пустым"}), 400
    if len(name) > 100:
        return jsonify({"success": False, "error": "Имя слишком длинное (максимум 100 символов)"}), 400
        
    now = datetime.now(UTC5)
    created_at_str = now.strftime('%d.%m.%Y %H:%M:%S')
    
    with db_lock:
        conn = get_db()
        try:
            with conn:
                cur = conn.cursor()
                cur.execute("INSERT INTO names (name, created_at) VALUES (?, ?)", (name, created_at_str))
                inserted_id = cur.lastrowid
        finally:
            conn.close()
            
    return jsonify({
        "success": True,
        "item": {
            "id": inserted_id,
            "name": name,
            "created_at": created_at_str
        }
    }), 201

@app.route('/api/admin/clear', methods=['POST'])
def manual_clear():
    """Manual reset endpoint for owner/testing."""
    now = datetime.now(UTC5)
    with db_lock:
        conn = get_db()
        try:
            with conn:
                conn.execute("DELETE FROM names")
                conn.execute("DELETE FROM sqlite_sequence WHERE name = 'names'")
                conn.execute("INSERT OR REPLACE INTO system_meta (key, value) VALUES ('manual_cleanup_time', ?)", (now.isoformat(),))
        finally:
            conn.close()
    return jsonify({"success": True, "message": "Список успешно очищен вручную"})

# Ensure DB and scheduler are initialized both when run directly and when imported by WSGI (gunicorn)
init_db()

_scheduler_started = False
if not _scheduler_started and os.environ.get('WERKZEUG_RUN_MAIN') != 'false':
    _scheduler_started = True
    _scheduler_thread = threading.Thread(target=scheduler_worker, daemon=True)
    _scheduler_thread.start()

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    print("=" * 60)
    print("🚀 Веб-сайт запущен!")
    print(f"🕒 Текущее серверное время: {datetime.now(UTC5).strftime('%Y-%m-%d %H:%M:%S (UTC+5)')}")
    print(f"🧹 Следующая автоочистка: {format_ru_date(get_next_cleanup_slot(datetime.now(UTC5)))}")
    print(f"🌐 Локальный адрес: http://127.0.0.1:{port}")
    print(f"🌐 Доступ в сети: http://0.0.0.0:{port}")
    print("=" * 60)
    
    app.run(host='0.0.0.0', port=port, debug=False)
