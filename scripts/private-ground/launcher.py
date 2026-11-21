"""Opt-in Linux acceptance workflow. Never overwrites the selected project."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time

ASSETS = Path(__file__).resolve().parent
LIMIT = 32 * 1024 * 1024


def digest(path):
    with path.open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def input_file(value, suffix=None, max_bytes=LIMIT):
    raw = Path(value).expanduser()
    if raw.is_symlink():
        raise ValueError('Symlink inputs are not supported')
    path = raw.resolve(strict=True)
    info = path.stat()
    if not stat.S_ISREG(info.st_mode) or info.st_size <= 0 or info.st_size > max_bytes:
        raise ValueError('Expected a bounded regular input file')
    if suffix and path.suffix.lower() != suffix:
        raise ValueError('Expected ' + suffix + ' input')
    return path


def output_path(value):
    raw = Path(value).expanduser()
    path = raw.parent.resolve(strict=True) / raw.name
    if path.suffix.lower() != '.eprj2' or os.path.lexists(path):
        raise ValueError('Output must be a new .eprj2 file')
    return path


def publish(staged, output):
    # Atomic no-clobber publication, including a concurrent creator.
    fd, name = tempfile.mkstemp(prefix='.easyeda-private-', dir=output.parent)
    try:
        with os.fdopen(fd, 'wb') as dest, staged.open('rb') as source:
            shutil.copyfileobj(source, dest)
            dest.flush()
            os.fsync(dest.fileno())
        os.link(name, output)
    finally:
        os.unlink(name)


def run_worker(root, mode, original, editor, activation, node, expected=None):
    evidence = root / mode
    evidence.mkdir(mode=0o700)
    sock = root / (mode + '.sock')
    with (root / (mode + '-proxy.log')).open('wb') as log:
        proxy = subprocess.Popen([sys.executable, str(ASSETS / 'proxy.py'), str(sock)],
                                 stdin=subprocess.DEVNULL, stdout=log, stderr=log)
        try:
            for _ in range(40):
                if sock.is_socket():
                    break
                if proxy.poll() is not None:
                    raise RuntimeError('Vendor relay did not start')
                time.sleep(0.1)
            else:
                raise RuntimeError('Vendor relay did not start')
            sock.chmod(0o600)
            command = [
                '/usr/bin/bwrap', '--unshare-all', '--die-with-parent', '--new-session', '--clearenv',
                '--ro-bind', '/usr', '/usr', '--ro-bind', '/etc', '/etc',
                '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/lib', '/lib',
                '--symlink', 'usr/lib64', '/lib64', '--proc', '/proc', '--dev', '/dev',
                '--tmpfs', '/tmp', '--tmpfs', '/run', '--tmpfs', '/home',
                '--ro-bind', str(editor.parent), '/vendor', '--tmpfs', '/workspace',
                '--ro-bind', str(original), '/original.eprj2', '--ro-bind', str(node), '/node',
                '--bind', str(evidence), '/evidence', '--ro-bind', str(ASSETS), '/launch',
                '--ro-bind', str(root / 'seed'), '/seed', '--ro-bind', str(activation), '/qa-activation',
                '--ro-bind', str(sock), '/egress.sock',
            ]
            env = {
                'PATH': '/usr/bin:/bin', 'HOME': '/home/worker', 'XDG_CONFIG_HOME': '/home/worker/config',
                'XDG_CACHE_HOME': '/home/worker/cache', 'XDG_DATA_HOME': '/home/worker/data',
                'XDG_RUNTIME_DIR': '/run/worker', 'DISPLAY': ':97', 'LIBGL_ALWAYS_SOFTWARE': '1',
                'GALLIUM_DRIVER': 'llvmpipe', 'HTTPS_PROXY': 'http://127.0.0.1:18765',
                'HTTP_PROXY': 'http://127.0.0.1:18765', 'NO_PROXY': 'localhost,127.0.0.1',
            }
            for key, value in env.items():
                command.extend(['--setenv', key, value])
            if expected:
                command.extend(['--ro-bind', str(expected), '/expected.json'])
            command.extend(['--chdir', '/workspace', '/usr/bin/python3', '/launch/worker.py', mode])
            subprocess.run(command, stdin=subprocess.DEVNULL, stdout=sys.stderr, stderr=sys.stderr,
                           check=True, timeout=360)
            return evidence
        finally:
            proxy.terminate()
            try:
                proxy.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proxy.kill()
                proxy.wait()


def main():
    parser = argparse.ArgumentParser(
        description='Verify a single disconnected default Ground delete/rollback on an isolated copy (Linux, EasyEDA Pro 4.1.105).')
    parser.add_argument('--project', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--editor', required=True, help='Path to an installed EasyEDA Pro executable')
    parser.add_argument('--activation', required=True, help='Existing legitimate local offline activation file; mounted read-only for the isolated editor')
    parser.add_argument('--confirm-write', action='store_true')
    parser.add_argument('--allow-library-network', action='store_true', help='Permit bounded HTTPS access to pro.easyeda.com and image-pro.easyeda.com')
    parser.add_argument('--node', required=True, help=argparse.SUPPRESS)
    args = parser.parse_args()
    if not args.confirm_write or not args.allow_library_network:
        parser.error('Both --confirm-write and --allow-library-network are required')
    if sys.platform != 'linux' or os.geteuid() == 0:
        parser.error('Requires a non-root Linux host with user namespaces')
    for binary in ('bwrap', 'Xvfb', 'socat', 'python3'):
        if not os.access('/usr/bin/' + binary, os.X_OK):
            parser.error('Required local program is missing: ' + binary)
    original = input_file(args.project, '.eprj2')
    output = output_path(args.output)
    editor = input_file(args.editor, max_bytes=1024 * 1024 * 1024)
    if editor.name != 'easyeda-pro' or not (editor.parent / 'resources' / 'app').is_dir():
        parser.error('Select the installed EasyEDA Pro executable, not a wrapper')
    activation = input_file(args.activation, max_bytes=65536)
    node = input_file(args.node, max_bytes=512 * 1024 * 1024)
    before_hash = digest(original)
    if original == output:
        parser.error('Output must not be the original')
    os.umask(0o077)
    with tempfile.TemporaryDirectory(prefix='easyeda-private-ground-') as directory:
        root = Path(directory)
        source = root / 'original.eprj2'
        shutil.copyfile(original, source)
        if digest(source) != before_hash:
            raise RuntimeError('Original changed while copying')
        seed = root / 'seed'
        seed.mkdir(mode=0o700)
        config = {'type': 'HALF_OFFLINE', 'firstRun': False, 'gpu': '', 'devTools': '', 'logLevel': 'warn', 'logEnable': True, 'sqlTimeout': 2000, 'connectTimeout': 5000, 'systemLibName': 'easyeda-std',
                  'canvas2d': True, 'crashUploadToServer': False, 'APP_PROJECT_DIR': '/home/worker/EasyEDA-Pro',
                  'proxy': {'enable': True, 'protocol': 'http', 'host': '127.0.0.1', 'port': 18765, 'username': '', 'password': ''}}
        (seed / 'config.json').write_text(json.dumps(config))
        print('Verifying private Ground transaction...', file=sys.stderr)
        result_dir = run_worker(root, 'transaction', source, editor, activation, node)
        result = json.loads((result_dir / 'result.json').read_text())
        staged = input_file(result_dir / 'staged.eprj2', '.eprj2')
        staged_hash = digest(staged)
        print('Verifying independent cold reopen...', file=sys.stderr)
        cold_dir = run_worker(root, 'cold', staged, editor, activation, node, result_dir / 'result.json')
        cold = json.loads((cold_dir / 'cold.json').read_text())
        if (cold.get('verified') is not True or cold['snapshot'] != result['after'] or
                result['transaction'].get('rollback_complete') is not True or result.get('save') is not True):
            raise RuntimeError('Durable rollback not proven')
        if digest(original) != before_hash or digest(staged) != staged_hash:
            raise RuntimeError('Source or staged file changed; refusing output')
        publish(staged, output)
        print(json.dumps({'success': True, 'output': str(output), 'originalUnchanged': True,
                          'restoredId': result['restoredId'], 'rollbackComplete': True,
                          'coldReopenVerified': True, 'attributeFingerprint': cold['snapshot']['nativeIsolation']['attributeFingerprint'],
                          'sha256': staged_hash}))


if __name__ == '__main__':
    def interrupted(_signum, _frame):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, interrupted)
    try:
        main()
    except KeyboardInterrupt:
        print('Private Ground check interrupted; no unverified output published.', file=sys.stderr)
        sys.exit(130)
    except (OSError, ValueError, RuntimeError, KeyError, subprocess.SubprocessError) as error:
        print('Private Ground check failed: ' + type(error).__name__ + '. Original was not overwritten.', file=sys.stderr)
        sys.exit(1)
