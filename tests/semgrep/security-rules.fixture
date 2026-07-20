declare const untrustedSource: string;
declare function exec(command: string): unknown;
declare function execFile(file: string, args: string[]): unknown;
declare function spawn(command: string, args: string[], options?: object): unknown;
declare function request(options: object): unknown;

// ruleid: easyeda.security.no-dynamic-code-execution
eval(untrustedSource);

// ruleid: easyeda.security.no-dynamic-code-execution
new Function(untrustedSource);

// ok: easyeda.security.no-dynamic-code-execution
JSON.parse(untrustedSource);

// ruleid: easyeda.security.no-shell-child-process
exec(untrustedSource);

// ruleid: easyeda.security.no-shell-child-process
spawn('node', ['script.js'], { shell: true });

// ok: easyeda.security.no-shell-child-process
execFile('node', ['script.js']);

// ok: easyeda.security.no-shell-child-process
spawn('node', ['script.js'], { shell: false });

// ruleid: easyeda.security.no-disabled-tls-verification
request({ rejectUnauthorized: false });

// ruleid: easyeda.security.no-disabled-tls-verification
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// ok: easyeda.security.no-disabled-tls-verification
request({ rejectUnauthorized: true });
