// File: WSTransport.js
const Transport = require('winston-transport');
const util = require('util');
const WebSocket = require('ws');


function WSTransport(opts) {
    Transport.call(this, opts);
    // Save the WebSocket server reference
    this.wss = opts.wss;
}

util.inherits(WSTransport, Transport);

WSTransport.prototype.log = function (info, callback) {
    setImmediate(() => {
        this.emit('logged', info);
    });

    // Broadcast message to all connected clients
    if (this.wss) {
        this.wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify(info));
            }
        });
    }

    callback();
};

module.exports = WSTransport;
