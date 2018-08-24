// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

/* eslint-disable node-core/required-modules, node-core/crypto-check */
'use strict';
const process = global.process;  // Some tests tamper with the process global.
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const os = require('os');
const { exec, execSync, spawnSync } = require('child_process');
const util = require('util');
const Timer = process.binding('timer_wrap').Timer;
const { fixturesDir } = require('./fixtures');
const tmpdir = require('./tmpdir');
const {
  bits,
  hasIntl,
  hasSmallICU
} = process.binding('config');

const noop = () => {};

const isMainThread = (() => {
  try {
    return require('worker_threads').isMainThread;
  } catch {
    // Worker module not enabled → only a single main thread exists.
    return true;
  }
})();

const isWindows = process.platform === 'win32';
const isWOW64 = isWindows && (process.env.PROCESSOR_ARCHITEW6432 !== undefined);
const isAIX = process.platform === 'aix';
const isLinuxPPCBE = (process.platform === 'linux') &&
                     (process.arch === 'ppc64') &&
                     (os.endianness() === 'BE');
const isSunOS = process.platform === 'sunos';
const isFreeBSD = process.platform === 'freebsd';
const isOpenBSD = process.platform === 'openbsd';
const isLinux = process.platform === 'linux';
const isOSX = process.platform === 'darwin';

const enoughTestMem = os.totalmem() > 0x70000000; /* 1.75 Gb */
const cpus = os.cpus();
const enoughTestCpu = Array.isArray(cpus) &&
                      (cpus.length > 1 || cpus[0].speed > 999);

const rootDir = isWindows ? 'c:\\' : '/';

const buildType = process.config.target_defaults.default_configuration;

const hasCrypto = Boolean(process.versions.openssl);

// If env var is set then enable async_hook hooks for all tests.
if (process.env.NODE_TEST_WITH_ASYNC_HOOKS) {
  const destroydIdsList = {};
  const destroyListList = {};
  const initHandles = {};
  const async_wrap = process.binding('async_wrap');

  process.on('exit', () => {
    // iterate through handles to make sure nothing crashes
    for (const k in initHandles)
      util.inspect(initHandles[k]);
  });

  const _queueDestroyAsyncId = async_wrap.queueDestroyAsyncId;
  async_wrap.queueDestroyAsyncId = function queueDestroyAsyncId(id) {
    if (destroyListList[id] !== undefined) {
      process._rawDebug(destroyListList[id]);
      process._rawDebug();
      throw new Error(`same id added to destroy list twice (${id})`);
    }
    destroyListList[id] = new Error().stack;
    _queueDestroyAsyncId(id);
  };

  require('async_hooks').createHook({
    init(id, ty, tr, r) {
      if (initHandles[id]) {
        process._rawDebug(
          `Is same resource: ${r === initHandles[id].resource}`);
        process._rawDebug(`Previous stack:\n${initHandles[id].stack}\n`);
        throw new Error(`init called twice for same id (${id})`);
      }
      initHandles[id] = { resource: r, stack: new Error().stack.substr(6) };
    },
    before() { },
    after() { },
    destroy(id) {
      if (destroydIdsList[id] !== undefined) {
        process._rawDebug(destroydIdsList[id]);
        process._rawDebug();
        throw new Error(`destroy called for same id (${id})`);
      }
      destroydIdsList[id] = new Error().stack;
    },
  }).enable();
}

let opensslCli = null;
let inFreeBSDJail = null;
let localhostIPv4 = null;

const localIPv6Hosts =
  isLinux ? [
    // Debian/Ubuntu
    'ip6-localhost',
    'ip6-loopback',

    // SUSE
    'ipv6-localhost',
    'ipv6-loopback',

    // Typically universal
    'localhost',
  ] : [ 'localhost' ];

const PIPE = (() => {
  const localRelative = path.relative(process.cwd(), `${tmpdir.path}/`);
  const pipePrefix = isWindows ? '\\\\.\\pipe\\' : localRelative;
  const pipeName = `node-test.${process.pid}.sock`;
  return path.join(pipePrefix, pipeName);
})();

