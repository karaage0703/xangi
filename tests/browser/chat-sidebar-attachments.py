"""Isolated regression: right-aligned actions, accepted turns and linked attachments. Build first."""
import base64
import mimetypes
import os
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[2] / 'web/app'
OUT = Path(os.environ.get('BROWSER_TEST_OUTPUT', '/tmp/chat-sidebar-attachments'))
OUT.mkdir(parents=True, exist_ok=True)
PHOTO = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=')
with sync_playwright() as pw:
    browser = pw.chromium.launch(args=['--no-sandbox'])
    for width in [1280, 390, 320]:
      for platform in ['discord', 'slack']:
        context = browser.new_context(viewport={'width': width, 'height': 844}, has_touch=width < 768)
        page = context.new_page()
        page.add_init_script('window.EventSource=class{addEventListener(){} close(){}}')
        session = dict(id='linked', title='ソフト開発の会話', platform=platform, linkedChannel=True, lifecycle='open', isActive=False, messages=[])
        sessions = [dict(session, id=f's{i}', title=f'会話{i}', lifecycle='closed') for i in range(8)]
        posts, errors, creations, retries = [], [], [], []
        mode, receipts = ['reject'], {}
        page.on('pageerror', lambda error: errors.append(str(error)))
        def completed(receipt):
            receipt.update(state='completed', delivery='delivered', result='確認しました')
            session['messages'] = [dict(id='u'+receipt['id'], role='user', content=receipt.get('message', ''), attachments=receipt.get('attachments', [])), dict(id='a'+receipt['id'], role='assistant', content='確認しました')]
            session['isActive'] = False
        def route(r):
            path = urlparse(r.request.url).path
            if path == '/api/upload': data = {'files': [{'name': 'sample.png', 'path': '/work/tmp/web-uploads/sample.png'}]}
            elif path.endswith('/turns'):
                body = r.request.post_data_json; posts.append(body)
                if mode[0] == 'reject': r.fulfill(status=400, json={'error': '受付前の入力エラー'}); return
                receipt = dict(body, id=body['requestId'], state='running', delivery='none')
                receipts[body['requestId']] = receipt
                if mode[0] != 'pending': completed(receipt)
                if mode[0] == 'offline': receipt['delivery'] = 'failed'
                if mode[0] == 'lost': r.abort('failed'); return
                r.fulfill(status=202, json={'turn': receipt}); return
            elif '/turn-requests/' in path:
                request_id = path.split('/turn-requests/')[1].split('/')[0]
                if path.endswith('/retry-delivery'):
                    retries.append(request_id); receipts[request_id]['delivery'] = 'delivered'
                receipt = receipts.get(request_id)
                r.fulfill(status=200 if receipt else 404, json={'turn': receipt} if receipt else {'error': 'not found'}); return
            elif path.endswith('-continue'): raise AssertionError('The UI must not mirror input through the legacy chat bridge')
            elif path == '/api/config': data = {'uploadAccept': None, 'uploadMaxBytes': 64000000, 'allowedBackends': ['codex']}
            elif path == '/api/projects': data = {'projects': [{'id': 'dev', 'name': 'ソフト開発', 'channel': {'platform': platform, 'channelId': 'channel'}}]}
            elif path == '/api/sessions' and r.request.method == 'POST':
                creations.append(r.request.post_data_json); data = {'sessionId': 'linked'}
            elif path == '/api/sessions': data = {'sessions': sessions, 'meta': {'hasMore': False}}
            elif path == '/api/sessions/linked': data = session
            elif path.startswith('/api/'): data = {'agents': [], 'teams': [], 'history': [], 'commands': [], 'skills': [], 'questions': []}
            else:
                f = ROOT / path.removeprefix('/app/').lstrip('/')
                if not f.is_file(): f = ROOT / 'index.html'
                r.fulfill(body=f.read_bytes(), content_type=mimetypes.guess_type(str(f))[0] or 'application/octet-stream'); return
            r.fulfill(json=data)
        page.route('**/*', route)
        page.goto('http://chat.test/chat/linked')
        def open_sidebar():
            if width < 768 and 'open' not in page.locator('.sidebar').get_attribute('class'):
                page.get_by_role('button', name='サイドバーを開く', exact=True).click()
        open_sidebar()
        expect(page.locator('.session-row')).to_have_count(8)
        row = page.locator('.session-row').first
        box = row.bounding_box()
        assert box['height'] <= (60 if width < 768 else 90), box
        row.hover()
        page.wait_for_timeout(150)
        if width < 768:
            row.locator('.session-actions-trigger').click()
        actions = row.locator('.session-actions')
        last = actions.locator('button').last.bounding_box()
        action_box = actions.bounding_box()
        assert abs(action_box['x'] + action_box['width'] - last['x'] - last['width']) <= (6 if width < 768 else 1)
        if width < 768:
            for b in row.locator('.session-actions button').all():
                bb = b.bounding_box(); assert bb['width'] >= 44 and bb['height'] >= 44
            page.locator('.scrim').click(position={'x': width-5, 'y': 200})
        attach = page.get_by_role('button', name='ファイルを添付', exact=True)
        expect(attach).to_be_enabled()
        def photo():
            page.locator('input[type=file]').set_input_files({'name':'sample.png','mimeType':'image/png','buffer':PHOTO})
            expect(page.locator('.attachment-tray')).to_contain_text('sample.png')
        def send(text):
            page.locator('.pane-input').fill(text)
            page.get_by_role('button', name='送信', exact=True).click()
        photo(); send('画像を確認してください')
        expect(page.get_by_text('受付前の入力エラー', exact=True)).to_be_visible()
        expect(page.locator('.pane-input')).to_have_value('画像を確認してください')
        expect(page.locator('.attachment-tray')).to_contain_text('sample.png')
        mode[0] = 'pending'
        page.get_by_role('button', name='送信', exact=True).click()
        expect(page.locator('.attachment-tray')).to_have_count(0)
        expect(page.locator('.pane-input')).to_have_value('')
        page.wait_for_function('Object.keys(sessionStorage).some(k => k.startsWith("xangi_conversation_submission:") && JSON.parse(sessionStorage.getItem(k)).accepted)')
        count = len(posts)
        page.screenshot(path=str(OUT / f'accepted-{width}-{platform}.png'))
        page.reload()
        expect(page.locator('.pane-input')).to_have_value('')
        expect(page.locator('.attachment-tray')).to_have_count(0)
        for receipt in receipts.values(): completed(receipt)
        expect(page.get_by_role('button', name='送信', exact=True)).to_be_visible()
        assert len(posts) == count, 'reload must only look up the accepted request'
        mode[0] = 'lost'
        photo(); send('応答が切れても入力欄へ戻さない')
        expect(page.get_by_role('button', name='送信', exact=True)).to_be_visible(timeout=10000)
        expect(page.locator('.pane-input')).to_have_value('')
        expect(page.locator('.attachment-tray')).to_have_count(0)
        assert len(posts) == count + 1, 'lost acceptance response must not cause a second POST'
        mode[0] = 'offline'; send('結果だけ再投稿')
        retry = page.get_by_role('button', name='元のチャットへ結果を再投稿')
        expect(retry).to_be_visible()
        count = len(posts); retry.click()
        expect(retry).to_have_count(0)
        assert len(posts) == count and len(retries) == 1
        mode[0] = 'success'
        open_sidebar()
        page.get_by_role('button', name='ソフト開発', exact=True).click()
        page.locator('.sidebar').get_by_role('button', name='＋ 新しい会話', exact=True).click()
        expect(attach).to_be_enabled()
        photo(); send('新しい連携会話で確認')
        expect(page.get_by_role('button', name='送信', exact=True)).to_be_visible()
        expect(page.locator('.pane-input')).to_have_value('')
        expect(page.locator('.attachment-tray')).to_have_count(0)
        assert posts[-1]['message'] == '新しい連携会話で確認' and posts[-1]['attachments']
        assert creations[-1].get('requestId')
        page.screenshot(path=str(OUT / f'completed-{width}-{platform}.png'))
        assert not errors, errors
        print(f'PASS {width} {platform} right-align/rejection/accepted/reload/lost-response/delivery-retry/new-linked', flush=True)
        context.close()
    browser.close()
