import importlib.util
import json
import os
import pathlib
import sys
import tempfile
import unittest


# Keep the source tree clean for the existing release packager after this import.
sys.dont_write_bytecode = True
ROOT = pathlib.Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('production_health', str(ROOT / 'scripts/deploy/production-runtime-health.py'))
GUARD = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(GUARD)
SHA = 'a' * 40
OTHER_SHA = 'b' * 40


class ProductionRuntimeHealthTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='production-health-test-')
        self.root = pathlib.Path(self.temp.name)
        self.state = self.root / 'state'
        self.owner = os.getuid()
        self.calls = []
        self.responses = {3201: SHA, 3203: SHA}

    def tearDown(self):
        self.temp.cleanup()

    def request(self, port, resource):
        self.calls.append((port, resource))
        sha = self.responses.get(port)
        if isinstance(sha, Exception):
            raise sha
        if sha is None:
            raise ConnectionRefusedError()
        return json.dumps({'gitSha': sha} if resource == 'version' else {'status': 'ready'}).encode()

    def write_state(self, port=3203, sha=SHA, phase='completed'):
        self.state.mkdir(mode=0o700)
        (self.state / 'active.json').write_text(json.dumps({'port': port, 'sha': sha}))
        (self.state / 'phase').write_text(phase)
        for item in self.state.iterdir():
            item.chmod(0o600)

    def check(self):
        return GUARD.check_current(str(self.state), self.owner, self.request)

    def test_active_3203_then_3201_without_probing_inactive_slot(self):
        self.write_state()
        self.assertEqual(self.check()['port'], 3203)
        self.assertEqual({port for port, _ in self.calls}, {3203})
        (self.state / 'active.json').write_text(json.dumps({'port': 3201, 'sha': OTHER_SHA}))
        self.responses[3201] = OTHER_SHA
        self.calls.clear()
        self.assertEqual(self.check()['port'], 3201)
        self.assertEqual({port for port, _ in self.calls}, {3201})

    def test_unhealthy_active_slot_never_uses_healthy_standby(self):
        self.write_state()
        self.responses[3203] = RuntimeError('HTTP 503')
        with self.assertRaises(RuntimeError):
            self.check()
        self.assertEqual({port for port, _ in self.calls}, {3203})

    def test_version_mismatch_fails_closed(self):
        self.write_state()
        self.responses[3203] = OTHER_SHA
        with self.assertRaises(GUARD.GuardError):
            self.check()

    def test_switching_and_maintenance_phases_fail_before_network(self):
        self.write_state()
        for phase in ['prepared', 'switching', 'switched', 'rolling-back', 'maintenance-stopped', 'unknown']:
            (self.state / 'phase').write_text(phase)
            with self.assertRaises(GUARD.GuardError):
                self.check()
        self.assertEqual(self.calls, [])

    def test_receipt_changes_during_health_check_fail_closed(self):
        self.write_state()
        def request(port, resource):
            result = self.request(port, resource)
            if resource == 'version':
                (self.state / 'phase').write_text('switching')
            return result
        with self.assertRaises(GUARD.GuardError):
            GUARD.check_current(str(self.state), self.owner, request)

    def test_invalid_ports_versions_and_shape_fail_before_network(self):
        self.write_state()
        for value in [{'port': 3202, 'sha': SHA}, {'port': True, 'sha': SHA}, {'port': 3203, 'sha': 'bad'}, {'port': 3203, 'sha': SHA, 'url': 'https://example.test'}]:
            (self.state / 'active.json').write_text(json.dumps(value))
            with self.assertRaises(GUARD.GuardError):
                self.check()
        self.assertEqual(self.calls, [])

    def test_no_receipt_in_present_state_does_not_fallback(self):
        self.write_state()
        (self.state / 'active.json').unlink()
        with self.assertRaises(FileNotFoundError):
            self.check()
        self.assertEqual(self.calls, [])

    def test_unsafe_state_permissions_and_owner_fail_closed(self):
        self.write_state()
        self.state.chmod(0o770)
        with self.assertRaises(GUARD.GuardError):
            self.check()
        self.state.chmod(0o700)
        with self.assertRaises(GUARD.GuardError):
            GUARD.check_current(str(self.state), self.owner + 1, self.request)
        (self.state / 'active.json').chmod(0o666)
        with self.assertRaises(GUARD.GuardError):
            self.check()

    def test_symlink_state_and_receipt_fail_closed(self):
        self.write_state()
        alias = self.root / 'state-alias'
        alias.symlink_to(self.state)
        with self.assertRaises(GUARD.GuardError):
            GUARD.check_current(str(alias), self.owner, self.request)
        (self.state / 'active.json').rename(self.state / 'saved.json')
        (self.state / 'active.json').symlink_to(self.state / 'saved.json')
        with self.assertRaises(GUARD.GuardError):
            self.check()

    def test_legacy_requires_3201_and_absent_3203(self):
        self.responses[3203] = None
        self.assertEqual(self.check(), {'port': 3201, 'sha': SHA, 'source': 'legacy', 'phase': 'legacy'})

    def test_legacy_ambiguity_or_only_3203_fails_closed(self):
        with self.assertRaises(GUARD.GuardError):
            self.check()
        self.responses[3201] = None
        with self.assertRaises(GUARD.GuardError):
            self.check()

    def test_unconverted_state_cannot_point_at_3203(self):
        self.write_state(phase='installed-unconverted')
        with self.assertRaises(GUARD.GuardError):
            self.check()

    def test_pinned_receipt_health_version_permissions_and_replacement(self):
        identity = {'port': 3203, 'sha': SHA, 'source': 'active-receipt', 'phase': 'completed'}
        receipt = self.root / 'production-runtime.json'
        receipt.write_text(json.dumps(identity))
        receipt.chmod(0o444)
        self.assertEqual(GUARD.check_receipt(str(receipt), self.owner, self.request), identity)
        self.responses[3203] = OTHER_SHA
        with self.assertRaises(GUARD.GuardError):
            GUARD.check_receipt(str(receipt), self.owner, self.request)
        self.responses[3203] = SHA
        receipt.chmod(0o644)
        with self.assertRaises(GUARD.GuardError):
            GUARD.check_receipt(str(receipt), self.owner, self.request)
        receipt.chmod(0o444)
        def request(port, resource):
            data = self.request(port, resource)
            if resource == 'version':
                receipt.chmod(0o644)
                receipt.write_text(json.dumps({**identity, 'sha': OTHER_SHA}))
                receipt.chmod(0o444)
            return data
        with self.assertRaises(GUARD.GuardError):
            GUARD.check_receipt(str(receipt), self.owner, request)


if __name__ == '__main__':
    unittest.main()
