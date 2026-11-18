/*global navigator*/
'use strict';

const {
  REGEX_BACKSLASH,
  REGEX_SPECIAL_CHARS,
  REGEX_SPECIAL_CHARS_GLOBAL
} = require('./constants');

exports.isObject = val => val !== null && typeof val === 'object' && !Array.isArray(val);
exports.hasRegexChars = str => REGEX_SPECIAL_CHARS.test(str);
exports.isRegexChar = str => str.length === 1 && exports.hasRegexChars(str);
exports.escapeRegex = str => str.replace(REGEX_SPECIAL_CHARS_GLOBAL, '\\$1');
exports.toPosixSlashes = str => str.replace(REGEX_BACKSLASH, '/');

exports.isWindows = () => {
  if (typeof navigator !== 'undefined' && navigator.platform) {
    const platform = navigator.platform.toLowerCase();
    return platform === 'win32' || platform === 'windows';
  }

  if (typeof process !== 'undefined' && process.platform) {
    return process.platform === 'win32';
  }

  return false;
};

const isLineTerminator = char =>
  char === '\n' || char === '\r' || char === '\u2028' || char === '\u2029';

/**
 * Preserve complete bracket expressions while removing escape backslashes
 * elsewhere. Unlike the previous backtracking regular expression, each
 * character is inspected a bounded number of times, even for many unmatched
 * opening brackets in untrusted glob strings.
 */
exports.removeBackslashes = str => {
  const parts = [];
  let index = 0;

  const appendUnescaped = limit => {
    while (index < limit) {
      if (str[index] === '\\' && index + 1 < str.length && !isLineTerminator(str[index + 1])) {
        index++;
      } else {
        parts.push(str[index]);
        index++;
      }
    }
  };

  while (index < str.length) {
    if (str[index] !== '[') {
      appendUnescaped(index + 1);
      continue;
    }

    let closing = -1;
    let boundary = str.length;

    for (let cursor = index + 1; cursor < str.length; cursor++) {
      const char = str[cursor];
      if (isLineTerminator(char)) {
        boundary = cursor;
        // A bracket expression may end with exactly one line terminator:
        // the original pattern's final negated class matches that character.
        if (str[cursor + 1] === ']') closing = cursor + 1;
        break;
      }

      if (cursor >= index + 2 && char === ']' && str[cursor - 1] !== '\\') {
        closing = cursor;
        break;
      }
    }

    if (closing !== -1) {
      parts.push(str.slice(index, closing + 1));
      index = closing + 1;
    } else {
      // No bracket expression can begin later on this same line either.
      appendUnescaped(boundary);
    }
  }

  return parts.join('');
};
exports.escapeLast = (input, char, lastIdx) => {
  const idx = input.lastIndexOf(char, lastIdx);
  if (idx === -1) return input;
  if (input[idx - 1] === '\\') return exports.escapeLast(input, char, idx - 1);
  return `${input.slice(0, idx)}\\${input.slice(idx)}`;
};

exports.removePrefix = (input, state = {}) => {
  let output = input;
  if (output.startsWith('./')) {
    output = output.slice(2);
    state.prefix = './';
  }
  return output;
};

exports.wrapOutput = (input, state = {}, options = {}) => {
  const prepend = options.contains ? '' : '^';
  const append = options.contains ? '' : '$';

  let output = `${prepend}(?:${input})${append}`;
  if (state.negated === true) {
    output = `(?:^(?!${output}).*$)`;
  }
  return output;
};

exports.basename = (path, { windows } = {}) => {
  const segs = path.split(windows ? /[\\/]/ : '/');
  const last = segs[segs.length - 1];

  if (last === '') {
    return segs[segs.length - 2];
  }

  return last;
};
