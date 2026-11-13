#!/usr/bin/env python3
"""Pure capacity/storage boundary tests; no live services, Python 3.6 compatible."""
import importlib.util
import json
import hashlib
import shutil
import io
import subprocess
import tarfile
import sys
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
source_cleanup = load('source_cleanup', 'scripts/deploy/cleanup-update-source.py')
cleanup = load('cleanup_builds', 'scripts/deploy/cleanup-acceptance-builds.py')
release = load('release_capacity', 'scripts/deploy/release-capacity.py')
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


class LifecycleTests(unittest.TestCase):
    def data(self):
        return {'database': 'dx_rework_acceptance', 'databaseBytes': capacity.GIB, 'maxWalBytes': capacity.GIB,
                'dataPaths': ['/data'], 'walPath': '/wal', 'logPath': '/logs'}

    def test_peak_is_maximum_simultaneous_allocations_not_sum_of_every_stage(self):
        rows = capacity.plan([
            {'name': 'retained', 'paths': ['/one'], 'bytesPerFilesystem': 10},
            {'name': 'extract', 'paths': ['/one'], 'bytesPerFilesystem': 100, 'stages': ['build']},
            {'name': 'install', 'paths': ['/one'], 'bytesPerFilesystem': 70, 'stages': ['install', 'database']},
            {'name': 'rewrite', 'paths': ['/one'], 'bytesPerFilesystem': 40, 'stages': ['database']}],
            lambda path: {'device': 'one', 'probe': path, 'available': capacity.GIB, 'total': capacity.GIB})
        self.assertEqual(rows[0]['requiredAdditionalBytes'], 120 + 512 * capacity.MIB)
        self.assertEqual(rows[0]['stageAdditionalBytes']['build'], 110 + 512 * capacity.MIB)

    def test_same_tool_sha_has_no_refresh_allocation_unknown_or_different_still_does(self):
        with tempfile.TemporaryDirectory() as directory:
            tool = Path(directory)
            (tool / 'TOOL_SHA').write_text('a' * 40)
            for sha, refresh in [('a' * 40, False), ('b' * 40, True), (None, True)]:
                rows = capacity.components('archive', str(tool), str(tool), self.data(), target_sha=sha)
                self.assertEqual(any('tool staging' in row['name'] for row in rows), refresh)

    def test_no_schema_change_requires_every_checksum_and_keeps_new_backup_and_margin(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory)
            file = source / 'apps/api/src/platform/migration-manifest.json'
            file.parent.mkdir(parents=True)
            migrations = [{'version': '0001', 'checksum': 'a' * 64}]
            file.write_text(json.dumps({'migrations': migrations}))
            for history, unchanged in [(migrations, True), ([], False), ([{'version': '0001', 'checksum': 'b' * 64}], False)]:
                rows = capacity.components('backup', str(source), str(source), dict(self.data(), migrations=history))
                rewrite = next(row for row in rows if row['name'].startswith('database rewrite'))
                self.assertEqual(rewrite['bytesPerFilesystem'] == 0, unchanged)
                self.assertTrue(any(row['name'].startswith('new consistent backup') and row['bytesPerFilesystem'] > 0 for row in rows))
                self.assertGreater(capacity.plan(rows)[0]['requiredAdditionalBytes'], 0)

    def bundle(self, root, source, sha):
        for part in ('api', 'frontend'):
            (root / part).mkdir(parents=True)
        for part in ('', 'api', 'frontend'):
            (root / part / 'release-manifest.json').write_text(json.dumps({'gitSha': sha, 'appBasePath': '/acceptance/'}))
        for name, value in [('package-lock.json', '{}'), ('apps/api/src/platform/migration-manifest.json', '{"migrations":[]}')]:
            for base in (root / 'api', source):
                (base / name).parent.mkdir(parents=True, exist_ok=True)
                (base / name).write_text(value)
        (root / 'build-provenance.json').write_text(json.dumps({'sourceSha': sha, 'frontendSourceSha': sha, 'frontendBuilt': True}))
        files = sorted(file for file in root.rglob('*') if file.is_file())
        (root / 'SHA256SUMS').write_text(''.join(hashlib.sha256(file.read_bytes()).hexdigest() + '  ' + str(file.relative_to(root)) + '\n' for file in files))

    def test_verified_candidate_retries_only_allocate_missing_installed_copies(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'acceptance'
            source = Path(directory) / 'source'
            sha = 'a' * 40
            candidate = root / 'candidates' / sha
            self.bundle(candidate, source, sha)
            with patch.object(capacity, 'ROOT', str(root)):
                rows = capacity.components('build', str(source), str(source), self.data(), target_sha=sha)
                self.assertFalse(any(row['name'].startswith(('build source', 'candidate bundle', 'npm')) for row in rows))
                api = next(row for row in rows if row['name'].startswith('installed API'))
                self.assertEqual(api['bytesPerFilesystem'], capacity.tree_bytes(candidate / 'api'))
                shutil.copytree(str(candidate / 'api'), str(root / 'releases' / sha))
                rows = capacity.components('build', str(source), str(source), self.data(), target_sha=sha)
                self.assertEqual(next(row for row in rows if row['name'].startswith('installed API'))['bytesPerFilesystem'], 0)
                (root / 'releases' / sha / 'unexpected').write_text('different')
                with self.assertRaisesRegex(ValueError, 'differs'):
                    capacity.components('build', str(source), str(source), self.data(), target_sha=sha)

    def test_invalid_candidate_is_never_credited_and_symlinks_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root, source = Path(directory) / 'candidate', Path(directory) / 'source'
            self.bundle(root, source, 'a' * 40)
            (root / 'frontend/extra').write_text('untracked')
            with self.assertRaisesRegex(ValueError, 'checksum'):
                capacity.verified_candidate(root, 'a' * 40, source)
            (root / 'frontend/extra').unlink()
            (root / 'frontend/extra').symlink_to(source)
            with self.assertRaisesRegex(ValueError, 'symlink'):
                capacity.verified_candidate(root, 'a' * 40, source)

    def test_production_persistent_dependencies_are_not_charged_as_three_copies(self):
        with tempfile.TemporaryDirectory() as directory:
            root, source = Path(directory) / 'runtime', Path(directory) / 'source'
            (source / 'node_modules/.bin').mkdir(parents=True)
            for name in ('tsc', 'vite'):
                (source / 'node_modules/.bin' / name).write_text('TEST executable')
                (source / 'node_modules/.bin' / name).chmod(0o755)
            lock = b'{}'
            (source / 'package-lock.json').write_bytes(lock)
            (root / 'shared').mkdir(parents=True)
            (root / 'shared/build-package-lock.sha256').write_text(hashlib.sha256(lock).hexdigest())
            rows = release.allocations('build', source, root, 'a' * 40, '/cache', '/tmp')
            self.assertEqual(len(rows), 2)
            (source / 'package-lock.json').write_text('changed')
            rows = release.allocations('build', source, root, 'a' * 40, '/cache', '/tmp')
            self.assertEqual(len(rows), 5)
            self.assertEqual(rows[0]['bytesPerFilesystem'], 2 * capacity.GIB)


    def test_collection_only_removes_verified_unreferenced_build_not_candidate_or_backup(self):
        with tempfile.TemporaryDirectory() as directory:
            root, proc = Path(directory) / 'root', Path(directory) / 'proc'
            proc.mkdir()
            sha = 'a' * 40
            build = root / 'build' / ('update-' + sha)
            candidate = root / 'candidates' / sha
            self.bundle(candidate, build, sha)
            (build / 'node_modules').mkdir()
            (build / 'node_modules/test').write_text('rebuildable')
            for name in ('build/npm-cache', 'backups/postgres', 'releases/old', 'build/update-' + 'b' * 40):
                (root / name).mkdir(parents=True)
                (root / name / 'keep').write_text('retain')
            result = cleanup.collect(root, proc, os.getuid())
            self.assertEqual(result[0]['status'], 'removed')
            self.assertEqual(result[1]['status'], 'retained')
            self.assertFalse(build.exists())
            self.assertTrue(candidate.exists())
            for name in ('build/npm-cache', 'backups/postgres', 'releases/old', 'build/update-' + 'b' * 40):
                self.assertEqual((root / name / 'keep').read_text(), 'retain')

    def test_collection_preserves_live_process_rollback_reference_and_symlink(self):
        with tempfile.TemporaryDirectory() as directory:
            root, proc = Path(directory) / 'root', Path(directory) / 'proc'
            (proc / '123').mkdir(parents=True)
            sha = 'a' * 40
            build = root / 'build' / ('update-' + sha)
            self.bundle(root / 'candidates' / sha, build, sha)
            (proc / '123/cwd').symlink_to(build)
            self.assertEqual(cleanup.collect(root, proc, os.getuid())[0]['status'], 'retained')
            (proc / '123/cwd').unlink()
            (root / 'generations/old').mkdir(parents=True)
            (root / 'generations/old/api').symlink_to(build)
            self.assertEqual(cleanup.collect(root, proc, os.getuid())[0]['status'], 'retained')
            (root / 'generations/old/api').unlink()
            (proc / '123/cmdline').write_bytes(str(build / 'script.py').encode() + b'\0')
            self.assertEqual(cleanup.collect(root, proc, os.getuid())[0]['status'], 'retained')
            (root / 'build' / ('update-' + 'b' * 40)).symlink_to(build)
            result = cleanup.collect(root, proc, os.getuid())
            self.assertTrue(all(row['status'] == 'retained' for row in result))


    def test_failed_source_cleanup_preserves_diagnostics_and_never_follows_parent_link(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'source'
            (root / '.acceptance-preflight').mkdir(parents=True)
            (root / 'scripts').mkdir()
            (root / 'scripts/code.py').write_text('source')
            (root / 'worker-evidence').write_text('/TEST/logs')
            inventory = root / '.acceptance-preflight/tree-sizes.txt'
            inventory.write_text('100644 blob ' + 'a' * 40 + ' 6\tscripts/code.py\n')
            self.assertEqual(source_cleanup.trim(root)['status'], 'source_removed_evidence_retained')
            self.assertFalse((root / 'scripts').exists())
            self.assertEqual((root / 'worker-evidence').read_text(), '/TEST/logs')
            self.assertTrue(inventory.exists())
            outside = Path(directory) / 'outside'
            outside.mkdir()
            (outside / 'code.py').write_text('must stay')
            (root / 'scripts').symlink_to(outside)
            with self.assertRaisesRegex(ValueError, 'Unsafe source parent'):
                source_cleanup.trim(root)
            self.assertEqual((outside / 'code.py').read_text(), 'must stay')


    def test_same_active_sha_with_verified_current_schema_reserves_no_backup_or_migration(self):
        with tempfile.TemporaryDirectory() as directory:
            root, source = Path(directory) / 'root', Path(directory) / 'source'
            sha = 'a' * 40
            candidate = root / 'candidates' / sha
            self.bundle(candidate, source, sha)
            migrations = [{'version': '0001', 'checksum': 'a' * 64}]
            for base in (source, candidate / 'api'):
                (base / 'apps/api/src/platform/migration-manifest.json').write_text(json.dumps({'migrations': migrations}))
            files = sorted(file for file in candidate.rglob('*') if file.is_file() and file.name != 'SHA256SUMS')
            (candidate / 'SHA256SUMS').write_text(''.join(hashlib.sha256(file.read_bytes()).hexdigest() + '  ' + str(file.relative_to(candidate)) + '\n' for file in files))
            for part, target in [('api', root / 'releases' / sha), ('frontend', root / 'frontend/releases' / sha)]:
                shutil.copytree(str(candidate / part), str(target))
            (root / 'current').symlink_to(root / 'releases' / sha)
            (root / 'frontend/current').symlink_to(root / 'frontend/releases' / sha)
            with patch.object(capacity, 'ROOT', str(root)):
                rows = capacity.components('build', str(source), str(source), dict(self.data(), migrations=migrations), target_sha=sha)
                self.assertFalse(any(row['name'].startswith(('new consistent backup', 'database rewrite', 'WAL growth')) for row in rows))
                self.assertTrue(all(row['bytesPerFilesystem'] == 0 for row in rows if row['name'].startswith('installed')))
                rows = capacity.components('build', str(source), str(source), self.data(), target_sha=sha)
                self.assertTrue(any(row['name'].startswith('new consistent backup') for row in rows))


    def test_both_remote_extractors_reject_real_shortage_before_writing_then_extract(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = root / 'transfer.tar.gz'
            with tarfile.open(str(archive), 'w:gz') as tar:
                info = tarfile.TarInfo('bundle/file');info.size = 4
                tar.addfile(info, io.BytesIO(b'TEST'))
            for script in ('remote-release.sh', 'acceptance-remote-release.sh'):
                text = (ROOT / 'scripts/deploy' / script).read_text()
                code = text.split("<<'PY'\n", 1)[1].split('\nPY', 1)[0]
                for available in (1, capacity.GIB):
                    destination = root / (script + str(available))
                    destination.mkdir()
                    adapted = "import os\nfrom types import SimpleNamespace\nos.statvfs=lambda path:SimpleNamespace(f_blocks=1073741824,f_frsize=1,f_bavail=%d)\n" % available
                    # Older Python tarfile has no data filter; equivalent safe
                    # entries are already validated by the actual script above.
                    if sys.version_info < (3, 12):
                        code = code.replace('tar.extractall(destination, filter="data")', 'tar.extractall(destination)')
                    result = subprocess.run([sys.executable, '-B', '-c', adapted + code, str(archive), str(destination)], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                    if available == 1:
                        self.assertNotEqual(result.returncode, 0)
                        self.assertIn(b'capacity_insufficient', result.stderr)
                        self.assertEqual(list(destination.iterdir()), [])
                    else:
                        self.assertEqual(result.returncode, 0, result.stderr)
                        self.assertEqual((destination / 'bundle/file').read_bytes(), b'TEST')


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
        self.assertNotIn('schema_migrations', storage.storage_query(self.identity()))
        self.assertIn('FROM public.schema_migrations', storage.storage_query(self.identity(), True))
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
