#!/usr/bin/env python3
"""Real helper stdio through fake SSH; no network or real user config."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

binary = Path(sys.argv[1]).resolve(strict=True)
with tempfile.TemporaryDirectory(prefix="easycli-machine-fixture-") as temporary:
    root = Path(temporary)
    home = root / "remote-home"
    home.mkdir()
    commands = root / "bin"
    commands.mkdir()
    (commands / "easycli-remote-helper").symlink_to(binary)
    ssh = commands / "ssh"
    ssh.write_text('''#!/usr/bin/env python3
import os, subprocess, sys
args = sys.argv[1:]
assert 'StrictHostKeyChecking=yes' in args
assert 'BatchMode=yes' in args
assert args[-2:] == ['fixture-host', 'easycli-remote-helper --remote-machine-helper-v1']
assert not any('fixture-client-secret' in arg for arg in args)
raise SystemExit(subprocess.call(['easycli-remote-helper', '--remote-machine-helper-v1']))
''')
    ssh.chmod(0o700)
    environment = dict(os.environ, HOME=str(home), XDG_CONFIG_HOME=str(home / ".config"), XDG_STATE_HOME=str(home / ".local/state"), PATH=str(commands) + os.pathsep + os.environ["PATH"])
    environment.pop("OPENCODE_CONFIG", None)
    environment.pop("DISPLAY", None)
    def call(operation, identity=None, ok=True):
        payload = {"version": 1, "identity": identity, "operation": operation}
        result = subprocess.run([str(ssh), '-T', '-o', 'StrictHostKeyChecking=yes', '-o', 'BatchMode=yes', '--', 'fixture-host', 'easycli-remote-helper --remote-machine-helper-v1'], input=json.dumps(payload).encode(), stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=environment, timeout=25, check=True, umask=0o022)
        assert b'fixture-client-secret' not in result.stdout
        response = json.loads(result.stdout)
        assert response['version'] == 1
        if ok:
            assert 'Ok' in response['result'], response
            return response['result']['Ok']
        assert 'Err' in response['result'], response
        return response['result']['Err']
    probe = call({"kind": "capabilities"})
    assert probe['os'] == 'linux'
    assert not (home / '.local/state/easycli-remote').exists(), 'probe must be read only'
    identity = probe['identity']
    call({'kind': 'inspect', 'client': 'claude-code'}, 'wrong-identity', ok=False)
    assert not (home / '.local/state/easycli-remote').exists(), 'wrong identity must not create state'
    for capability in probe['clients']:
        client = capability['id']
        assert capability['supported']
        path = Path(capability['paths'][0])
        assert path.is_relative_to(home)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('{"unrelated":{"keep":true}}')
        path.chmod(0o644)
        inspect = lambda: call({"kind": "inspect", "client": client}, identity)
        revision = inspect()['revision']
        backup = call({"kind": "backup", "client": client, "revision": revision}, identity)
        apply = {"kind": "apply", "client": client, "revision": revision, "origin": "http://core.invalid:8317", "apiKey": "fixture-client-secret", "model": "fixture-model"}
        call(apply, 'wrong-identity', ok=False)
        assert 'fixture-client-secret' not in path.read_text()
        for local_origin in ['http://localhost:8317', 'http://api.localhost', 'http://127.0.0.1:8317', 'http://[::1]:8317', 'http://0.0.0.0:8317', 'http://[::]:8317']:
            call(dict(apply, origin=local_origin), identity, ok=False)
            assert 'fixture-client-secret' not in path.read_text()
        call(apply, identity)
        assert path.stat().st_mode & 0o777 == 0o600, 'preexisting 0644 config must become private'
        secret_backup = call({"kind": "backup", "client": client, "revision": inspect()['revision']}, identity)
        path.chmod(0o644)
        call(dict(apply, revision=inspect()['revision']), identity)
        assert path.stat().st_mode & 0o777 == 0o600, 'unchanged secret bytes still require private mode'
        value = json.loads(path.read_text())
        assert value['unrelated'] == {'keep': True}
        assert 'fixture-client-secret' in path.read_text()
        call(apply, identity, ok=False)
        value['laterUserEdit'] = 42
        path.write_text(json.dumps(value))
        call({"kind": "clear", "client": client, "revision": inspect()['revision']}, identity)
        assert json.loads(path.read_text())['laterUserEdit'] == 42
        assert 'fixture-client-secret' not in path.read_text()
        preview = call({"kind": "preview", "client": client, "backupId": backup['id']}, identity)
        path.write_text('{"changedAfterPreview":true}')
        call({"kind": "restore", "client": client, "backupId": backup['id'], "revision": preview['revision']}, identity, ok=False)
        preview = call({"kind": "preview", "client": client, "backupId": backup['id']}, identity)
        call({"kind": "restore", "client": client, "backupId": backup['id'], "revision": preview['revision']}, identity)
        assert json.loads(path.read_text()) == {'unrelated': {'keep': True}}
        assert call({"kind": "backups", "client": client}, identity)['versions']
        path.chmod(0o644)
        preview = call({"kind": "preview", "client": client, "backupId": secret_backup['id']}, identity)
        call({"kind": "restore", "client": client, "backupId": secret_backup['id'], "revision": preview['revision']}, identity)
        assert 'fixture-client-secret' in path.read_text()
        assert path.stat().st_mode & 0o777 == 0o600, 'restore must secure existing 0644 target'
        call({"kind": "clear", "client": client, "revision": inspect()['revision']}, identity)
        path.unlink()
        call(dict(apply, revision=inspect()['revision']), identity)
        assert 'fixture-client-secret' in path.read_text()
        assert path.stat().st_mode & 0o777 == 0o600, 'fresh config must be private under umask 022'
        contents = path.read_bytes()
        path.chmod(0o444)
        try:
            with path.open('r+b'):
                pass
        except PermissionError:
            pass
        else:
            raise AssertionError('Run permission fixtures as an unprivileged account')
        capability = next(c for c in call({'kind': 'capabilities'})['clients'] if c['id'] == client)
        assert not capability['supported'] and 'not writable' in capability['reason']
        assert path.read_bytes() == contents, 'write-access probe must not truncate config'
        path.chmod(0o600)
    call({"kind": "inspect", "client": "codex"}, identity, ok=False)
    environment['OPENCODE_CONFIG'] = str(root / 'outside-home.json')
    changed = call({'kind': 'capabilities'})
    assert changed['identity'] != identity
    assert not next(c for c in changed['clients'] if c['id'] == 'opencode')['supported']
    call({'kind': 'inspect', 'client': 'claude-code'}, identity, ok=False)
    assert not (root / 'outside-home.json').exists()
    # Relocated Local roots must never authorize symlinked remote helper state.
    escape_home = root / 'escape-home'
    outside = root / 'outside-state'
    escape_home.mkdir()
    outside.mkdir()
    (escape_home / '.local/state').mkdir(parents=True)
    environment.update(HOME=str(escape_home), XDG_CONFIG_HOME=str(escape_home / '.config'))
    environment.pop('OPENCODE_CONFIG', None)
    escape_identity = call({'kind': 'capabilities'})['identity']
    (escape_home / '.claude').symlink_to(outside, target_is_directory=True)
    (escape_home / '.local/state/easycli-remote').symlink_to(outside, target_is_directory=True)
    for operation in [
        {'kind': 'capabilities'},
        {'kind': 'inspect', 'client': 'opencode'},
        {'kind': 'apply', 'client': 'opencode', 'revision': 'untrusted', 'origin': 'http://core.invalid:8317', 'apiKey': 'fixture-client-secret', 'model': 'fixture-model'},
    ]:
        result = subprocess.run([str(binary), '--remote-machine-helper-v1'], input=json.dumps({'version': 1, 'identity': escape_identity, 'operation': operation}).encode(), stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=environment, timeout=25, umask=0o022)
        assert result.returncode != 0, 'symlinked helper state must reject every operation before initialization'
        assert not list(outside.iterdir()), 'helper must never create lock, snapshots or backups outside HOME'
        assert not (escape_home / '.config').exists(), 'rejected state must not write client config'
    # Nested aliases must not inherit Local relocated-root exceptions. Exercise
    # all backup read paths with a real valid backup, not a missing/corrupt package.
    nested_home = root / 'nested-home'
    nested_outside = root / 'nested-outside'
    nested_home.mkdir()
    nested_outside.mkdir()
    environment.update(HOME=str(nested_home), XDG_CONFIG_HOME=str(nested_home / '.config'))
    (nested_home / '.claude').symlink_to(nested_outside, target_is_directory=True)
    nested_probe = call({'kind': 'capabilities'})
    nested_identity = nested_probe['identity']
    client = 'opencode'
    nested_inspect = lambda: call({'kind': 'inspect', 'client': client}, nested_identity)
    nested_apply = {'kind': 'apply', 'client': client, 'revision': nested_inspect()['revision'], 'origin': 'http://core.invalid:8317', 'apiKey': 'fixture-client-secret', 'model': 'fixture-model'}
    call(nested_apply, nested_identity)
    nested_revision = nested_inspect()['revision']
    nested_backup = call({'kind': 'backup', 'client': client, 'revision': nested_revision}, nested_identity)
    nested_preview = call({'kind': 'preview', 'client': client, 'backupId': nested_backup['id']}, nested_identity)
    nested_config = Path(next(c for c in nested_probe['clients'] if c['id'] == client)['paths'][0])
    nested_bytes = nested_config.read_bytes()
    state = nested_home / '.local/state/easycli-remote'
    backup_path = Path(nested_backup['location'])
    backup_bytes = backup_path.read_bytes()
    backup_ops = [
        {'kind': 'backup', 'client': client, 'revision': nested_revision},
        {'kind': 'backups', 'client': client},
        {'kind': 'preview', 'client': client, 'backupId': nested_backup['id']},
        {'kind': 'restore', 'client': client, 'backupId': nested_backup['id'], 'revision': nested_preview['revision']},
    ]
    # Check every nested directory depth, with no fixture data in outside.
    for directory in [state / 'backups', state / 'backups/agents', backup_path.parent.parent, backup_path.parent]:
        saved = directory.with_name(directory.name + '-fixture-original')
        directory.rename(saved)
        directory.symlink_to(nested_outside, target_is_directory=True)
        for operation in backup_ops:
            call(operation, nested_identity, ok=False)
            assert not list(nested_outside.iterdir()), 'nested backup alias must not create outside files or directories'
            assert nested_config.read_bytes() == nested_bytes
        directory.unlink()
        saved.rename(directory)
    # A symlink on the final version file must reject list/preview/restore too.
    outside_version = nested_outside / 'fixture-version.json'
    outside_version.write_bytes(backup_bytes)
    backup_path.unlink()
    backup_path.symlink_to(outside_version)
    for operation in backup_ops[1:]:
        call(operation, nested_identity, ok=False)
        assert outside_version.read_bytes() == backup_bytes
        assert list(nested_outside.iterdir()) == [outside_version]
        assert nested_config.read_bytes() == nested_bytes
    backup_path.unlink()
    backup_path.write_bytes(backup_bytes)
    outside_version.unlink()
    # Integration snapshot readers and transaction paths share the strict check.
    snapshot = next((state / 'agents').rglob('integration-state.json'))
    snapshot_bytes = snapshot.read_bytes()
    for target in [state / 'agents', snapshot.parent.parent, snapshot.parent]:
        saved = target.with_name(target.name + '-fixture-original')
        target.rename(saved)
        target.symlink_to(nested_outside, target_is_directory=True)
        for operation in [
            {'kind': 'inspect', 'client': client},
            dict(nested_apply, revision=nested_revision),
            {'kind': 'clear', 'client': client, 'revision': nested_revision},
        ]:
            call(operation, nested_identity, ok=False)
            assert not list(nested_outside.iterdir()), 'snapshot alias must not read/write outside state'
            assert nested_config.read_bytes() == nested_bytes
        target.unlink()
        saved.rename(target)
    outside_snapshot = nested_outside / 'fixture-snapshot.json'
    outside_snapshot.write_bytes(snapshot_bytes)
    snapshot.unlink()
    snapshot.symlink_to(outside_snapshot)
    for operation in [
        {'kind': 'inspect', 'client': client},
        dict(nested_apply, revision=nested_revision),
        {'kind': 'clear', 'client': client, 'revision': nested_revision},
    ]:
        call(operation, nested_identity, ok=False)
        assert outside_snapshot.read_bytes() == snapshot_bytes
        assert nested_config.read_bytes() == nested_bytes
    print('PASS: real helper fixture; both clients configure/preserve/clear/backup/restore; stale/identity/origin/permission guards; mode0600; top-level and nested backup/snapshot symlinks fail closed without outside writes')
