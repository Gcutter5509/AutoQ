import unittest
from datetime import datetime, timedelta, timezone
import sqlite3
import os

UTC5 = timezone(timedelta(hours=5))
CLEANUP_WEEKDAYS = {0, 2, 4}  # Mon, Wed, Fri
CLEANUP_HOUR = 14
CLEANUP_MINUTE = 0

def get_most_recent_cleanup_slot(dt: datetime) -> datetime:
    cur = dt.replace(hour=CLEANUP_HOUR, minute=CLEANUP_MINUTE, second=0, microsecond=0)
    if cur > dt:
        cur -= timedelta(days=1)
    while cur.weekday() not in CLEANUP_WEEKDAYS:
        cur -= timedelta(days=1)
    return cur

def get_next_cleanup_slot(dt: datetime) -> datetime:
    cur = dt.replace(hour=CLEANUP_HOUR, minute=CLEANUP_MINUTE, second=0, microsecond=0)
    if cur <= dt:
        cur += timedelta(days=1)
    while cur.weekday() not in CLEANUP_WEEKDAYS:
        cur += timedelta(days=1)
    return cur

def check_cleanup(conn, current_dt: datetime) -> bool:
    slot = get_most_recent_cleanup_slot(current_dt)
    slot_str = slot.isoformat()
    cur = conn.cursor()
    cur.execute("SELECT value FROM system_meta WHERE key = 'last_cleanup_slot'")
    row = cur.fetchone()
    last_slot = row[0] if row else ""

    if last_slot < slot_str:
        cur.execute("DELETE FROM names")
        cur.execute("DELETE FROM sqlite_sequence WHERE name = 'names'")
        cur.execute("INSERT OR REPLACE INTO system_meta (key, value) VALUES ('last_cleanup_slot', ?)", (slot_str,))
        cur.execute("INSERT OR REPLACE INTO system_meta (key, value) VALUES ('last_cleanup_time', ?)", (current_dt.isoformat(),))
        conn.commit()
        return True
    return False

