var http = require('http');
var https = require('https');
var uuid = require('node-uuid');
var os = require('os');
var url = require('url');

var parser = require('./parser');
var packageJson = require('../package.json');

exports.VERSION = packageJson.version;

var SETTINGS = {
  accessToken: null,
  codeVersion: null,
  host: os.hostname(),
  environment: 'development',
  framework: 'node-js',
  root: null,  // root path to your code
  branch: null,  // git branch name
  handler: 'inline',  // 'nextTick' or 'setInterval' or 'inline'
  handlerInterval: 3,  // number of seconds to use with setInterval handler
  batchSize: 10,
  notifier: {
    name: 'node_rollbar',
    version: exports.VERSION
  },
  scrubHeaders: [],
  scrubFields: ['passwd', 'password', 'secret', 'confirm_password', 'password_confirmation'],
  addRequestData: addRequestData
};

var apiClient;
var pendingItems = [];
var intervalHandler;

/*
 * Public API
 */

exports.init = function(api, options) {
  apiClient = api;
  options = options || {};
  SETTINGS.accessToken = api.accessToken;
  for (var opt in options) {
    SETTINGS[opt] = options[opt];
  }

  if (SETTINGS.handler == 'setInterval') {
    intervalHandler = setInterval(postItems, SETTINGS.handlerInterval * 1000);
  }
};

exports.shutdown = function(callback) {
  exports.changeHandler('inline');
  clearIntervalHandler();
  postItems(callback);
};


exports.changeHandler = function(newHandler) {
  clearIntervalHandler();
  SETTINGS.handler = newHandler;
  if (newHandler == 'setInterval') {
    intervalHandler = setInterval(postItems, SETTINGS.handlerInterval * 1000);
  }
};


exports.handleError = function(err, req, callback) {
  return exports.handleErrorWithPayloadData(err, {}, req, callback);
}


exports.handleErrorWithPayloadData = function(err, payloadData, req, callback) {
  // Allow the user to call with an optional request and callback
  // e.g. handleErrorWithPayloadData(err, payloadData, req, callback) 
  //   or handleErrorWithPayloadData(err, payloadData, callback)
  //   or handleErrorPayloadData(err, payloadData)
  if (typeof req === 'function') {
    callback = req;
    req = null;
  }
  callback = callback || function(err) {};

  if (!(err instanceof Error)) {
    return callback(new Error('handleError was passed something other than an Error'));
  }
  try {
    return parser.parseException(err, function(e, errData) {
      if (e) {
        return callback(e);
      } else {
        var data = buildBaseData(payloadData);
        data.body = {
          trace: {
            frames: errData.frames,
            exception: {
              class: errData['class'],
              message: errData.message
            }
          }
        };

        if (req) {
          SETTINGS.addRequestData(data, req);
        }
        data.server = buildServerData();
        return addItem(data, callback);
      }
    });
  } catch (exc) {
    console.error('[Rollbar] error while parsing exception: ' + exc);
    return callback(exc);
  }
};


exports.reportMessage = function(message, level, req, callback) {
  return exports.reportMessageWithPayloadData(message, {level: level}, req, callback);
};


exports.reportMessageWithPayloadData = function(message, payloadData, req, callback) {
  try {
    var data = buildBaseData(payloadData);
    data.body = {
      message: {
        body: message
      }
    };

    if (req) {
      SETTINGS.addRequestData(data, req);
    }
    data.server = buildServerData();
    return addItem(data, callback);
  } catch (exc) {
    console.error('[Rollbar] error while reporting message: ' + exc);
    return callback(exc);
  }
};


/** Internal **/

function postItems(callback) {
  var items;
  var numToRemove;
  callback = callback || function(err, apiResp) {};

  try {
    var looper = function(err, apiResp) {
      if (err) {
        return callback(err);
      } else if (pendingItems.length) {
        numToRemove = Math.min(pendingItems.length, SETTINGS.batchSize);
        items = pendingItems.splice(0, numToRemove);
        return apiClient.postItems(items, looper);
      } else {
        return callback(null, apiResp);
      }
    };
    return looper();
  } catch (exc) {
    console.error('[Rollbar] error while posting items: ' + exc);
    return callback(exc);
  }
};

function addItem(item, callback) {
  pendingItems.push(item);

  if (SETTINGS.handler == 'nextTick') {
    process.nextTick(function() {
      postItems(callback);
    });
  } else if (SETTINGS.handler == 'inline') {
    return postItems(callback);
  } else {
    if (callback && typeof callback === 'function') {
      return callback(null);
    }
  }
}


