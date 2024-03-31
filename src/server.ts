const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');
var winstonWS = require("winston-websocket");
import { logger } from './utils';

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.get('/', (req, res) => {
    // Specify the path to your index.html
    const indexPath = path.join(__dirname, 'index.html');
    res.sendFile(indexPath);
});

// WebSocket connection handler
wss.on('connection', (ws) => {
    console.log('Client connected');

    ws.on('message', (message) => {
        console.log(`Received message => ${message}`);
        // Echo the message back to the client
        ws.send(`Echo: ${message}`);
    });

    ws.on('close', () => {
        console.log('Client disconnected');
    });

    // Send a message to the client
    ws.send('Welcome to the WebSocket server!');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