class TestCleanupSchedule(unittest.TestCase):
    def test_schedule_slots(self):
        # 2026-11-09 is Monday
        # 1. Monday before 14:00 (13:59:59)
        dt = datetime(2026, 11, 9, 13, 59, 59, tzinfo=UTC5)
        recent = get_most_recent_cleanup_slot(dt)
        self.assertEqual(recent, datetime(2026, 11, 6, 14, 0, 0, tzinfo=UTC5)) # Friday
        next_slot = get_next_cleanup_slot(dt)
        self.assertEqual(next_slot, datetime(2026, 11, 9, 14, 0, 0, tzinfo=UTC5)) # Today at 14:00

        # 2. Monday exactly at 14:00:00
        dt = datetime(2026, 11, 9, 14, 0, 0, tzinfo=UTC5)
        recent = get_most_recent_cleanup_slot(dt)
        self.assertEqual(recent, datetime(2026, 11, 9, 14, 0, 0, tzinfo=UTC5))
        next_slot = get_next_cleanup_slot(dt)
        self.assertEqual(next_slot, datetime(2026, 11, 11, 14, 0, 0, tzinfo=UTC5)) # Wednesday

        # 3. Monday after 14:00 (14:30)
        dt = datetime(2026, 11, 9, 14, 30, 0, tzinfo=UTC5)
        recent = get_most_recent_cleanup_slot(dt)
        self.assertEqual(recent, datetime(2026, 11, 9, 14, 0, 0, tzinfo=UTC5))
        next_slot = get_next_cleanup_slot(dt)
        self.assertEqual(next_slot, datetime(2026, 11, 11, 14, 0, 0, tzinfo=UTC5))

        # 4. Tuesday (2026-11-10 10:00)
        dt = datetime(2026, 11, 10, 10, 0, 0, tzinfo=UTC5)
        recent = get_most_recent_cleanup_slot(dt)
        self.assertEqual(recent, datetime(2026, 11, 9, 14, 0, 0, tzinfo=UTC5)) # Monday
        next_slot = get_next_cleanup_slot(dt)
        self.assertEqual(next_slot, datetime(2026, 11, 11, 14, 0, 0, tzinfo=UTC5)) # Wednesday

        # 5. Wednesday at 14:00:00
        dt = datetime(2026, 11, 11, 14, 0, 0, tzinfo=UTC5)
        recent = get_most_recent_cleanup_slot(dt)
        self.assertEqual(recent, datetime(2026, 11, 11, 14, 0, 0, tzinfo=UTC5))
        next_slot = get_next_cleanup_slot(dt)
        self.assertEqual(next_slot, datetime(2026, 11, 13, 14, 0, 0, tzinfo=UTC5)) # Friday

        # 6. Friday at 14:00:00
        dt = datetime(2026, 11, 13, 14, 0, 0, tzinfo=UTC5)
        recent = get_most_recent_cleanup_slot(dt)
        self.assertEqual(recent, datetime(2026, 11, 13, 14, 0, 0, tzinfo=UTC5))
        next_slot = get_next_cleanup_slot(dt)
        self.assertEqual(next_slot, datetime(2026, 11, 16, 14, 0, 0, tzinfo=UTC5)) # Next Monday

        # 7. Saturday (2026-11-14 18:00)
        dt = datetime(2026, 11, 14, 18, 0, 0, tzinfo=UTC5)
        recent = get_most_recent_cleanup_slot(dt)
        self.assertEqual(recent, datetime(2026, 11, 13, 14, 0, 0, tzinfo=UTC5)) # Friday
        next_slot = get_next_cleanup_slot(dt)
        self.assertEqual(next_slot, datetime(2026, 11, 16, 14, 0, 0, tzinfo=UTC5)) # Next Monday

        # 8. Sunday (2026-11-15 09:00)
        dt = datetime(2026, 11, 15, 9, 0, 0, tzinfo=UTC5)
        recent = get_most_recent_cleanup_slot(dt)
        self.assertEqual(recent, datetime(2026, 11, 13, 14, 0, 0, tzinfo=UTC5)) # Friday
        next_slot = get_next_cleanup_slot(dt)
        self.assertEqual(next_slot, datetime(2026, 11, 16, 14, 0, 0, tzinfo=UTC5)) # Next Monday

    def test_database_cleanup_execution(self):
        conn = sqlite3.connect(':memory:')
        conn.execute('CREATE TABLE names (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)')
        conn.execute('CREATE TABLE system_meta (key TEXT PRIMARY KEY, value TEXT)')

        # Simulate Friday 2026-11-06 at 15:00
        t1 = datetime(2026, 11, 6, 15, 0, 0, tzinfo=UTC5)
        slot1 = get_most_recent_cleanup_slot(t1)
        conn.execute("INSERT INTO system_meta (key, value) VALUES ('last_cleanup_slot', ?)", (slot1.isoformat(),))

        # Add 3 names
        conn.execute("INSERT INTO names (name) VALUES ('Alice')")
        conn.execute("INSERT INTO names (name) VALUES ('Bob')")
        conn.execute("INSERT INTO names (name) VALUES ('Charlie')")
        conn.commit()

        # At Monday 13:59:00 -> should NOT clean
        t2 = datetime(2026, 11, 9, 13, 59, 0, tzinfo=UTC5)
        cleaned = check_cleanup(conn, t2)
        self.assertFalse(cleaned)
        cur = conn.cursor()
        cur.execute("SELECT COUNT(*) FROM names")
        self.assertEqual(cur.fetchone()[0], 3)

        # At Monday 14:00:00 -> SHOULD clean!
        t3 = datetime(2026, 11, 9, 14, 0, 0, tzinfo=UTC5)
        cleaned = check_cleanup(conn, t3)
        self.assertTrue(cleaned)
        cur.execute("SELECT COUNT(*) FROM names")
        self.assertEqual(cur.fetchone()[0], 0)

        # Add a new name -> should start from ID 1 because autoincrement sequence was reset
        conn.execute("INSERT INTO names (name) VALUES ('Dave')")
        conn.commit()
        cur.execute("SELECT id, name FROM names")
        row = cur.fetchone()
        self.assertEqual(row[0], 1)
        self.assertEqual(row[1], 'Dave')

        # At Monday 14:05:00 -> should NOT clean again!
        t4 = datetime(2026, 11, 9, 14, 5, 0, tzinfo=UTC5)
        cleaned = check_cleanup(conn, t4)
        self.assertFalse(cleaned)
        cur.execute("SELECT COUNT(*) FROM names")
        self.assertEqual(cur.fetchone()[0], 1)

if __name__ == '__main__':
    unittest.main()