let hasIPv6;
{
  const iFaces = os.networkInterfaces();
  const re = isWindows ? /Loopback Pseudo-Interface/ : /lo/;
  hasIPv6 = Object.keys(iFaces).some(function(name) {
    return re.test(name) && iFaces[name].some(function(info) {
      return info.family === 'IPv6';
    });
  });
}

/*
 * Check that when running a test with
 * `$node --abort-on-uncaught-exception $file child`
 * the process aborts.
 */
function childShouldThrowAndAbort() {
  let testCmd = '';
  if (!isWindows) {
    // Do not create core files, as it can take a lot of disk space on
    // continuous testing and developers' machines
    testCmd += 'ulimit -c 0 && ';
  }
  testCmd += `"${process.argv[0]}" --abort-on-uncaught-exception `;
  testCmd += `"${process.argv[1]}" child`;
  const child = exec(testCmd);
  child.on('exit', function onExit(exitCode, signal) {
    const errMsg = 'Test should have aborted ' +
                   `but instead exited with exit code ${exitCode}` +
                   ` and signal ${signal}`;
    assert(nodeProcessAborted(exitCode, signal), errMsg);
  });
}

function ddCommand(filename, kilobytes) {
  if (isWindows) {
    const p = path.resolve(fixturesDir, 'create-file.js');
    return `"${process.argv[0]}" "${p}" "${filename}" ${kilobytes * 1024}`;
  } else {
    return `dd if=/dev/zero of="${filename}" bs=1024 count=${kilobytes}`;
  }
}


const pwdCommand = isWindows ?
  ['cmd.exe', ['/d', '/c', 'cd']] :
  ['pwd', []];


function platformTimeout(ms) {
  if (process.features.debug)
    ms = 2 * ms;

  if (global.__coverage__)
    ms = 4 * ms;

  if (isAIX)
    return 2 * ms; // default localhost speed is slower on AIX

  if (process.arch !== 'arm')
    return ms;

  const armv = process.config.variables.arm_version;

  if (armv === '6')
    return 7 * ms;  // ARMv6

  if (armv === '7')
    return 2 * ms;  // ARMv7

  return ms; // ARMv8+
}

let knownGlobals = [
  Buffer,
  clearImmediate,
  clearInterval,
  clearTimeout,
  global,
  process,
  setImmediate,
  setInterval,
  setTimeout
];

if (global.gc) {
  knownGlobals.push(global.gc);
}

if (global.DTRACE_HTTP_SERVER_RESPONSE) {
  knownGlobals.push(DTRACE_HTTP_SERVER_RESPONSE);
  knownGlobals.push(DTRACE_HTTP_SERVER_REQUEST);
  knownGlobals.push(DTRACE_HTTP_CLIENT_RESPONSE);
  knownGlobals.push(DTRACE_HTTP_CLIENT_REQUEST);
  knownGlobals.push(DTRACE_NET_STREAM_END);
  knownGlobals.push(DTRACE_NET_SERVER_CONNECTION);
}

if (global.COUNTER_NET_SERVER_CONNECTION) {
  knownGlobals.push(COUNTER_NET_SERVER_CONNECTION);
  knownGlobals.push(COUNTER_NET_SERVER_CONNECTION_CLOSE);
  knownGlobals.push(COUNTER_HTTP_SERVER_REQUEST);
  knownGlobals.push(COUNTER_HTTP_SERVER_RESPONSE);
  knownGlobals.push(COUNTER_HTTP_CLIENT_REQUEST);
  knownGlobals.push(COUNTER_HTTP_CLIENT_RESPONSE);
}

if (process.env.NODE_TEST_KNOWN_GLOBALS) {
  const knownFromEnv = process.env.NODE_TEST_KNOWN_GLOBALS.split(',');
  allowGlobals(...knownFromEnv);
}

function allowGlobals(...whitelist) {
  knownGlobals = knownGlobals.concat(whitelist);
}