function buildBaseData(extra) {
  extra = extra || {};
  var data =  {timestamp: Math.floor((new Date().getTime()) / 1000),
               environment: extra.environment || SETTINGS.environment,
               level: extra.level || 'error',
               language: 'javascript',
               framework: extra.framework || SETTINGS.framework,
               uuid: genUuid(),
               notifier: JSON.parse(JSON.stringify(SETTINGS.notifier))};
  
  if (SETTINGS.codeVersion) {
    data.code_version = SETTINGS.codeVersion;
  }
  
  var props = Object.getOwnPropertyNames(extra);
  props.forEach(function(name) {
    if (!data.hasOwnProperty(name)) {
      data[name] = extra[name];
    }
  });
  return data;
}


function addRequestData(data, req) {
  var reqData = buildRequestData(req);
  if (reqData) {
    data.request = reqData;
  }

  if (req.route) {
    data.context = req.route.path;
  } else {
    try {
      data.context = req.app._router.matchRequest(req).path;
    } catch (e) {
      //ignore
    }
  }

  if (req.rollbar_person) {
    data.person = req.rollbar_person;
  } else if (req.user) {
    data.person = {id: req.user.id};
    if (req.user.username) {
      data.person.username = req.user.username;
    }
    if (req.user.email) {
      data.person.email = req.user.email;
    }
  } else if (req.user_id || req.userId) {
    var userId = req.user_id || req.userId;
    if (typeof userId === 'function') {
      userId = userId();
    }
    data.person = {id: userId};
  }
}


function buildServerData() {
  var data = {
    host: SETTINGS.host
  };

  if (SETTINGS.branch) {
    data.branch = SETTINGS.branch;
  }
  if (SETTINGS.root) {
    data.root = SETTINGS.root;
  }
  return data;
}

function buildRequestData(req) {
  var headers = req.headers || {};
  var host = headers.host || '<no host>';
  var proto = req.protocol || (req.socket && req.socket.encrypted) ? 'https' : 'http';
  var reqUrl = proto + '://' + host + (req.url || '');
  var parsedUrl = url.parse(reqUrl, true);
  var data = {url: reqUrl,
              GET: parsedUrl.query,
              user_ip: extractIp(req),
              headers: scrubRequestHeaders(headers),
              method: req.method};

  if (req.body) {
    var bodyParams = {};
    if (typeof req.body === 'object') {
      for (var k in req.body) {
        bodyParams[k] = req.body[k];
      }
      data[req.method] = scrubRequestParams(bodyParams);
    } else {
      data.body = req.body;
    }
  }

  return data;
}

function scrubRequestHeaders(headers, settings) {
  var obj = {};
  settings = settings || SETTINGS;
  for (var k in headers) {
    if (settings.scrubHeaders.indexOf(k) == -1) {
      obj[k] = headers[k];
    }
    else {
      obj[k] = Array(headers[k].length + 1).join('*');
    }
  }
  return obj;
}

function scrubRequestParams(params, settings) {
  settings = settings || SETTINGS;
  for (var k in params) {
    if (params[k] && settings.scrubFields.indexOf(k) >= 0) {
      params[k] = Array(params[k].length + 1).join('*');
    }
  }

  return params;
}


function extractIp(req) {
  var ip = req.ip;
  if (!ip) {
    if (req.headers) {
      ip = req.headers['x-real-ip'] || req.headers['x-forwarded-for'];
    }
    if (!ip && req.connection && req.connection.remoteAddress) {
      ip = req.connection.remoteAddress;
    }
  }
  return ip;
}


function clearIntervalHandler() {
  if (intervalHandler) {
    clearInterval(intervalHandler);
  }
}


function genUuid() {
  var buf = new Buffer(16);
  uuid.v4(null, buf);
  return buf.toString('hex');
}

// Export for testing
exports._scrubRequestHeaders = function(headersToScrub, headers) {
  return scrubRequestHeaders(headers, headersToScrub ? {scrubHeaders: headersToScrub} : undefined);
};

exports._scrubRequestParams = function(paramsToScrub, params) {
  return scrubRequestParams(params, paramsToScrub ? {scrubFields: paramsToScrub} : undefined);
};

exports._extractIp = function(req) {
  return extractIp(req);
};
