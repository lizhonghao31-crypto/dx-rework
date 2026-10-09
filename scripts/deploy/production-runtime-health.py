#!/usr/bin/env python3
"""Read-only health guard for the trusted production generation (Python 3.6+)."""
import errno
import json
import os
import re
import stat
import sys
import urllib.error
import urllib.request


STATE_DIRECTORY = '/opt/dx-rework-release-state'
STABLE_PHASES = ('completed', 'reverted', 'installed-unconverted')
IDENTITY_KEYS = {'port', 'sha', 'source', 'phase'}


class GuardError(ValueError):
    pass


def trusted_directory(path, owner_uid=0, private=False):
    info = os.lstat(path)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != owner_uid:
        raise GuardError('Production guard directory is not trusted')
    if info.st_mode & 0o022 or (private and stat.S_IMODE(info.st_mode) != 0o700):
        raise GuardError('Production guard directory permissions are unsafe')


def trusted_read(path, owner_uid=0, immutable=False):
    before = os.lstat(path)
    if not stat.S_ISREG(before.st_mode) or before.st_uid != owner_uid:
        raise GuardError('Production guard file is not trusted')
    if before.st_mode & (0o222 if immutable else 0o022):
        raise GuardError('Production guard file permissions are unsafe')
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        opened = os.fstat(descriptor)
        if (opened.st_dev, opened.st_ino, opened.st_uid, opened.st_mode) != (
                before.st_dev, before.st_ino, before.st_uid, before.st_mode):
            raise GuardError('Production guard file changed while opening')
        with os.fdopen(descriptor, 'r') as stream:
            descriptor = None
            value = stream.read(4097)
        if len(value) > 4096:
            raise GuardError('Production guard file is oversized')
        after = os.lstat(path)
        if (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns) != (
                before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns):
            raise GuardError('Production guard file changed while reading')
        return value
    finally:
        if descriptor is not None:
            os.close(descriptor)


def validate_identity(identity):
    if not isinstance(identity, dict) or set(identity) != IDENTITY_KEYS:
        raise GuardError('Invalid production runtime identity')
    if type(identity['port']) is not int or identity['port'] not in (3201, 3203):
        raise GuardError('Invalid production runtime port')
    if not isinstance(identity['sha'], str) or not re.fullmatch('[0-9a-f]{40}', identity['sha']):
        raise GuardError('Invalid production runtime version')
    if identity['source'] == 'legacy':
        if identity['port'] != 3201 or identity['phase'] != 'legacy':
            raise GuardError('Invalid legacy production identity')
    elif identity['source'] == 'active-receipt':
        if identity['phase'] not in STABLE_PHASES:
            raise GuardError('Production generation is switching or maintenance is pending')
        if identity['phase'] == 'installed-unconverted' and identity['port'] != 3201:
            raise GuardError('Invalid unconverted production slot')
    else:
        raise GuardError('Invalid production identity source')
    return identity


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, file_pointer, code, message, headers, new_url):
        raise GuardError('Production health check cannot redirect')


def request_local(port, resource):
    if port not in (3201, 3203) or resource not in ('health/ready', 'version'):
        raise GuardError('Invalid production health destination')
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    request = urllib.request.Request('http://127.0.0.1:{}/{}'.format(port, resource),
                                     headers={'Cache-Control': 'no-cache'})
    with opener.open(request, timeout=3) as response:
        if response.getcode() != 200:
            raise GuardError('Production runtime is not ready')
        content = response.read(65537)
        if len(content) > 65536:
            raise GuardError('Production response is oversized')
        return content


def version_at(port, request=request_local):
    request(port, 'health/ready')
    value = json.loads(request(port, 'version').decode('utf8'))
    sha = value.get('gitSha') if isinstance(value, dict) else None
    if not isinstance(sha, str) or not re.fullmatch('[0-9a-f]{40}', sha):
        raise GuardError('Production runtime returned an invalid version')
    return sha


def resolve_current(state_directory=STATE_DIRECTORY, owner_uid=0, request=request_local):
    try:
        os.lstat(state_directory)
    except FileNotFoundError:
        # Do not choose whichever slot happens to answer. Legacy only had 3201.
        try:
            request(3203, 'health/ready')
        except urllib.error.URLError as error:
            if not isinstance(error.reason, OSError) or error.reason.errno != errno.ECONNREFUSED:
                raise GuardError('Cannot prove the legacy production slot is unambiguous')
        except ConnectionRefusedError:
            pass
        else:
            raise GuardError('Production active receipt is missing while slot 3203 is present')
        return validate_identity({'port': 3201, 'sha': version_at(3201, request),
                                  'source': 'legacy', 'phase': 'legacy'})
    trusted_directory(state_directory, owner_uid, private=True)
    phase = trusted_read(os.path.join(state_directory, 'phase'), owner_uid).strip()
    if phase not in STABLE_PHASES:
        raise GuardError('Production generation is switching or maintenance is pending')
    active = json.loads(trusted_read(os.path.join(state_directory, 'active.json'), owner_uid))
    if not isinstance(active, dict) or set(active) != {'sha', 'port'}:
        raise GuardError('Invalid production active receipt')
    return validate_identity({'port': active['port'], 'sha': active['sha'],
                              'source': 'active-receipt', 'phase': phase})


def check_current(state_directory=STATE_DIRECTORY, owner_uid=0, request=request_local):
    before = resolve_current(state_directory, owner_uid, request)
    if version_at(before['port'], request) != before['sha']:
        raise GuardError('Production runtime version does not match the active receipt')
    after = resolve_current(state_directory, owner_uid, request)
    if after != before:
        raise GuardError('Production generation changed during the health check')
    return before


def read_receipt(path, owner_uid=0):
    if os.path.basename(path) != 'production-runtime.json':
        raise GuardError('Invalid production guard receipt path')
    parent = os.path.dirname(os.path.abspath(path))
    trusted_directory(parent, owner_uid)
    return validate_identity(json.loads(trusted_read(path, owner_uid, immutable=True)))


def check_receipt(path, owner_uid=0, request=request_local):
    identity = read_receipt(path, owner_uid)
    if version_at(identity['port'], request) != identity['sha']:
        raise GuardError('Production runtime version changed from its pinned identity')
    if read_receipt(path, owner_uid) != identity:
        raise GuardError('Production guard receipt changed during the health check')
    return identity


def main(arguments=None, state_directory=STATE_DIRECTORY, owner_uid=0, request=request_local):
    # Trust UID, state directory and transport cannot be selected through CLI/env.
    arguments = sys.argv[1:] if arguments is None else arguments
    if arguments == ['check']:
        result = check_current(state_directory, owner_uid, request)
    elif len(arguments) == 3 and arguments[:2] == ['check', '--receipt']:
        result = check_receipt(arguments[2], owner_uid, request)
    else:
        raise GuardError('Usage: production-runtime-health.py check [--receipt PATH]')
    print(json.dumps(result, sort_keys=True, separators=(',', ':')))


if __name__ == '__main__':
    try:
        main()
    except (GuardError, OSError, ValueError, urllib.error.URLError) as error:
        sys.exit('PRODUCTION_HEALTH_GUARD_FAILED: {}'.format(error))