function leakedGlobals() {
  const leaked = [];

  for (const val in global) {
    if (!knownGlobals.includes(global[val])) {
      leaked.push(val);
    }
  }

  if (global.__coverage__) {
    return leaked.filter((varname) => !/^(?:cov_|__cov)/.test(varname));
  } else {
    return leaked;
  }
}

process.on('exit', function() {
  const leaked = leakedGlobals();
  if (leaked.length > 0) {
    assert.fail(`Unexpected global(s) found: ${leaked.join(', ')}`);
  }
});

const mustCallChecks = [];

function runCallChecks(exitCode) {
  if (exitCode !== 0) return;

  const failed = mustCallChecks.filter(function(context) {
    if ('minimum' in context) {
      context.messageSegment = `at least ${context.minimum}`;
      return context.actual < context.minimum;
    } else {
      context.messageSegment = `exactly ${context.exact}`;
      return context.actual !== context.exact;
    }
  });

  failed.forEach(function(context) {
    console.log('Mismatched %s function calls. Expected %s, actual %d.',
                context.name,
                context.messageSegment,
                context.actual);
    console.log(context.stack.split('\n').slice(2).join('\n'));
  });

  if (failed.length) process.exit(1);
}

function mustCall(fn, exact) {
  return _mustCallInner(fn, exact, 'exact');
}

function mustCallAtLeast(fn, minimum) {
  return _mustCallInner(fn, minimum, 'minimum');
}

function mustCallAsync(fn, exact) {
  return mustCall((...args) => {
    return Promise.resolve(fn(...args)).then(mustCall((val) => val));
  }, exact);
}

function _mustCallInner(fn, criteria = 1, field) {
  if (process._exiting)
    throw new Error('Cannot use common.mustCall*() in process exit handler');
  if (typeof fn === 'number') {
    criteria = fn;
    fn = noop;
  } else if (fn === undefined) {
    fn = noop;
  }

  if (typeof criteria !== 'number')
    throw new TypeError(`Invalid ${field} value: ${criteria}`);

  const context = {
    [field]: criteria,
    actual: 0,
    stack: (new Error()).stack,
    name: fn.name || '<anonymous>'
  };

  // add the exit listener only once to avoid listener leak warnings
  if (mustCallChecks.length === 0) process.on('exit', runCallChecks);

  mustCallChecks.push(context);

  return function() {
    context.actual++;
    return fn.apply(this, arguments);
  };
}

function hasMultiLocalhost() {
  const { TCP, constants: TCPConstants } = process.binding('tcp_wrap');
  const t = new TCP(TCPConstants.SOCKET);
  const ret = t.bind('127.0.0.2', 0);
  t.close();
  return ret === 0;
}

function skipIfEslintMissing() {
  if (!fs.existsSync(
    path.join(__dirname, '..', '..', 'tools', 'node_modules', 'eslint')
  )) {
    skip('missing ESLint');
  }
}

function canCreateSymLink() {
  // On Windows, creating symlinks requires admin privileges.
  // We'll only try to run symlink test if we have enough privileges.
  // On other platforms, creating symlinks shouldn't need admin privileges
  if (isWindows) {
    // whoami.exe needs to be the one from System32
    // If unix tools are in the path, they can shadow the one we want,
    // so use the full path while executing whoami
    const whoamiPath = path.join(process.env.SystemRoot,
                                 'System32', 'whoami.exe');

    try {
      const output = execSync(`${whoamiPath} /priv`, { timout: 1000 });
      return output.includes('SeCreateSymbolicLinkPrivilege');
    } catch (e) {
      return false;
    }
  }
  // On non-Windows platforms, this always returns `true`
  return true;
}

function getCallSite(top) {
  const originalStackFormatter = Error.prepareStackTrace;
  Error.prepareStackTrace = (err, stack) =>
    `${stack[0].getFileName()}:${stack[0].getLineNumber()}`;
  const err = new Error();
  Error.captureStackTrace(err, top);
  // with the V8 Error API, the stack is not formatted until it is accessed
  err.stack;
  Error.prepareStackTrace = originalStackFormatter;
  return err.stack;
}

