#!/usr/bin/env node

'use strict';

//====================================================================

var Bluebird = require('bluebird');
Bluebird.longStackTraces();
var promisify = Bluebird.promisify;

var createReadStream = require('fs').createReadStream;
var createWriteStream = require('fs').createWriteStream;
var resolveUrl = require('url').resolve;
var stat = promisify(require('fs').stat);

var chalk = require('chalk');
var eventToPromise = require('event-to-promise');
var filter = require('lodash.filter');
var forEach = require('lodash.foreach');
var getKeys = require('lodash.keys');
var got = require('got');
var humanFormat = require('human-format');
var isObject = require('lodash.isobject');
var multiline = require('multiline');
var nicePipe = require('nice-pipe');
var pairs = require('lodash.pairs');
var prettyMs = require('pretty-ms');
var progressStream = require('progress-stream');
var sent = promisify(require('sent'));
var Xo = require('xo-lib');

//--------------------------------------------------------------------

var config = require('./config');

//====================================================================

function connect() {
  return config.load().bind({}).then(function (config) {
    if (!config.server)
    {
      throw 'no server to connect to!';
    }

    if (!config.token)
    {
      throw 'no token available';
    }

    var xo = new Xo(config.server);

    return xo.call('session.signInWithToken', {
      token: config.token,
    }).return(xo);
  });
}

function parseParameters (args) {
  var params = {};
  forEach(args, function (arg) {
    var matches;
    if (!(matches = arg.match(PARAM_RE))) {
      throw 'invalid arg: '+arg;
    }
    var name = matches[1];
    var value = matches[2];

    if (name === '@') {
      params['@'] = value;
      return;
    }

    if (value === 'true') {
      value = true;
    }
    else if (value === 'false') {
      value = false;
    }

    params[name] = value;
  });

  return params
}

function printProgress(progress) {
  if (progress.length) {
    console.warn('%s% of %s @ %s/s - ETA %s',
      Math.round(progress.percentage),
      humanFormat(progress.length),
      humanFormat(progress.speed),
      prettyMs(progress.eta * 1e3)
    );
  } else {
    console.warn('%s @ %s/s',
      humanFormat(progress.transferred),
      humanFormat(progress.speed)
    );
  }
}

function wrap(val) {
  return function wrappedValue() {
    return val;
  };
}

//====================================================================

var help = wrap((function (pkg) {
  return multiline.stripIndent(function () {/*
    Usage:

      $name --register [<XO-Server URL>] [<username>] [<password>]
        Registers the XO instance to use.

      $name --list-commands [--json]
        Returns the list of available commands on the current XO instance.

      $name --list-objects [<property>=<value>]...
        Returns a list of XO objects.

      $name <command> [<name>=<value>]...
        Executes a command on the current XO instance.

    $name v$version
  */}).replace(/<([^>]+)>|\$(\w+)/g, function (_, arg, key) {
    if (arg) {
      return '<'+ chalk.yellow(arg) +'>';
    }

    if ('name' === key) {
      return chalk.bold(pkg[key]);
    }

    return pkg[key];
  });
})(require('./package')));

//--------------------------------------------------------------------

function main(args) {
  if (!args || !args.length || '-h' === args[0]) {
    return help();
  }

  var fnName = args[0].replace(/^--|-\w/g, function (match) {
    if (match === '--')
    {
      return '';
    }

    return match[1].toUpperCase();
  });
  if (fnName in exports) {
    return exports[fnName](args.slice(1));
  }

  return exports.call(args);
}
exports = module.exports = main;

//--------------------------------------------------------------------

exports.help = help;

function register(args) {
  var xo;
  return Bluebird.try(function () {
    xo = new Xo(args[0]);

    return xo.call('session.signInWithPassword', {
      email: args[1],
      password: args[2],
    });
  }).then(function (user) {
    console.log('Successfully logged with', user.email);

    return xo.call('token.create');
  }).then(function (token) {
    return config.set({
      server: xo._url,
      token: token,
    });
  });
}
exports.register = register;

function unregister() {
  return config.unset([
    'server',
    'token',
  ]);
}
exports.unregister = unregister;

function listCommands(args) {
  return connect().then(function getMethodsInfo(xo) {
    return xo.call('system.getMethodsInfo');
  }).then(function formatMethodsInfo(methods) {
    if (args.indexOf('--json') !== -1)
    {
      return methods;
    }

    methods = pairs(methods);
    methods.sort(function (a, b) {
      a = a[0];
      b = b[0];
      if (a < b) {
        return -1;
      }
      return +(a > b);
    });

    var str = [];
    forEach(methods, function (method) {
      var name = method[0];
      var info = method[1];
      str.push(chalk.bold.blue(name));
      forEach(info.params || [], function (info, name) {
        str.push(' ');
        if (info.optional) {
          str.push('[');
        }
        str.push(name, '=<', info.type || 'unknown', '>');
        if (info.optional) {
          str.push(']');
        }
      });
      str.push('\n');
      if (info.description) {
        str.push('  ', info.description, '\n');
      }
    });
    return str.join('');
  });
}
exports.listCommands = listCommands;

function listObjects(args) {
  var sieve = args.length
    ? parseParameters(args)
    : null

  return connect().then(function getXoObjects(xo) {
    return xo.call('xo.getAllObjects')
  }).then(function filterObjects (objects) {
    return filter(objects, sieve)
  })
}
exports.listObjects = listObjects

var PARAM_RE = /^([^=]+)=(.*)$/;
function call(args) {
  if (!args.length) {
    throw 'missing command name';
  }

  var method = args.shift();
  var params = parseParameters(args);

  var file = params['@'];
  delete params['@'];

  var baseUrl;
  return connect().then(function (xo) {
    baseUrl = xo._url;
    return xo.call(method, params);
  }).then(function handleResult(result) {
    var keys, key, url;
    if ((
      isObject(result) &&
      (keys = getKeys(result)).length === 1
    )) {
      key = keys[0];

      if (key === '$getFrom') {
        url = resolveUrl(baseUrl, result[key]);
        var output = createWriteStream(file);

        return eventToPromise(nicePipe([
          got(url),
          progressStream({ time: 1e3 }, printProgress),
          output,
        ]), 'finish');
      }

      if (key === '$sendTo') {
        url = resolveUrl(baseUrl, result[key]);

        return stat(file).then(function (stats) {
          var length = stats.size;

          var input = nicePipe([
            createReadStream(file),
            progressStream({
              length: length,
              time: 1e3,
            }, printProgress),
          ]);

          return sent(url, input, {
            headers: {
              'content-length': length,
            },
            method: 'POST'
          }).get(0);
        });
      }
    }

    return result;
  });
}
exports.call = call;

//====================================================================

if (!module.parent) {
  require('exec-promise')(exports);
}
