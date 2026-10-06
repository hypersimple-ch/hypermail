#!/usr/bin/env python3
"""Host orchestration regressions; no Docker daemon, mailbox, or remote writes."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'bin' / 'backup-quiesced'
DOCKER = r'''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
path = Path(os.environ['FAKE_STATE'])
state = json.loads(path.read_text())
a = sys.argv[1:]
if a[0] == 'inspect':
    service = a[-1]
    fmt = a[a.index('--format') + 1]
    if fmt == '{{.State.Running}}': print(str(state['running'][service]).lower())
    elif fmt == '{{.Config.Image}}': print('registry/hindsight@sha256:' + 'a' * 64)
    else: print('exited ' + ('137' if service == os.environ.get('UNCLEAN') else '0'))
    sys.exit(0)
assert a[0] == 'compose'
a = a[1:]
if a[0] == 'ps':
    print(a[-1]); sys.exit(0)
if a[0] == '--profile': a = a[2:]
command = a[0]
service = a[-1]
state['events'].append([command, service])
if command == 'stop': state['running'][service] = False
if command == 'start': state['running'][service] = True
path.write_text(json.dumps(state))
if command == 'run':
    assert '--no-deps' in a and '--rm' in a
    assert any(x.startswith('BACKUP_QUIESCENCE_AT=') for x in a)
    assert any(x.startswith('BACKUP_HINDSIGHT_IMAGE=') for x in a)
if command == os.environ.get('FAIL_COMMAND') and (service == os.environ.get('FAIL_SERVICE') or command == 'run'):
    sys.exit(1)
'''


class Orchestration(unittest.TestCase):
    def execute(self, **failure):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            docker = root / 'docker'
            docker.write_text(DOCKER)
            docker.chmod(0o755)
            state = root / 'state.json'
            state.write_text(json.dumps({'running': dict.fromkeys(['proxy', 'web', 'worker', 'hypermail', 'hindsight'], True), 'events': []}))
            env = dict(os.environ, PATH=str(root) + ':' + os.environ['PATH'], FAKE_STATE=str(state), BACKUP_LOCK_FILE=str(root / 'lock'), **failure)
            result = subprocess.run(['bash', str(SCRIPT)], env=env, capture_output=True, timeout=20)
            return result.returncode, json.loads(state.read_text())

    def test_snapshot_between_clean_stop_and_reverse_restart(self):
        code, state = self.execute()
        self.assertEqual(code, 0)
        self.assertEqual(state['events'], [[command, service] for command, services in [
            ('stop', ['proxy', 'web', 'worker', 'hypermail', 'hindsight']),
            ('run', ['backup']), ('start', ['hindsight', 'hypermail', 'worker', 'web', 'proxy'])
        ] for service in services])
        self.assertTrue(all(state['running'].values()))

    def test_upload_failure_resumes_services_and_returns_failure(self):
        code, state = self.execute(FAIL_COMMAND='run')
        self.assertNotEqual(code, 0)
        self.assertTrue(all(state['running'].values()))
        self.assertEqual(state['events'][-5:], [['start', s] for s in ['hindsight', 'hypermail', 'worker', 'web', 'proxy']])

    def test_unclean_shutdown_refuses_archive_and_restores_attempted_services(self):
        code, state = self.execute(UNCLEAN='worker')
        self.assertNotEqual(code, 0)
        self.assertNotIn(['run', 'backup'], state['events'])
        self.assertEqual(state['events'][-3:], [['start', s] for s in ['worker', 'web', 'proxy']])

    def test_restart_failure_never_reports_success(self):
        code, state = self.execute(FAIL_COMMAND='start', FAIL_SERVICE='hypermail')
        self.assertNotEqual(code, 0)
        self.assertNotIn(['start', 'web'], state['events'])


if __name__ == '__main__':
    unittest.main()