function mustNotCall(msg) {
  const callSite = getCallSite(mustNotCall);
  return function mustNotCall() {
    assert.fail(
      `${msg || 'function should not have been called'} at ${callSite}`);
  };
}

function printSkipMessage(msg) {
  console.log(`1..0 # Skipped: ${msg}`);
}

function skip(msg) {
  printSkipMessage(msg);
  process.exit(0);
}

// Returns true if the exit code "exitCode" and/or signal name "signal"
// represent the exit code and/or signal name of a node process that aborted,
// false otherwise.
function nodeProcessAborted(exitCode, signal) {
  // Depending on the compiler used, node will exit with either
  // exit code 132 (SIGILL), 133 (SIGTRAP) or 134 (SIGABRT).
  let expectedExitCodes = [132, 133, 134];

  // On platforms using KSH as the default shell (like SmartOS),
  // when a process aborts, KSH exits with an exit code that is
  // greater than 256, and thus the exit code emitted with the 'exit'
  // event is null and the signal is set to either SIGILL, SIGTRAP,
  // or SIGABRT (depending on the compiler).
  const expectedSignals = ['SIGILL', 'SIGTRAP', 'SIGABRT'];

  // On Windows, 'aborts' are of 2 types, depending on the context:
  // (i) Forced access violation, if --abort-on-uncaught-exception is on
  // which corresponds to exit code 3221225477 (0xC0000005)
  // (ii) Otherwise, _exit(134) which is called in place of abort() due to
  // raising SIGABRT exiting with ambiguous exit code '3' by default
  if (isWindows)
    expectedExitCodes = [0xC0000005, 134];

  // When using --abort-on-uncaught-exception, V8 will use
  // base::OS::Abort to terminate the process.
  // Depending on the compiler used, the shell or other aspects of
  // the platform used to build the node binary, this will actually
  // make V8 exit by aborting or by raising a signal. In any case,
  // one of them (exit code or signal) needs to be set to one of
  // the expected exit codes or signals.
  if (signal !== null) {
    return expectedSignals.includes(signal);
  } else {
    return expectedExitCodes.includes(exitCode);
  }
}

function busyLoop(time) {
  const startTime = Timer.now();
  const stopTime = startTime + time;
  while (Timer.now() < stopTime) {}
}

function isAlive(pid) {
  try {
    process.kill(pid, 'SIGCONT');
    return true;
  } catch (e) {
    return false;
  }
}

function _expectWarning(name, expected) {
  const map = new Map(expected);
  return mustCall((warning) => {
    assert.strictEqual(warning.name, name);
    assert.ok(map.has(warning.message),
              `unexpected error message: "${warning.message}"`);
    const code = map.get(warning.message);
    assert.strictEqual(warning.code, code);
    // Remove a warning message after it is seen so that we guarantee that we
    // get each message only once.
    map.delete(expected);
  }, expected.length);
}

function expectWarningByName(name, expected, code) {
  if (typeof expected === 'string') {
    expected = [[expected, code]];
  }
  process.on('warning', _expectWarning(name, expected));
}

function expectWarningByMap(warningMap) {
  const catchWarning = {};
  Object.keys(warningMap).forEach((name) => {
    let expected = warningMap[name];
    if (!Array.isArray(expected)) {
      throw new Error('warningMap entries must be arrays consisting of two ' +
      'entries: [message, warningCode]');
    }
    if (!(Array.isArray(expected[0]))) {
      if (expected.length === 0) {
        return;
      }
      expected = [[expected[0], expected[1]]];
    }
    catchWarning[name] = _expectWarning(name, expected);
  });
  process.on('warning', (warning) => catchWarning[warning.name](warning));
}

// accepts a warning name and description or array of descriptions or a map
// of warning names to description(s)
// ensures a warning is generated for each name/description pair
function expectWarning(nameOrMap, expected, code) {
  if (typeof nameOrMap === 'string') {
    expectWarningByName(nameOrMap, expected, code);
  } else {
    expectWarningByMap(nameOrMap);
  }
}

