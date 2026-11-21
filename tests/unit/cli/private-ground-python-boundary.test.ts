import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const python = '/usr/bin/python3';
const available = process.platform === 'linux' && spawnSync(python, ['--version']).status === 0;
const directory = resolve('scripts/private-ground');

// Only import and exercise pure argument validation. Never launch native processes.
const harness = [
  'import importlib.util, pathlib, sys',
  'from unittest.mock import patch',
  'root=pathlib.Path(sys.argv[1])',
  'def load(name):',
  '    spec=importlib.util.spec_from_file_location(name,root/(name+".py"))',
  '    module=importlib.util.module_from_spec(spec)',
  '    spec.loader.exec_module(module)',
  '    return module',
  'worker=load("worker")',
  'launcher=load("launcher")',
  'mode=sys.argv[2]',
  'with patch("subprocess.run",side_effect=AssertionError("must not spawn")), patch("subprocess.Popen",side_effect=AssertionError("must not spawn")):',
  '    if mode=="valid":',
  '        sid="01234567-89ab-4def-8123-456789abcdef"',
  '        assert worker.native_args("doctor")==["doctor"]',
  '        assert worker.native_args("open")==["open","--path",worker.PROJECT,"--headless"]',
  '        assert worker.native_args("close",sid)==["session","close","--session",sid,"--destroy"]',
  '    elif mode=="invalid-native":',
  '        for sid in ("--destroy","; command",None,123,"A"*36,"01234567-89AB-4DEF-8123-456789ABCDEF"):',
  '            try: worker.native("close",session_id=sid)',
  '            except ValueError: pass',
  '            else: raise AssertionError("invalid identity accepted")',
  '        for operation in ("invoke","--help","delete",""):',
  '            try: worker.native(operation)',
  '            except ValueError: pass',
  '            else: raise AssertionError("invalid operation accepted")',
  '    elif mode=="invalid-launcher":',
  '        absolute=pathlib.Path("/not-used")',
  '        for worker_mode,source,expected in [("invalid",absolute,None),("cold",absolute,None),("interactive",absolute,absolute),("transaction",pathlib.Path("--option"),None)]:',
  '            try: launcher.run_worker(absolute,worker_mode,source,absolute,absolute,absolute,expected)',
  '            except ValueError: pass',
  '            else: raise AssertionError("invalid worker arguments accepted")',
  '    elif mode=="valid-launcher":',
  '        from tempfile import TemporaryDirectory',
  '        from unittest.mock import Mock',
  '        with TemporaryDirectory() as folder:',
  '            root=pathlib.Path(folder)',
  '            original=root/"--source with spaces.eprj2"',
  '            editor=root/"vendor"/"easyeda-pro"',
  '            activation=root/"activation.txt"',
  '            node=root/"node"',
  '            proxy=Mock()',
  '            with patch("subprocess.Popen",return_value=proxy) as start, patch("subprocess.run") as run, patch.object(pathlib.Path,"is_socket",return_value=True), patch.object(pathlib.Path,"chmod"):',
  '                launcher.run_worker(root,"interactive",original,editor,activation,node)',
  '                argv=run.call_args.args[0]',
  '                assert argv[0]=="/usr/bin/bwrap"',
  '                assert argv.count("--ro-bind")==9',
  '                assert argv[argv.index(str(original))-1:argv.index(str(original))+2]==["--ro-bind",str(original),"/original.eprj2"]',
  '                assert argv[-5:]==["--chdir","/workspace","/usr/bin/python3","/launch/worker.py","interactive"]',
  '                assert run.call_args.kwargs["shell"] is False',
  '                assert run.call_args.kwargs["timeout"]==360',
  '                assert start.call_args.kwargs["shell"] is False',
  '                proxy.terminate.assert_called_once()',
  '    else: raise AssertionError("unknown test")',
  'print("verified")',
].join('\n');

describe.skipIf(!available)('private Ground Python argument boundary', () => {
  it.each(['valid', 'invalid-native', 'invalid-launcher', 'valid-launcher'])(
    'checks %s without spawning a native process',
    (mode) => {
      const result = spawnSync(python, ['-B', '-c', harness, directory, mode], {
        encoding: 'utf8',
        timeout: 10000,
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe('verified');
    },
  );
});
