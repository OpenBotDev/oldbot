

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
    PublicKey,
    Commitment,
} from '@solana/web3.js';
import { getTokenAccounts, RAYDIUM_LIQUIDITY_PROGRAM_ID_V4, OPENBOOK_PROGRAM_ID, createPoolKeys } from './liquidity';
import { retrieveEnvVariable } from './utils';
import pino from 'pino';
import bs58 from 'bs58';

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


interface Pool {
    address: string;
    launchTime: number;
    swapcount: number;
}
let lpools: Map<string, Pool> = new Map<string, Pool>();

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
async function subscribeToRaydiumPools(connection: any, startTimestamp: any) {

    logger.info('subscribeToRaydiumPools...');
    let events = 0;
    quoteToken = Token.WSOL;

    // this.logTimeout = setTimeout(() => {
    //     if (this.logcounter === 0) {
    //         logger.info('No logs received within the expected timeframe.');
    //         return;
    //         // Take appropriate action here, such as retrying or handling the error
    //     }
    // }, 5000); // seconds

    const reportTime = 30000;

    setTimeout(() => {
        if (events === 0) {
            logger.warn('No logs received within the expected timeframe.');
            process.exit()
            return;
        }
    }, reportTime); // seconds

    let lpools: Map<string, Pool> = new Map<string, Pool>();

    setInterval(() => {
        //logger.info('Signature count: ' + this.logcounter);
        //logger.info('Signature count with errors: ' + this.logcounter_error);
        //logger.info('Pools Created count: ' + this.poolsFound);
        //TODO pools bought
        //TODO pools skipped
        //logger.info('Event count: ' + this.poolsFound);

        const currentDate = new Date();
        const t = currentDate.getTime() / reportTime;
        const delta = (t - startTimestamp);

        logger.info('Event count: ' + events);
        logger.info('Events per sec: ' + events / delta);
        logger.info('Tracking Pools: ' + lpools.size);
        // let p = this.logcounter_error / this.logcounter;
        // Log.info('% errors: ' + p);
    }, reportTime); // seconds

    const raydiumSubscriptionId = connection.onProgramAccountChange(
        RAYDIUM_LIQUIDITY_PROGRAM_ID_V4,
        async (updatedAccountInfo: any) => {
            try {
                const key = updatedAccountInfo.accountId.toString();
                events++;

                const existing = lpools.has(key);
                if (existing) {
                    //known pool
                    //swapcount[key]++;
                    const pool = lpools.get(key); // Retrieve the pool object
                    if (pool) { // Check if the pool object is not undefined
                        pool.swapcount++; // Increment swapcount
                        lpools.set(key, pool); // Re-set the pool object back into the Map (may be optional depending on use-case)
                    }

                } else {

                    //swapcount[key] = 1;

                    //logger.info('change. key ' + key);
                    //logger.info('events. ' + events);
                    const poolState = LIQUIDITY_STATE_LAYOUT_V4.decode(updatedAccountInfo.accountInfo.data);
                    //console.log('change. poolState ' + poolState);
                    const poolOpenTime = parseInt(poolState.poolOpenTime.toString());

                    lpools.set(key, { address: key, launchTime: poolOpenTime, swapcount: 0 });


                    const currentDate = new Date();
                    const t = currentDate.getTime() / 1000;
                    const delta = (t - poolOpenTime);

                    const differenceInHours = Math.floor(delta / (60 * 60));
                    const differenceInMinutes = Math.floor((delta % (60 * 60)) / 60);

                    //const since = poolOpenTime - startTimestamp;

                    // const poolSize = new TokenAmount(quoteToken, poolState.swapQuoteInAmount, true);
                    // logger.info(`Processing pool: ${id.toString()} with ${poolSize.toFixed()} ${quoteToken.symbol} in liquidity`);


                    if (delta < 120) {
                        logger.info(`New pool\n${key} \n${delta}     ${differenceInHours} : ${differenceInMinutes}`);
                        logger.info(`H: ${differenceInHours} : ${differenceInMinutes}`);
                        logger.info(`${t}    ${poolOpenTime} ${delta}`);
                        //lpools.add(key);
                        logger.info('#pools ' + lpools.size);
                        //TODO
                        //const _ = processRaydiumPool(updatedAccountInfo.accountId, poolState);
                    }
                }


            } catch (error) {
                logger.error(error);
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

async function subscribeToOpenbook(connection: any, startTimestamp: any) {
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
