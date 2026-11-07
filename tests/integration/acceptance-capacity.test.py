#!/usr/bin/env python3
"""Pure capacity/storage boundary tests; no live services, Python 3.6 compatible."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, str(ROOT / file))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


capacity = load('capacity', 'scripts/deploy/acceptance-capacity.py')
storage = load('storage', 'scripts/deploy/inspect-acceptance-storage.py')


class CapacityTests(unittest.TestCase):
    def probe(self, path):
        return {'device': 'one', 'probe': path, 'available': 100 * capacity.GIB, 'total': 200 * capacity.GIB}

    def test_same_mount_sums_components_and_deduplicates_each_data_filesystem(self):
        rows = capacity.plan([{'name': 'data', 'paths': ['/data/a', '/data/b'], 'bytesPerFilesystem': 100},
                              {'name': 'backup', 'paths': ['/backup'], 'bytesPerFilesystem': 200}], self.probe)
        self.assertEqual(len(rows), 1)
        self.assertEqual([x['bytes'] for x in rows[0]['components']], [100, 200, 2 * capacity.GIB])

    def test_distinct_mounts_fail_independently_and_report_all_deficits(self):
        def probe(path):
            return {'device': path, 'probe': path, 'available': 10, 'total': capacity.GIB}
        rows = capacity.plan([{'name': 'allocation', 'paths': ['/tmp', '/wal'], 'bytesPerFilesystem': 20}], probe)
        self.assertEqual(len(rows), 2)
        self.assertTrue(all(row['shortfallBytes'] > 0 for row in rows))

    def test_exact_boundary_and_one_byte_short(self):
        items = [{'name': 'data', 'paths': ['/data'], 'bytesPerFilesystem': 100}]
        required = 100 + 512 * capacity.MIB
        for difference in (0, -1):
            rows = capacity.plan(items, lambda path: {'device': 'one', 'probe': path, 'available': required + difference, 'total': capacity.GIB})
            self.assertEqual(rows[0]['shortfallBytes'], -difference)

    def test_device_uses_smallest_available_probe(self):
        rows = capacity.plan([{'name': 'data', 'paths': ['/a', '/b'], 'bytesPerFilesystem': 1}],
                             lambda path: dict(self.probe(path), available=100 if path == '/a' else 50))
        self.assertEqual(rows[0]['availableBytes'], 50)

    def test_missing_and_invalid_metrics_are_not_assumed_sufficient(self):
        items = [{'name': 'data', 'paths': ['/a'], 'bytesPerFilesystem': 1}]
        for value in (-1, True, None, '100'):
            with self.assertRaises((ValueError, TypeError)):
                capacity.plan(items, lambda path: dict(self.probe(path), available=value))
        with self.assertRaises(OSError):
            capacity.plan(items, lambda path: (_ for _ in ()).throw(OSError('TEST unreadable mount')))

    def test_real_mount_probe_resolves_symlinks_and_missing_descendants(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'real').mkdir()
            (root / 'alias').symlink_to(root / 'real', target_is_directory=True)
            a = capacity.filesystem(str(root / 'alias' / 'missing' / 'next'))
            b = capacity.filesystem(str(root / 'real'))
            self.assertEqual(a['device'], b['device'])
            self.assertEqual(a['probe'], str(root / 'real'))
            self.assertGreater(a['total'], 0)

    def test_retention_is_not_credited_as_future_free_space(self):
        with tempfile.TemporaryDirectory() as directory:
            original = Path(directory) / 'old-backup'
            original.write_text('TEST retained')
            capacity.plan([{'name': 'backup', 'paths': [directory], 'bytesPerFilesystem': 10}])
            self.assertEqual(original.read_text(), 'TEST retained')

    def test_exact_tree_is_validated_and_accounts_for_file_blocks(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / 'tree'
            file.write_text('100644 blob ' + 'a' * 40 + ' 123\tfile with spaces\n')
            self.assertEqual(capacity.exact_tree_bytes(file), 4219)
            for value in ('', '100644 blob abc invalid\tfile\n', '160000 commit abc -\tmodule\n'):
                file.write_text(value)
                with self.assertRaises(ValueError):
                    capacity.exact_tree_bytes(file)

    def test_each_stage_charges_only_remaining_heavy_work(self):
        data = {'database': 'dx_rework_acceptance', 'databaseBytes': 100, 'maxWalBytes': 200,
                'dataPaths': ['/data'], 'walPath': '/wal', 'logPath': '/logs'}
        with patch.object(capacity, 'tree_bytes', return_value=0), patch.object(capacity, 'git_bytes', return_value=0):
            for phase in capacity.PHASES:
                rows = capacity.components(phase, '/missing-source', '/missing-tool', data)
                names = [row['name'] for row in rows]
                self.assertEqual('independent full Git object store' in names, phase in ('download', 'diagnose-download'))
                self.assertEqual('authenticated source Git fetch metadata' in names, phase in ('download', 'diagnose-download'))
                self.assertEqual('build source/dependencies/output' in names, phase == 'build')
                self.assertEqual('new consistent backup temporary set' in names, phase in ('build', 'backup'))
            with self.assertRaises(ValueError):
                capacity.components('build', '/missing-source', '/missing-tool')

    def test_matching_acceptance_lock_uses_measured_dependencies_not_old_production_lock(self):
        data = {'database': 'dx_rework_acceptance', 'databaseBytes': 100, 'maxWalBytes': 200,
                'dataPaths': ['/data'], 'walPath': '/wal', 'logPath': '/logs'}
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repository, acceptance, tool = root / 'repo', root / 'acceptance', root / 'tool'
            for path in (repository, acceptance / 'current', tool):
                path.mkdir(parents=True)
            (repository / 'package-lock.json').write_text('old production')
            (acceptance / 'current/package-lock.json').write_text('same accepted lock')
            (tool / 'package-lock.json').write_text('same accepted lock')
            def size(path, excluded=()):
                return 400 * capacity.MIB if str(path).endswith('/node_modules') else 0
            with patch.object(capacity, 'ROOT', str(acceptance)), patch.object(capacity, 'REPOSITORY', str(repository)), patch.object(capacity, 'tree_bytes', side_effect=size):
                rows = capacity.components('build', str(tool), str(tool), data)
                cache = next(row for row in rows if row['name'] == 'npm locked-package cache')
                self.assertEqual(cache['bytesPerFilesystem'], 600 * capacity.MIB)
                (tool / 'package-lock.json').write_text('new unknown lock')
                rows = capacity.components('build', str(tool), str(tool), data)
                cache = next(row for row in rows if row['name'] == 'npm locked-package cache')
                self.assertEqual(cache['bytesPerFilesystem'], 2 * capacity.GIB)
                (tool / 'package-lock.json').unlink()
                rows = capacity.components('build', str(tool), str(tool), data)
                cache = next(row for row in rows if row['name'] == 'npm locked-package cache')
                self.assertEqual(cache['bytesPerFilesystem'], 2 * capacity.GIB)

    def test_download_does_not_add_expired_git_store_to_build_and_database_budget(self):
        data = {'database': 'dx_rework_acceptance', 'databaseBytes': 100, 'maxWalBytes': 200,
                'dataPaths': ['/data'], 'walPath': '/wal', 'logPath': '/logs'}
        with patch.object(capacity, 'tree_bytes', return_value=0), patch.object(capacity, 'git_bytes', return_value=0):
            download = capacity.components('download', '/missing', '/missing', data)
            archive = capacity.components('archive', '/missing', '/missing', data)
            build = capacity.components('build', '/missing', '/missing', data)
        names = lambda rows: {row['name'] for row in rows}
        self.assertNotIn('database rewrite per data filesystem', names(download))
        self.assertNotIn('database rewrite per data filesystem', names(archive))
        self.assertNotIn('independent full Git object store', names(build))
        for name in ('database rewrite per data filesystem', 'WAL growth and retained segments', 'new consistent backup temporary set'):
            self.assertIn(name, names(build))
        available = 6 * capacity.GIB
        probe = lambda path: dict(self.probe(path), available=available)
        self.assertEqual(capacity.plan(download, probe)[0]['shortfallBytes'], 0)
        self.assertGreater(capacity.plan(build, probe)[0]['shortfallBytes'], 0)
        for phase in ('download', 'archive'):
            for key, value in (('database', 'dx_rework'), ('databaseBytes', None), ('dataPaths', []), ('walPath', 'relative'), ('logPath', None)):
                with self.assertRaises(ValueError):
                    capacity.components(phase, '/missing', '/missing', dict(data, **{key: value}))

    def test_frontend_and_exact_target_paths_have_their_own_filesystem_charge(self):
        data = {'database': 'dx_rework_acceptance', 'databaseBytes': 100, 'maxWalBytes': 200,
                'dataPaths': ['/data'], 'walPath': '/wal', 'logPath': '/logs'}
        with patch.object(capacity, 'tree_bytes', return_value=0):
            rows = capacity.components('build', '/missing', '/missing', data, target_sha='a' * 40)
        frontend = next(row for row in rows if row['name'].startswith('installed frontend'))
        self.assertEqual(frontend['paths'], ['/opt/dx-rework-acceptance/frontend/releases/' + 'a' * 40])
        self.assertTrue(any('/build/update-' in row['paths'][0] for row in rows))


class StorageTests(unittest.TestCase):
    def identity(self):
        return {'database': 'dx_rework_acceptance', 'port': 5432, 'oid': 42,
                'address': '127.0.0.1', 'role': 'dx_rework_acceptance_app', 'sessionRole': 'dx_rework_acceptance_app'}

    def result(self):
        return {'database': 'dx_rework_acceptance', 'port': 5432, 'oid': 42, 'storageRole': 'postgres',
                'serverVersion': 130023, 'databaseBytes': 1024, 'maxWalBytes': 1048576,
                'dataDirectory': '/TEST/pgdata', 'logDirectory': 'log', 'directoryPaths': ['base/42', 'pg_tblspc/123/PG_13/42']}

    def test_fixed_readonly_peer_query_and_current_identity(self):
        calls = []
        def run(args, **kwargs):
            calls.append((args, kwargs))
            return SimpleNamespace(returncode=0, stdout=json.dumps(self.result()))
        result = storage.collect(self.identity(), '/TEST/psql', run)
        args, kwargs = calls[0]
        self.assertIn('BEGIN READ ONLY', args)
        self.assertIn('PGOPTIONS=-c default_transaction_read_only=on -c statement_timeout=10000 -c lock_timeout=3000', args)
        self.assertIn('SET LOCAL search_path=pg_catalog', args)
        self.assertIn('--port=5432', args)
        self.assertNotIn('text', kwargs)
        self.assertEqual(result['dataPaths'], ['/TEST/pgdata/base/42', '/TEST/pgdata/pg_tblspc/123/PG_13/42'])
        self.assertEqual(result['walPath'], '/TEST/pgdata/pg_wal')

    def test_wrong_database_port_oid_host_role_and_owner_session_are_rejected_before_query(self):
        for key, value in [('database', 'dx_rework'), ('port', True), ('port', 0), ('oid', '42'),
                           ('address', '10.0.0.1'), ('role', 'postgres'), ('sessionRole', 'postgres')]:
            identity = dict(self.identity(), **{key: value})
            with self.assertRaises(ValueError):
                storage.collect(identity, '/TEST/psql', lambda *a, **k: self.fail('No query after invalid identity'))

    def test_identity_drift_malformed_metrics_and_paths_fail_closed(self):
        for key, value in [('oid', 43), ('port', 5433), ('databaseBytes', None),
                           ('dataDirectory', 'relative'), ('directoryPaths', ['../other']), ('directoryPaths', [])]:
            result = dict(self.result(), **{key: value})
            with self.assertRaises((ValueError, TypeError)):
                storage.collect(self.identity(), '/TEST/psql', lambda *a, **k: SimpleNamespace(returncode=0, stdout=json.dumps(result)))

    def test_permission_failure_does_not_retry_change_roles_or_grant_access(self):
        calls = []
        def denied(args, **kwargs):
            calls.append(args)
            return SimpleNamespace(returncode=1, stdout='')
        with self.assertRaises(ValueError):
            storage.collect(self.identity(), '/TEST/psql', denied)
        self.assertEqual(len(calls), 1)
        sql = storage.storage_query(self.identity()).upper()
        for forbidden in ('GRANT ', 'ALTER ', 'UPDATE ', 'SET ROLE', 'SET_CONFIG', 'SECURITY DEFINER'):
            self.assertNotIn(forbidden, sql)


if __name__ == '__main__':
    unittest.main()
