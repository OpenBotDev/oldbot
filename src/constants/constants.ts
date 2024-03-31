import { Commitment } from "@solana/web3.js";
import { logger, retrieveEnvVariable } from "../utils";

export const NETWORK = 'mainnet-beta';
export const COMMITMENT_LEVEL: Commitment = retrieveEnvVariable('COMMITMENT_LEVEL') as Commitment;
export const RPC_ENDPOINT = retrieveEnvVariable('RPC_ENDPOINT');
export const RPC_WEBSOCKET_ENDPOINT = retrieveEnvVariable('RPC_WEBSOCKET_ENDPOINT');
export const LOG_LEVEL = retrieveEnvVariable('LOG_LEVEL');
export const CHECK_IF_MINT_IS_RENOUNCED = retrieveEnvVariable('CHECK_IF_MINT_IS_RENOUNCED') === 'true';
export const USE_SNIPE_LIST = retrieveEnvVariable('USE_SNIPE_LIST') === 'true';
export const SNIPE_LIST_REFRESH_INTERVAL = Number(retrieveEnvVariable('SNIPE_LIST_REFRESH_INTERVAL'));
export const AUTO_SELL = retrieveEnvVariable('AUTO_SELL') === 'true';
export const MAX_SELL_RETRIES = Number(retrieveEnvVariable('MAX_SELL_RETRIES'));
export const AUTO_SELL_DELAY = Number(retrieveEnvVariable('AUTO_SELL_DELAY'));
export const PRIVATE_KEY = retrieveEnvVariable('PRIVATE_KEY');
export const QUOTE_MINT = retrieveEnvVariable('QUOTE_MINT');
export const QUOTE_AMOUNT = retrieveEnvVariable('QUOTE_AMOUNT');
export const MIN_POOL_SIZE = retrieveEnvVariable('MIN_POOL_SIZE');
export const PAPER_TRADE = retrieveEnvVariable('PAPER_TRADE');

export const WSOL_ADDRESS = 'So11111111111111111111111111111111111111112';
export const USDC_ADDRESS = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
