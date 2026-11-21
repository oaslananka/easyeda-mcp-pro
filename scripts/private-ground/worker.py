"""Internal entrypoint. The host launcher runs this only in a fresh namespace."""
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess  # nosec B404 -- Only fixed native commands and worker processes.
import sys
import time
import tempfile
import uuid

os.umask(0o077)
VENDOR = '/vendor/easyeda-pro'
PROJECT = '/workspace/WORKING.eprj2'


def native_session_id(value):
    # Native CLI session IDs are canonical UUID strings. Never forward an
    # arbitrary string returned by the native runtime as an option operand.
    if not isinstance(value, str) or len(value) != 36:
        raise ValueError('Invalid native session identity')
    if str(uuid.UUID(value)) != value:
        raise ValueError('Invalid native session identity')
    return value


def native_args(operation, session_id=None):
    if operation == 'doctor' and session_id is None:
        return ['doctor']
    if operation == 'open' and session_id is None:
        return ['open', '--path', PROJECT, '--headless']
    if operation == 'close':
        return ['session', 'close', '--session', native_session_id(session_id), '--destroy']
    raise ValueError('Unsupported native worker operation')


def native(operation, *, session_id=None, timeout=60):
    args = native_args(operation, session_id)
    # Fixed native binary and allowlisted argument forms inside the private namespace.
    result = subprocess.run(  # nosec B603
        [VENDOR, *args, '--no-sandbox'], shell=False, stdin=subprocess.DEVNULL,
        capture_output=True, timeout=timeout, check=True,
    )
    if len(result.stdout) > 2 * 1024 * 1024:
        raise RuntimeError('Native response exceeded size limit')
    value = json.loads(result.stdout)
    if value.get('ok') is not True:
        raise RuntimeError('Native CLI did not acknowledge request')
    return value['value']


def main():
    mode = sys.argv[1]
    if mode not in ('transaction', 'interactive', 'cold'):
        raise RuntimeError('Invalid worker mode')
    for name in ('HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_RUNTIME_DIR'):
        Path(os.environ[name]).mkdir(mode=0o700, parents=True, exist_ok=True)
    profile = Path.home() / 'EasyEDA-Pro'
    profile.mkdir(mode=0o700)
    shutil.copyfile('/seed/config.json', profile / 'config.json')
    shutil.copyfile('/qa-activation', profile / 'lceda-pro-activation.txt')
    shutil.copyfile('/original.eprj2', PROJECT)
    processes = []
    session_id = None
    try:
        # No predictable log path, and no native output is exposed to the caller.
        with tempfile.TemporaryFile(mode='w+b') as log:
            for command in [
                ['/usr/bin/socat', '-T', '85', 'TCP4-LISTEN:18765,bind=127.0.0.1,reuseaddr,fork', 'UNIX-CONNECT:/egress.sock'],
                ['/usr/bin/Xvfb', ':97', '-screen', '0', '1280x900x24', '-nolisten', 'tcp', '-ac'],
                [VENDOR, '--no-sandbox', '--disable-gpu'],
            ]:
                # The three commands are fixed literals above, not request data.
                processes.append(subprocess.Popen(  # nosec B603
                    command, shell=False, stdin=subprocess.DEVNULL, stdout=log, stderr=log))
            for _ in range(20):
                try:
                    d = native('doctor', timeout=5)
                    if d.get('connected') and d.get('bridgeVersion', '').startswith('4.1.105.'):
                        break
                except (OSError, ValueError, RuntimeError, subprocess.SubprocessError):
                    pass
                time.sleep(1)
            else:
                raise RuntimeError('Isolated EasyEDA Pro 4.1.105 did not become ready')
            session_id = native_session_id(native('open', timeout=50)['sessionId'])
            # mode is allowlisted above and session_id is a canonical UUID.
            subprocess.run(  # nosec B603
                ['/node', '/launch/worker.cjs', mode, session_id], shell=False,
                check=True, timeout=260, stdin=None if mode == 'interactive' else subprocess.DEVNULL)
            if native('close', session_id=session_id, timeout=20).get('status') != 'closed':
                raise RuntimeError('Native session close unconfirmed')
            session_id = None
            # The vendor process must stop before inspecting or copying its database.
            processes[-1].terminate()
            processes[-1].wait(timeout=15)
            with sqlite3.connect('file:' + PROJECT + '?mode=ro', uri=True) as db:
                if db.execute('pragma integrity_check').fetchall() != [('ok',)]:
                    raise RuntimeError('Saved project integrity check failed')
            if mode in ('transaction', 'interactive'):
                result = Path('/evidence/result.json')
                if not result.is_file() or not json.loads(result.read_text()).get('save'):
                    raise RuntimeError('Rollback proof missing')
                shutil.copyfile(PROJECT, '/evidence/staged.eprj2')
            elif not Path('/evidence/cold.json').is_file():
                raise RuntimeError('Cold reopen proof missing')
    finally:
        for process in reversed(processes):
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Never print raw native output, credentials or source.
        print('Private Ground worker stopped: ' + type(error).__name__, file=sys.stderr)
        sys.exit(1)
