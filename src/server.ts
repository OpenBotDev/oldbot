const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');
import { logger } from './utils';
import { runListener } from './bot'

const app = express();
export const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const WSTransport = require('./utils/wstransport');

// new WSTransport({
//     wsoptions: wsoptions,
//     authCallback: authCallback,
//     app: app,
//     name: "websocketLog"
//   })

var wsoptions = {
    server: server,
    path: "/logs"
};

//logger.add(new WSTransport({ wsoptions: wsoptions, }));
logger.add(new WSTransport({ wss: wss }));



app.get('/', (req: any, res: any) => {
    // Specify the path to your index.html
    const indexPath = path.join(__dirname, 'index.html');
    res.sendFile(indexPath);
});

// WebSocket connection handler
wss.on('connection', (ws: any) => {
    console.log('Client connected');

    ws.on('message', (message: any) => {
        console.log(`Received message => ${message}`);
        // Echo the message back to the client
        ws.send(`Echo: ${message}`);
    });

    ws.on('close', () => {
        console.log('Client disconnected');
    });

    // Send a message to the client
    ws.send('Openbot. server started');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});

runListener(logger);


