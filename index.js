#!/usr/bin/env node

'use strict'

var Bluebird = require('bluebird')
Bluebird.longStackTraces()

var createReadStream = require('fs').createReadStream
var createWriteStream = require('fs').createWriteStream
var resolveUrl = require('url').resolve
var stat = require('fs-promise').stat

var chalk = require('chalk')
var eventToPromise = require('event-to-promise')
var filter = require('lodash/filter')
var forEach = require('lodash/forEach')
var getKeys = require('lodash/keys')
var got = require('got')
var humanFormat = require('human-format')
var isObject = require('lodash/isObject')
var micromatch = require('micromatch')
var multiline = require('multiline')
var nicePipe = require('nice-pipe')
var pairs = require('lodash/toPairs')
var pick = require('lodash/pick')
var prettyMs = require('pretty-ms')
var progressStream = require('progress-stream')
var Xo = require('xo-lib').default

// -------------------------------------------------------------------

var config = require('./config')

// ===================================================================

function connect () {
  return config.load().bind({}).then(function (config) {
    if (!config.server) {
      throw new Error('no server to connect to!')
    }

    if (!config.token) {
      throw new Error('no token available')
    }

    var xo = new Xo({ url: config.server })

    return xo.open().then(function () {
      return xo.signIn({ token: config.token })
    }).then(function () {
      return xo
    })
  })
}

function _startsWith (string, search) {
  return string.lastIndexOf(search, 0) === 0
}

var PARAM_RE = /^([^=]+)=([^]*)$/
function parseParameters (args) {
  var params = {}
  forEach(args, function (arg) {
    var matches
    if (!(matches = arg.match(PARAM_RE))) {
      throw new Error('invalid arg: ' + arg)
    }
    var name = matches[1]
    var value = matches[2]

    if (_startsWith(value, 'json:')) {
      value = JSON.parse(value.slice(5))
    }

    if (name === '@') {
      params['@'] = value
      return
    }

    if (value === 'true') {
      value = true
    } else if (value === 'false') {
      value = false
    }

    params[name] = value
  })

  return params
}

var humanFormatOpts = {
  unit: 'B',
  scale: 'binary'
}

function printProgress (progress) {
  if (progress.length) {
    console.warn('%s% of %s @ %s/s - ETA %s',
      Math.round(progress.percentage),
      humanFormat(progress.length, humanFormatOpts),
      humanFormat(progress.speed, humanFormatOpts),
      prettyMs(progress.eta * 1e3)
    )
  } else {
    console.warn('%s @ %s/s',
      humanFormat(progress.transferred, humanFormatOpts),
      humanFormat(progress.speed, humanFormatOpts)
    )
  }
}

function wrap (val) {
  return function wrappedValue () {
    return val
  }
}

// ===================================================================

var help = wrap((function (pkg) {
  return multiline.stripIndent(function () { /*
    Usage:

      $name --register [<XO-Server URL>] [<username>] [<password>]
        Registers the XO instance to use.

      $name --unregister
        Remove stored credentials.

      $name --list-commands [--json] [<pattern>]...
        Returns the list of available commands on the current XO instance.

        The patterns can be used to filter on command names.

      $name --list-objects [<property>=<value>]...
        Returns a list of XO objects.

      $name <command> [<name>=<value>]...
        Executes a command on the current XO instance.

    $name v$version
  */ }).replace(/<([^>]+)>|\$(\w+)/g, function (_, arg, key) {
    if (arg) {
      return '<' + chalk.yellow(arg) + '>'
    }

    if (key === 'name') {
      return chalk.bold(pkg[key])
    }

    return pkg[key]
  })
})(require('./package')))

// -------------------------------------------------------------------

function main (args) {
  if (!args || !args.length || args[0] === '-h') {
    return help()
  }

  var fnName = args[0].replace(/^--|-\w/g, function (match) {
    if (match === '--') {
      return ''
    }

    return match[1].toUpperCase()
  })
  if (fnName in exports) {
    return exports[fnName](args.slice(1))
  }

  return exports.call(args)
}
exports = module.exports = main

// -------------------------------------------------------------------

exports.help = help

function register (args) {
  var xo = new Xo({ url: args[0] })
  return xo.open().then(function () {
    return xo.signIn({
      email: args[1],
      password: args[2]
    })
  }).then(function () {
    console.log('Successfully logged with', xo.user.email)

    return xo.call('token.create')
  }).then(function (token) {
    return config.set({
      server: args[0],
      token: token
    })
  })
}
exports.register = register

function unregister () {
  return config.unset([
    'server',
    'token'
  ])
}
exports.unregister = unregister

function listCommands (args) {
  return connect().then(function getMethodsInfo (xo) {
    return xo.call('system.getMethodsInfo')
  }).then(function formatMethodsInfo (methods) {
    var json = false
    var patterns = []
    forEach(args, function (arg) {
      if (arg === '--json') {
        json = true
      } else {
        patterns.push(arg)
      }
    })

    if (patterns.length) {
      methods = pick(methods, micromatch(Object.keys(methods), patterns))
    }

    if (json) {
      return methods
    }

    methods = pairs(methods)
    methods.sort(function (a, b) {
      a = a[0]
      b = b[0]
      if (a < b) {
        return -1
      }
      return +(a > b)
    })

    var str = []
    forEach(methods, function (method) {
      var name = method[0]
      var info = method[1]
      str.push(chalk.bold.blue(name))
      forEach(info.params || [], function (info, name) {
        str.push(' ')
        if (info.optional) {
          str.push('[')
        }
        str.push(name, '=<', info.type || 'unknown', '>')
        if (info.optional) {
          str.push(']')
        }
      })
      str.push('\n')
      if (info.description) {
        str.push('  ', info.description, '\n')
      }
    })
    return str.join('')
  })
}
exports.listCommands = listCommands

function listObjects (args) {
  var sieve = args.length
    ? parseParameters(args)
    : null

  return connect().then(function getXoObjects (xo) {
    return xo.call('xo.getAllObjects')
  }).then(function filterObjects (objects) {
    return filter(objects, sieve)
  })
}
exports.listObjects = listObjects

function call (args) {
  if (!args.length) {
    throw new Error('missing command name')
  }

  var method = args.shift()
  var params = parseParameters(args)

  var file = params['@']
  delete params['@']

  var baseUrl
  return connect().then(function (xo) {
    // FIXME: do not use private properties.
    baseUrl = xo._url.replace(/^ws/, 'http')

    return xo.call(method, params)
  }).then(function handleResult (result) {
    var keys, key, url
    if (
      isObject(result) &&
      (keys = getKeys(result)).length === 1
    ) {
      key = keys[0]

      if (key === '$getFrom') {
        url = resolveUrl(baseUrl, result[key])
        var output = createWriteStream(file)

        var progress = progressStream({ time: 1e3 }, printProgress)

        return eventToPromise(nicePipe([
          got.stream(url).on('response', function (response) {
            var length = response.headers['content-length']
            if (length) {
              progress.length(length)
            }
          }),
          progress,
          output
        ]), 'finish')
      }

      if (key === '$sendTo') {
        url = resolveUrl(baseUrl, result[key])

        return stat(file).then(function (stats) {
          var length = stats.size

          var input = nicePipe([
            createReadStream(file),
            progressStream({
              length: length,
              time: 1e3
            }, printProgress)
          ])

          return got.post(url, {
            body: input,
            headers: {
              'content-length': length
            },
            method: 'POST'
          }).then(function (response) {
            return response.body
          })
        })
      }
    }

    return result
  })
}
exports.call = call

// ===================================================================

if (!module.parent) {
  require('exec-promise')(exports)
}
