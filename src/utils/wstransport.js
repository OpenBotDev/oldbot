var winston = require("winston");
var ws = require("ws");
var util = require("util");

var WSTransport = function (options) {
    this.name = options.name || "wstransport";
    this.level = options.level || "debug";
    this.archive = [];
    startWSServer(options.wsoptions, options.authCallback, options.app, this.name);
};

util.inherits(WSTransport, winston.Transport);

WSTransport.prototype.log = function (level, msg, meta, callback) {
    var curlog = {
        level: level,
        message: msg,
        createdAt: new Date().toISOString()
    };
    this.archive.push(curlog);
    if (this.archive.length > 500) this.archive.splice(0, this.archive.length - 500);
    this.emit('logtransmit', curlog);
    callback(null, true);
};

var startWSServer = function (options, authCallback, app, loggerName) {
    if (authCallback) options.verifyClient = getVerifyFunc(authCallback, app);
    var wss = new ws.Server(options);
    wss.on('connection', function (ws) {
        var memLogger = winston["default"].transports[loggerName];
        attachWSToLogger(ws, memLogger);
    });
};

var dummyFunc = function () { };

var getVerifyFunc = function (authCallback, app) {
    return function (info, verifyCallback) {
        var req = info.req;
        req.url = "/__websocketproxy__" + req.url;
        req.isWebSocketProxy = true;
        var res = {
            setHeader: dummyFunc,
            output: { push: dummyFunc },
            outputEncodings: { push: dummyFunc }
        };
        req.websocketProxyEnd = function () { authCallback(req, verifyCallback); };
        app(info.req, res);
    };
};

var attachWSToLogger = function (ws, memLogger) {
    ws.send(JSON.stringify(memLogger.archive));
    var transmitListener = function (log) {
        if (ws.readyState === 1)
            ws.send(JSON.stringify([log]));
    };
    memLogger.on('logtransmit', transmitListener);
    return ws.on('close', function () {
        memLogger.removeListener('logtransmit', transmitListener);
    });
};

exports.authorizeWebSocket = function () {
    return function (req, res, next) {
        if (req.isWebSocketProxy) req.websocketProxyEnd(); else next();
    };
};

exports.WSTransport = WSTransport;