class Comparison {
  constructor(obj, keys) {
    for (const key of keys) {
      if (key in obj)
        this[key] = obj[key];
    }
  }
}

// Useful for testing expected internal/error objects
function expectsError(fn, settings, exact) {
  if (typeof fn !== 'function') {
    exact = settings;
    settings = fn;
    fn = undefined;
  }

  function innerFn(error) {
    if (arguments.length !== 1) {
      // Do not use `assert.strictEqual()` to prevent `util.inspect` from
      // always being called.
      assert.fail(`Expected one argument, got ${util.inspect(arguments)}`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(error, 'message');
    // The error message should be non-enumerable
    assert.strictEqual(descriptor.enumerable, false);

    let innerSettings = settings;
    if ('type' in settings) {
      const type = settings.type;
      if (type !== Error && !Error.isPrototypeOf(type)) {
        throw new TypeError('`settings.type` must inherit from `Error`');
      }
      let constructor = error.constructor;
      if (constructor.name === 'NodeError' && type.name !== 'NodeError') {
        constructor = Object.getPrototypeOf(error.constructor);
      }
      // Add the `type` to the error to properly compare and visualize it.
      if (!('type' in error))
        error.type = constructor;
    }

    if ('message' in settings &&
        typeof settings.message === 'object' &&
        settings.message.test(error.message)) {
      // Make a copy so we are able to modify the settings.
      innerSettings = Object.create(
        settings, Object.getOwnPropertyDescriptors(settings));
      // Visualize the message as identical in case of other errors.
      innerSettings.message = error.message;
    }

    // Check all error properties.
    const keys = Object.keys(settings);
    for (const key of keys) {
      if (!util.isDeepStrictEqual(error[key], innerSettings[key])) {
        // Create placeholder objects to create a nice output.
        const a = new Comparison(error, keys);
        const b = new Comparison(innerSettings, keys);

        const tmpLimit = Error.stackTraceLimit;
        Error.stackTraceLimit = 0;
        const err = new assert.AssertionError({
          actual: a,
          expected: b,
          operator: 'strictEqual',
          stackStartFn: assert.throws
        });
        Error.stackTraceLimit = tmpLimit;

        throw new assert.AssertionError({
          actual: error,
          expected: settings,
          operator: 'common.expectsError',
          message: err.message
        });
      }

    }
    return true;
  }
  if (fn) {
    assert.throws(fn, innerFn);
    return;
  }
  return mustCall(innerFn, exact);
}

function skipIfInspectorDisabled() {
  if (process.config.variables.v8_enable_inspector === 0) {
    skip('V8 inspector is disabled');
  }
  if (!isMainThread) {
    // TODO(addaleax): Fix me.
    skip('V8 inspector is not available in Workers');
  }
}

function skipIf32Bits() {
  if (bits < 64) {
    skip('The tested feature is not available in 32bit builds');
  }
}

function getArrayBufferViews(buf) {
  const { buffer, byteOffset, byteLength } = buf;

  const out = [];

  const arrayBufferViews = [
    Int8Array,
    Uint8Array,
    Uint8ClampedArray,
    Int16Array,
    Uint16Array,
    Int32Array,
    Uint32Array,
    Float32Array,
    Float64Array,
    DataView
  ];

  for (const type of arrayBufferViews) {
    const { BYTES_PER_ELEMENT = 1 } = type;
    if (byteLength % BYTES_PER_ELEMENT === 0) {
      out.push(new type(buffer, byteOffset, byteLength / BYTES_PER_ELEMENT));
    }
  }
  return out;
}

function getBufferSources(buf) {
  return [...getArrayBufferViews(buf), new Uint8Array(buf).buffer];
}

// Crash the process on unhandled rejections.
const crashOnUnhandledRejection = (err) => { throw err; };
process.on('unhandledRejection', crashOnUnhandledRejection);
function disableCrashOnUnhandledRejection() {
  process.removeListener('unhandledRejection', crashOnUnhandledRejection);
}

function getTTYfd() {
  // Do our best to grab a tty fd.
  const tty = require('tty');
  // Don't attempt fd 0 as it is not writable on Windows.
  // Ref: ef2861961c3d9e9ed6972e1e84d969683b25cf95
  const ttyFd = [1, 2, 4, 5].find(tty.isatty);
  if (ttyFd === undefined) {
    try {
      return fs.openSync('/dev/tty');
    } catch (e) {
      // There aren't any tty fd's available to use.
      return -1;
    }
  }
  return ttyFd;
}

function runWithInvalidFD(func) {
  let fd = 1 << 30;
  // Get first known bad file descriptor. 1 << 30 is usually unlikely to
  // be an valid one.
  try {
    while (fs.fstatSync(fd--) && fd > 0);
  } catch (e) {
    return func(fd);
  }

  printSkipMessage('Could not generate an invalid fd');
}

module.exports = {
  allowGlobals,
  buildType,
  busyLoop,
  canCreateSymLink,
  childShouldThrowAndAbort,
  ddCommand,
  disableCrashOnUnhandledRejection,
  enoughTestCpu,
  enoughTestMem,
  expectsError,
  expectWarning,
  getArrayBufferViews,
  getBufferSources,
  getCallSite,
  getTTYfd,
  hasIntl,
  hasCrypto,
  hasIPv6,
  hasSmallICU,
  hasMultiLocalhost,
  isAIX,
  isAlive,
  isFreeBSD,
  isLinux,
  isLinuxPPCBE,
  isMainThread,
  isOpenBSD,
  isOSX,
  isSunOS,
  isWindows,
  isWOW64,
  leakedGlobals,
  localIPv6Hosts,
  mustCall,
  mustCallAsync,
  mustCallAtLeast,
  mustNotCall,
  nodeProcessAborted,
  noWarnCode: undefined,
  PIPE,
  platformTimeout,
  printSkipMessage,
  pwdCommand,
  rootDir,
  runWithInvalidFD,
  skip,
  skipIf32Bits,
  skipIfEslintMissing,
  skipIfInspectorDisabled,

  get localhostIPv6() { return '::1'; },

  get hasFipsCrypto() {
    return hasCrypto && require('crypto').fips;
  },

  get inFreeBSDJail() {
    if (inFreeBSDJail !== null) return inFreeBSDJail;

    if (exports.isFreeBSD &&
        execSync('sysctl -n security.jail.jailed').toString() === '1\n') {
      inFreeBSDJail = true;
    } else {
      inFreeBSDJail = false;
    }
    return inFreeBSDJail;
  },

  get localhostIPv4() {
    if (localhostIPv4 !== null) return localhostIPv4;

    if (this.inFreeBSDJail) {
      // Jailed network interfaces are a bit special - since we need to jump
      // through loops, as well as this being an exception case, assume the
      // user will provide this instead.
      if (process.env.LOCALHOST) {
        localhostIPv4 = process.env.LOCALHOST;
      } else {
        console.error('Looks like we\'re in a FreeBSD Jail. ' +
                      'Please provide your default interface address ' +
                      'as LOCALHOST or expect some tests to fail.');
      }
    }

    if (localhostIPv4 === null) localhostIPv4 = '127.0.0.1';

    return localhostIPv4;
  },

  // opensslCli defined lazily to reduce overhead of spawnSync
  get opensslCli() {
    if (opensslCli !== null) return opensslCli;

    if (process.config.variables.node_shared_openssl) {
      // use external command
      opensslCli = 'openssl';
    } else {
      // use command built from sources included in Node.js repository
      opensslCli = path.join(path.dirname(process.execPath), 'openssl-cli');
    }

    if (exports.isWindows) opensslCli += '.exe';

    const opensslCmd = spawnSync(opensslCli, ['version']);
    if (opensslCmd.status !== 0 || opensslCmd.error !== undefined) {
      // openssl command cannot be executed
      opensslCli = false;
    }
    return opensslCli;
  },

  get PORT() {
    if (+process.env.TEST_PARALLEL) {
      throw new Error('common.PORT cannot be used in a parallelized test');
    }
    return +process.env.NODE_COMMON_PORT || 12346;
  }

};
