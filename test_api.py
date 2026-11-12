import unittest
import json
import os
from app import app, init_db, DB_FILE

class TestAppAPI(unittest.TestCase):
    def setUp(self):
        app.config['TESTING'] = True
        self.client = app.test_client()
        init_db()

    def test_index_page(self):
        response = self.client.get('/')
        self.assertEqual(response.status_code, 200)
        self.assertIn('Очередь'.encode('utf-8'), response.data)
        self.assertIn('nameInput'.encode('utf-8'), response.data)
        self.assertIn('slotsGrid'.encode('utf-8'), response.data)
        self.assertIn('namesList'.encode('utf-8'), response.data)

    def test_api_workflow_and_slot_mechanics(self):
        # 1. Clear database first
        res = self.client.post('/api/admin/clear')
        self.assertEqual(res.status_code, 200)

        # 2. Get list (should be empty, max_slots = 15)
        res = self.client.get('/api/names', headers={'X-Device-Id': 'dev-1'})
        self.assertEqual(res.status_code, 200)
        data = res.get_json()
        self.assertTrue(data['success'])
        self.assertEqual(data['count'], 0)
        self.assertEqual(data['max_slots'], 15)
        self.assertEqual(data['names'], [])
        self.assertIsNone(data['user_booking'])
        self.assertIn('next_cleanup', data)
        self.assertIn('formatted', data['next_cleanup'])

        # 3. Add first person to slot 5 (Device 1)
        res = self.client.post('/api/names', 
                               data=json.dumps({'name': 'Алексей', 'slot': 5, 'deviceId': 'dev-1'}), 
                               content_type='application/json')
        self.assertEqual(res.status_code, 201)
        data = res.get_json()
        self.assertTrue(data['success'])
        self.assertEqual(data['item']['name'], 'Алексей')
        self.assertEqual(data['item']['slot'], 5)
        self.assertIn('created_at', data['item'])
        self.assertRegex(data['item']['created_at'], r'^\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}:\d{2}$')

        # 4. Device restriction test: Device 1 tries to book a SECOND slot (e.g. slot 6)
        res = self.client.post('/api/names', 
                               data=json.dumps({'name': 'Алексей Повторно', 'slot': 6, 'deviceId': 'dev-1'}), 
                               content_type='application/json')
        self.assertEqual(res.status_code, 409)
        data = res.get_json()
        self.assertFalse(data['success'])
        self.assertIn('уже забронировано место', data['error'])

        # 5. Slot conflict test: Device 2 tries to take ALREADY TAKEN slot 5
        res = self.client.post('/api/names', 
                               data=json.dumps({'name': 'Мария', 'slot': 5, 'deviceId': 'dev-2'}), 
                               content_type='application/json')
        self.assertEqual(res.status_code, 409)
        data = res.get_json()
        self.assertFalse(data['success'])
        self.assertIn('уже занято', data['error'])

        # 6. Device 2 books free slot 2
        res = self.client.post('/api/names', 
                               data=json.dumps({'name': 'Мария', 'slot': 2, 'deviceId': 'dev-2'}), 
                               content_type='application/json')
        self.assertEqual(res.status_code, 201)
        data = res.get_json()
        self.assertEqual(data['item']['slot'], 2)
        self.assertEqual(data['item']['name'], 'Мария')

        # 7. Check ordering: Slot 2 (Мария) must come BEFORE Slot 5 (Алексей)
        res = self.client.get('/api/names', headers={'X-Device-Id': 'dev-2'})
        data = res.get_json()
        self.assertEqual(data['count'], 2)
        self.assertEqual(data['names'][0]['slot'], 2)
        self.assertEqual(data['names'][0]['name'], 'Мария')
        self.assertTrue(data['names'][0]['is_mine'])
        self.assertEqual(data['names'][1]['slot'], 5)
        self.assertEqual(data['names'][1]['name'], 'Алексей')
        self.assertFalse(data['names'][1]['is_mine'])
        self.assertIsNotNone(data['user_booking'])
        self.assertEqual(data['user_booking']['slot'], 2)

        # 8. Test validation: Empty name
        res = self.client.post('/api/names', 
                               data=json.dumps({'name': '   ', 'slot': 3, 'deviceId': 'dev-3'}), 
                               content_type='application/json')
        self.assertEqual(res.status_code, 400)
        data = res.get_json()
        self.assertFalse(data['success'])
        self.assertIn('error', data)

        # 9. Test validation: Invalid slot numbers (< 1 or > 15)
        res = self.client.post('/api/names', 
                               data=json.dumps({'name': 'Тест', 'slot': 0, 'deviceId': 'dev-3'}), 
                               content_type='application/json')
        self.assertEqual(res.status_code, 400)

        res = self.client.post('/api/names', 
                               data=json.dumps({'name': 'Тест', 'slot': 16, 'deviceId': 'dev-3'}), 
                               content_type='application/json')
        self.assertEqual(res.status_code, 400)

        # 10. Test form-encoded submission
        res = self.client.post('/api/names', data={'name': 'Дмитрий', 'slot': '15', 'deviceId': 'dev-3'})
        self.assertEqual(res.status_code, 201)
        data = res.get_json()
        self.assertEqual(data['item']['slot'], 15)
        self.assertEqual(data['item']['name'], 'Дмитрий')

        # 11. Count is now 3
        res = self.client.get('/api/names')
        data = res.get_json()
        self.assertEqual(data['count'], 3)
        self.assertEqual([n['slot'] for n in data['names']], [2, 5, 15])

        # 12. Cancel booking: Device 1 cancels slot 5
        res = self.client.post('/api/names/cancel', 
                               data=json.dumps({'deviceId': 'dev-1'}), 
                               content_type='application/json')
        self.assertEqual(res.status_code, 200)
        data = res.get_json()
        self.assertTrue(data['success'])
        self.assertEqual(data['freed_slot'], 5)

        # Now slot 5 is free, and Device 1 can book another slot (e.g. slot 1)
        res = self.client.post('/api/names', 
                               data=json.dumps({'name': 'Алексей', 'slot': 1, 'deviceId': 'dev-1'}), 
                               content_type='application/json')
        self.assertEqual(res.status_code, 201)

        # Check order again: [1, 2, 15]
        res = self.client.get('/api/names')
        data = res.get_json()
        self.assertEqual(data['count'], 3)
        self.assertEqual([n['slot'] for n in data['names']], [1, 2, 15])

if __name__ == '__main__':
    unittest.main()
