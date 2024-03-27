

// /**
//  * Openbot Solana Bot 
//  */

import {
    BigNumberish,
    Liquidity,
    LIQUIDITY_STATE_LAYOUT_V4,
    LiquidityPoolKeys,
    LiquidityStateV4,
    MARKET_STATE_LAYOUT_V3,
    MarketStateV3,
    Token,
    TokenAmount,
} from '@raydium-io/raydium-sdk';
import {
    AccountLayout,
    createAssociatedTokenAccountIdempotentInstruction,
    createCloseAccountInstruction,
    getAssociatedTokenAddressSync,
    TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import {
    Keypair,
    Connection,
    PublicKey,
    ComputeBudgetProgram,
    KeyedAccountInfo,
    TransactionMessage,
    VersionedTransaction,
    Commitment,
} from '@solana/web3.js';
import { getTokenAccounts, RAYDIUM_LIQUIDITY_PROGRAM_ID_V4, OPENBOOK_PROGRAM_ID, createPoolKeys } from './liquidity';
import { retrieveEnvVariable } from './utils';
import { getMinimalMarketV3, MinimalMarketLayoutV3 } from './market';
import { MintLayout } from './types';
import pino from 'pino';
import bs58 from 'bs58';
import * as fs from 'fs';
import * as path from 'path';

const transport = pino.transport({
    target: 'pino-pretty',
});

export const logger = pino(
    {
        level: 'info',
        redact: ['poolKeys'],
        serializers: {
            error: pino.stdSerializers.err,
        },
        base: undefined,
    },
    transport,
);


let existingLiquidityPools: Set<string> = new Set<string>();
let existingOpenBookMarkets: Set<string> = new Set<string>();

let wallet: Keypair;
let quoteToken: Token;
let quoteTokenAssociatedAddress: PublicKey;
let quoteAmount: TokenAmount;
let commitment: Commitment = retrieveEnvVariable('COMMITMENT_LEVEL', logger) as Commitment;

const CHECK_IF_MINT_IS_RENOUNCED = retrieveEnvVariable('CHECK_IF_MINT_IS_RENOUNCED', logger) === 'true';
//const USE_SNIPE_LIST = retrieveEnvVariable('USE_SNIPE_LIST', logger) === 'true';
const SNIPE_LIST_REFRESH_INTERVAL = Number(retrieveEnvVariable('SNIPE_LIST_REFRESH_INTERVAL', logger));
//const AUTO_SELL = retrieveEnvVariable('AUTO_SELL', logger) === 'true';
const MAX_SELL_RETRIES = Number(retrieveEnvVariable('MAX_SELL_RETRIES', logger));
const AUTO_SELL_DELAY = Number(retrieveEnvVariable('AUTO_SELL_DELAY', logger));


// subscribe to changes from a pool
async function subscribeToRaydiumPools(connection: any, runTimestamp: any) {

    logger.info('subscribeToRaydiumPools...');
    let events = 0;
    quoteToken = Token.WSOL;
    const raydiumSubscriptionId = connection.onProgramAccountChange(
        RAYDIUM_LIQUIDITY_PROGRAM_ID_V4,
        async (updatedAccountInfo: any) => {
            const key = updatedAccountInfo.accountId.toString();
            events++;
            //logger.info('change. key ' + key);
            //logger.info('events. ' + events);
            const poolState = LIQUIDITY_STATE_LAYOUT_V4.decode(updatedAccountInfo.accountInfo.data);
            //console.log('change. poolState ' + poolState);
            const poolOpenTime = parseInt(poolState.poolOpenTime.toString());

            const currentDate = new Date();
            const t = currentDate.getTime() / 1000;
            const timeDifference = (t - poolOpenTime);

            const differenceInHours = Math.floor(timeDifference / (1000 * 60 * 60));
            const differenceInMinutes = Math.floor((timeDifference % (1000 * 60 * 60)) / (1000 * 60));

            logger.info(`${key} H: ${differenceInHours} : ${differenceInMinutes} ${timeDifference}`);
            logger.info(`${poolOpenTime}`);

            const existing = existingLiquidityPools.has(key);

            if (poolOpenTime > runTimestamp && !existing) {
                logger.info('new pool');
                existingLiquidityPools.add(key);
                logger.info('#pools ' + existingLiquidityPools.size);
                //TODO
                //const _ = processRaydiumPool(updatedAccountInfo.accountId, poolState);
            }
        },
        commitment,
        [
            { dataSize: LIQUIDITY_STATE_LAYOUT_V4.span },
            {
                memcmp: {
                    offset: LIQUIDITY_STATE_LAYOUT_V4.offsetOf('quoteMint'),
                    bytes: quoteToken.mint.toBase58(),
                },
            },
            {
                memcmp: {
                    offset: LIQUIDITY_STATE_LAYOUT_V4.offsetOf('marketProgramId'),
                    bytes: OPENBOOK_PROGRAM_ID.toBase58(),
                },
            },
            {
                memcmp: {
                    offset: LIQUIDITY_STATE_LAYOUT_V4.offsetOf('status'),
                    bytes: bs58.encode([6, 0, 0, 0, 0, 0, 0, 0]),
                },
            },
        ],
    );

    return raydiumSubscriptionId;
}

async function subscribeToOpenbook(connection: any, runTimestamp: any) {
    const openBookSubscriptionId = connection.onProgramAccountChange(
        OPENBOOK_PROGRAM_ID,
        async (updatedAccountInfo: any) => {
            const key = updatedAccountInfo.accountId.toString();
            const existing = existingOpenBookMarkets.has(key);
            if (!existing) {
                existingOpenBookMarkets.add(key);
                //TODO
                //const _ = processOpenBookMarket(updatedAccountInfo);
            }
        },
        commitment,
        [
            { dataSize: MARKET_STATE_LAYOUT_V3.span },
            {
                memcmp: {
                    offset: MARKET_STATE_LAYOUT_V3.offsetOf('quoteMint'),
                    bytes: quoteToken.mint.toBase58(),
                },
            },
        ],
    );
    return openBookSubscriptionId;
}

export { subscribeToOpenbook, subscribeToRaydiumPools };
