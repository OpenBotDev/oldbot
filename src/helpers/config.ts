import { readFileSync } from 'fs';
import { Commitment, Connection } from '@solana/web3.js';
import pino from 'pino';
var toml = require('toml');

const configPath = './settings.toml';
const rawConfig = readFileSync(configPath, 'utf-8');

function isConfig(obj: any): obj is Config {
    return 'wallet' in obj && typeof obj.wallet.PRIVATE_KEY === 'string';
    // Add further checks for other properties as necessary
}

interface Config {
    wallet: {
        PRIVATE_KEY: string;
    };
    // connection: {
    //     commitment: Commitment;
    //     rpcEndpoint: string;
    //     rpcWebsocketEndpoint: string;
    // };
    // bot: {
    //     logLevel: string;
    // };
}

try {
    var data = toml.parse(rawConfig);
    console.dir(data);

    //console.log(settings);  // Check what the parsed object looks like


} catch (error) {
    console.error("Failed to parse TOML:", error);
}

// Setup logger
//const logger = pino({ level: settings.bot.logLevel });

// Config object with assertions for necessary validation
const config = {
    //privateKey: settings.wallet.PRIVATE_KEY,
    // network: 'mainnet-beta' as const,
    // commitment: settings.connection.commitment as Commitment,
    // rpcEndpoint: settings.connection.rpcEndpoint,
    // rpcWebsocketEndpoint: settings.connection.rpcWebsocketEndpoint,

    // Add other configurations as needed, validating each one if necessary
};