import json
import os
from pathlib import Path
import tempfile
import unittest

import pexpect


class PhonePairing(unittest.TestCase):
    def exercise(self, scenario, invalid_address=False):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            adb = base / 'data/codex-pocket-voice/test-tools/platform-tools/adb'
            adb.parent.mkdir(parents=True)
            adb.write_text('''#!/usr/bin/env python3
import os,sys
scenario=os.environ['POCKET_TEST_PAIR_SCENARIO']
if sys.argv[1]=='pair':
 code=sys.stdin.readline().strip()
 if scenario=='fault':
  print('error: protocol fault (test code '+code+')')
  sys.exit(0)  # A transport failure must not be accepted just because exit is zero.
 print('Successfully paired to '+sys.argv[2])
elif sys.argv[1]=='devices':
 print('List of devices attached')
 if scenario=='success': print('test-device\\tdevice')
elif sys.argv[1]=='connect':
 print('failed to connect')
''')
            adb.chmod(0o700)
            env = {**os.environ, 'XDG_DATA_HOME': str(base/'data'),
                   'XDG_STATE_HOME': str(base/'state'), 'POCKET_TEST_PAIR_SCENARIO': scenario}
            script = Path(__file__).parents[1] / 'scripts/pair-phone.sh'
            child = pexpect.spawn('/bin/sh', [str(script)], env=env, encoding='utf-8', timeout=12)
            try:
                child.expect_exact('6자리 코드 아님): ')
                if invalid_address:
                    child.sendline('654321')
                    child.expect_exact('주소와 포트를 함께 입력하세요.')
                    child.expect_exact('6자리 코드 아님): ')
                child.sendline('192.0.2.1:12345')
                child.expect_exact('입력은 숨김): ')
                child.sendline('123456')
                if scenario == 'fault':
                    child.expect_exact('error: protocol fault (test code [code omitted])')
                    child.expect_exact('페어링 실패.')
                elif scenario == 'success':
                    child.expect_exact('ADB에 연결된 기기가 확인됐습니다.')
                else:
                    child.expect_exact('기본 화면의 연결용 IP 주소:포트 입력 (6자리 코드 아님): ')
                    child.sendline('192.0.2.1:23456')
                    child.expect_exact('아직 연결되지 않았습니다.')
                child.sendline('')
                child.expect(pexpect.EOF)
                report = (base/'state/codex-pocket-voice/phone-test/last-pairing-result.json').read_text()
                self.assertNotIn('123456', report)
                self.assertNotIn('192.0.2.1', report)
                self.assertEqual(json.loads(report)['paired'], scenario != 'fault')
            finally:
                child.close(force=True)

    def test_fault_with_zero_exit_is_failure_and_code_is_redacted(self):
        self.exercise('fault')

    def test_invalid_address_reprompts_and_connected_device_is_success(self):
        self.exercise('success', invalid_address=True)

    def test_pairing_success_is_not_connection_success(self):
        self.exercise('connect_failure')


if __name__ == '__main__':
    unittest.main()
