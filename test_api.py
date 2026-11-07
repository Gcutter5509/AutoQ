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
        self.assertIn('namesList'.encode('utf-8'), response.data)

    def test_api_workflow(self):
        # 1. Clear database first
        res = self.client.post('/api/admin/clear')
        self.assertEqual(res.status_code, 200)

        # 2. Get list (should be empty)
        res = self.client.get('/api/names')
        self.assertEqual(res.status_code, 200)
        data = res.get_json()
        self.assertTrue(data['success'])
        self.assertEqual(data['count'], 0)
        self.assertEqual(data['names'], [])
        self.assertIn('next_cleanup', data)
        self.assertIn('formatted', data['next_cleanup'])

        # 3. Add first name
        res = self.client.post('/api/names', 
                               data=json.dumps({'name': 'Алексей'}), 
                               content_type='application/json')
        self.assertEqual(res.status_code, 201)
        data = res.get_json()
        self.assertTrue(data['success'])
        self.assertEqual(data['item']['name'], 'Алексей')
        self.assertEqual(data['item']['id'], 1)

        # 4. Add second name
        res = self.client.post('/api/names', 
                               data=json.dumps({'name': 'Мария'}), 
                               content_type='application/json')
        self.assertEqual(res.status_code, 201)
        data = res.get_json()
        self.assertEqual(data['item']['id'], 2)

        # 5. Check order: Алексей should be first, Мария second
        res = self.client.get('/api/names')
        data = res.get_json()
        self.assertEqual(data['count'], 2)
        self.assertEqual(data['names'][0]['name'], 'Алексей')
        self.assertEqual(data['names'][0]['id'], 1)
        self.assertEqual(data['names'][1]['name'], 'Мария')
        self.assertEqual(data['names'][1]['id'], 2)

        # 6. Test validation (empty name)
        res = self.client.post('/api/names', 
                               data=json.dumps({'name': '   '}), 
                               content_type='application/json')
        self.assertEqual(res.status_code, 400)
        data = res.get_json()
        self.assertFalse(data['success'])
        self.assertIn('error', data)

        # 7. Test form encoded submission
        res = self.client.post('/api/names', data={'name': 'Дмитрий'})
        self.assertEqual(res.status_code, 201)
        data = res.get_json()
        self.assertEqual(data['item']['name'], 'Дмитрий')
        self.assertEqual(data['item']['id'], 3)

        # 8. Verify count is now 3
        res = self.client.get('/api/names')
        data = res.get_json()
        self.assertEqual(data['count'], 3)

if __name__ == '__main__':
    unittest.main()
