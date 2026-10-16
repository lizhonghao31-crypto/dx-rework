"""Filesystem and content probes, synthetic files only; works on Python 3.6."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import shlex
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('static_release', str(Path(__file__).resolve().parents[2] / 'scripts/deploy/static-release.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class StaticReleaseTests(unittest.TestCase):
    def setUp(self):
        self.directory = Path(tempfile.mkdtemp(prefix='static-release-test-'))

    def tearDown(self):
        shutil.rmtree(str(self.directory))

    def bundle(self, name='frontend', mask=0o077, base='/'):
        old = os.umask(mask)
        try:
            root = self.directory / name
            (root / 'assets').mkdir(parents=True)
            (root / 'index.html').write_text('<script type="module" src="' + base + 'assets/app.js"></script><link rel="stylesheet" href="' + base + 'assets/app.css">')
            (root / 'assets/app.js').write_text('console.log("synthetic")')
            (root / 'assets/app.css').write_text('body{color:blue}')
            (root / 'assets/app.js.map').write_text('{"version":3,"sources":[],"mappings":""}')
            (root / 'assets/app.css.map').write_text('{"version":3,"sources":[],"mappings":""}')
            (root / 'release-manifest.json').write_text(json.dumps({'viteBasePath': base}))
            return root
        finally:
            os.umask(old)

    def test_modes_owner_content_and_environment_isolation(self):
        for mask in (0o022, 0o077):
            root = self.bundle('main-' + str(mask), mask)
            acceptance = self.bundle('acceptance-' + str(mask), mask, '/acceptance/')
            private = self.directory / ('private-' + str(mask))
            private.write_text('synthetic private config')
            private.chmod(0o600)
            before = [(p, p.read_bytes(), p.stat().st_uid, p.stat().st_gid) for p, s in module.tree(root) if stat.S_ISREG(s.st_mode)]
            other = [(p, p.stat().st_mode) for p, _ in module.tree(acceptance)]
            module.normalize(root)
            module.normalize(root)  # reused candidate/release is idempotent
            for p, s in module.tree(root):
                self.assertEqual(stat.S_IMODE(s.st_mode), 0o755 if p.is_dir() else 0o644)
            for p, content, uid, gid in before:
                self.assertEqual((p.read_bytes(), p.stat().st_uid, p.stat().st_gid), (content, uid, gid))
            self.assertEqual(stat.S_IMODE(private.stat().st_mode), 0o600)
            self.assertEqual(other, [(p, p.stat().st_mode) for p, _ in module.tree(acceptance)])
            module.normalize(acceptance)
            self.assertEqual(module.resources(acceptance)[0][0], '/acceptance/')

    def test_actual_install_and_reuse_keep_private_api_permissions(self):
        source = Path(__file__).resolve().parents[2]
        sha = 'a' * 40
        for mask in (0o022, 0o077):
            bundle = self.directory / ('bundle-' + str(mask))
            bundle.mkdir()
            web = self.bundle(str(bundle.relative_to(self.directory) / 'frontend'), mask)
            api = bundle / 'api'; api.mkdir(mode=0o700)
            (api / 'private.txt').write_text('synthetic private API'); (api / 'private.txt').chmod(0o600)
            for part in (web, api):
                (part / 'release-manifest.json').write_text(json.dumps({'gitSha': sha, 'viteBasePath': '/'}))
                sums = []
                for path in sorted(part.rglob('*')):
                    if path.is_file():
                        sums.append(module.hashlib.sha256(path.read_bytes()).hexdigest() + '  ' + str(path.relative_to(part)))
                (part / 'SHA256SUMS').write_text('\n'.join(sums) + '\n')
            target = self.directory / ('install-' + str(mask))
            env = dict(os.environ, DX_REWORK_ROOT=str(target))
            command = ['bash', '-c', 'umask "$1"; bash "$2" "$3" "$4" register-only', 'fixture',
                       oct(mask)[2:], str(source / 'scripts/deploy/install-release.sh'), sha, str(bundle)]
            subprocess.check_output(command, env=env)
            installed = target / 'frontend/releases' / sha
            self.assertEqual(stat.S_IMODE(installed.stat().st_mode), 0o755)
            self.assertEqual(stat.S_IMODE((target / 'releases' / sha / 'private.txt').stat().st_mode), 0o600)
            # Content equality does not skip repairing a previously restrictive release.
            installed.chmod(0o700); (installed / 'index.html').chmod(0o600)
            subprocess.check_output(command, env=env)
            self.assertEqual(stat.S_IMODE(installed.stat().st_mode), 0o755)
            self.assertEqual(stat.S_IMODE((installed / 'index.html').stat().st_mode), 0o644)
            self.assertFalse((target / 'active').exists())
            # Inject failure at destination normalization: no published web/generation/alias.
            shim = self.directory / ('shim-' + str(mask)); shim.mkdir()
            wrapper = shim / 'python3'
            wrapper.write_text('#!/bin/sh\nif [ "$2" = normalize ]; then exit 43; fi\nexec ' + shlex.quote(sys.executable) + ' "$@"\n')
            wrapper.chmod(0o755)
            failed_root = self.directory / ('failed-' + str(mask))
            failed_env = dict(env, DX_REWORK_ROOT=str(failed_root), PATH=str(shim) + ':' + os.environ['PATH'])
            failed = subprocess.run(command, env=failed_env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            self.assertEqual(failed.returncode, 43)
            self.assertFalse((failed_root / 'frontend/releases' / sha).exists())
            self.assertFalse((failed_root / 'generations' / sha).exists())
            self.assertFalse((failed_root / 'active').exists())
            # Reject a confidential file before even installing the API payload.
            (web / '.env').write_text('synthetic')
            reject_root = self.directory / ('reject-' + str(mask))
            rejected = subprocess.run(command, env=dict(env, DX_REWORK_ROOT=str(reject_root)), stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            self.assertNotEqual(rejected.returncode, 0)
            self.assertFalse((reject_root / 'releases' / sha).exists())
            (web / '.env').unlink()
            # Changed immutable content must fail; it cannot alter active aliases.
            (installed / 'index.html').write_text('unexpected change')
            result = subprocess.run(command, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse((target / 'active').exists())

    def test_packaging_under_both_umasks(self):
        source = Path(__file__).resolve().parents[2]
        for mask in (0o022, 0o077):
            checkout = self.directory / ('checkout-' + str(mask)); checkout.mkdir()
            shutil.copytree(str(source / 'scripts'), str(checkout / 'scripts'))
            shutil.copytree(str(source / 'infra'), str(checkout / 'infra'))
            for name in ('package.json', 'package-lock.json'):
                shutil.copyfile(str(source / name), str(checkout / name))
            for name in ('apps/api/dist', 'apps/api/migrations', 'apps/api/src/platform', 'node_modules'):
                (checkout / name).mkdir(parents=True)
            for name in ('config', 'contracts', 'domain'):
                part = checkout / 'packages' / name; (part / 'dist').mkdir(parents=True)
                (part / 'package.json').write_text('{}')
            (checkout / 'apps/api/package.json').write_text('{}')
            (checkout / 'apps/api/src/platform/migration-manifest.json').write_text(json.dumps({'migrations': [{'version': 'fixture', 'checksum': 'synthetic'}]}))
            self.bundle(str(checkout.relative_to(self.directory) / 'apps/web/dist'), mask)
            build = self.directory / ('build-' + str(mask)); build.mkdir()
            output = build / 'candidate'
            env = dict(os.environ, DX_REWORK_BUILD_ROOT=str(build))
            subprocess.check_output(['bash', '-c', 'umask "$1"; bash scripts/deploy/package-release.sh "$2" 2026-10-16T00:00:00Z "$3"',
                                     'fixture', oct(mask)[2:], 'a' * 40, str(output)], cwd=str(checkout), env=env)
            for path, info in module.tree(output / 'frontend'):
                self.assertEqual(stat.S_IMODE(info.st_mode), 0o755 if path.is_dir() else 0o644)
            subprocess.check_call(['sha256sum', '-c', '--strict', 'SHA256SUMS'], cwd=str(output), stdout=subprocess.DEVNULL)

    def test_rejects_before_any_permission_change(self):
        for bad in ('.env', 'config.json', 'assets/private.key', 'assets/config.json', 'assets/extra.html', 'assets/private.map', 'assets/missing.js.map'):
            root = self.bundle('bad-' + bad.replace('/', '-').replace('.', '-'))
            (root / bad).write_text('synthetic confidential value')
            with self.assertRaises(ValueError): module.normalize(root)
            self.assertEqual(stat.S_IMODE(root.stat().st_mode), 0o700)

    def test_links_hardlinks_and_special_modes(self):
        root = self.bundle()
        outside = self.directory / 'private'; outside.write_text('private'); outside.chmod(0o600)
        link = root / 'assets/bad.js'
        link.symlink_to(outside)
        with self.assertRaises(ValueError): module.normalize(root)
        link.unlink(); os.link(str(outside), str(link))
        with self.assertRaises(ValueError): module.normalize(root)
        link.unlink(); (root / 'assets/app.js').chmod(0o4600)
        with self.assertRaises(ValueError): module.normalize(root)
        self.assertEqual(stat.S_IMODE(outside.stat().st_mode), 0o600)
        alias = self.directory / 'alias'; alias.symlink_to(root)
        with self.assertRaises(ValueError): module.tree(alias)

    def test_references_fail_closed(self):
        root = self.bundle()
        for ref in ('/assets/missing.js', '/assets/%2e%2e/private.js', 'https://outside.test/app.js', '/other/app.js'):
            (root / 'index.html').write_text('<script src="' + ref + '"></script>')
            with self.assertRaises(ValueError): module.resources(root)
        (root / 'index.html').write_text('<html>empty</html>')
        with self.assertRaises(ValueError): module.resources(root)

    def test_http_requires_status_and_bytes_even_for_spa_fallback(self):
        root = self.bundle()
        responses = [p.read_bytes() + b'\n200' for _, p in module.resources(root)]
        with patch.object(subprocess, 'check_output', side_effect=responses): module.http(root, 'example.test')
        for bad in (b'wrong release\n200', b'forbidden\n403', b'redirect\n302', (root / 'index.html').read_bytes() + b'\n200'):
            with patch.object(subprocess, 'check_output', side_effect=[responses[0], bad]):
                with self.assertRaises(ValueError): module.http(root, 'example.test')

    def test_read_failure_propagates_and_no_worker_is_not_success(self):
        root = self.bundle()
        with patch.object(module, 'identities', return_value={(12345, 12345, ())}):
            with patch.object(subprocess, 'check_call', side_effect=subprocess.CalledProcessError(1, 'read')):
                with self.assertRaises(subprocess.CalledProcessError): module.readable(root)


if __name__ == '__main__':
    unittest.main()
