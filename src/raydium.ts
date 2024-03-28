

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
let older_pools: Map<string, Pool> = new Map<string, Pool>();
let recent_pools: Map<string, Pool> = new Map<string, Pool>();

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

    const reportTime = 10000;
    const waitTime = 30000;

    setTimeout(() => {
        if (events === 0) {
            logger.warn('No logs received within the expected timeframe.');
            process.exit()
            return;
        }
    }, waitTime); // seconds


    setInterval(() => {
        //TODO pools bought
        //TODO pools skipped

        const currentDate = new Date();
        const t = currentDate.getTime() / 1000;
        const delta = (t - startTimestamp);

        logger.info('Seconds since start: ' + delta.toFixed(0));
        logger.info('Total event count: ' + events);
        logger.info('Events per sec: ' + (events / delta).toFixed(0));
        logger.info('New pools since start: ' + recent_pools.size);
        logger.info('Older Pools: ' + older_pools.size);

    }, reportTime); // seconds

    //state
    //https://github.com/raydium-io/raydium-amm/blob/master/program/src/state.rs#L311

    const raydiumSubscriptionId = connection.onProgramAccountChange(
        RAYDIUM_LIQUIDITY_PROGRAM_ID_V4,
        //callback
        async (updatedAccountInfo: any) => {
            try {
                //console.log('updatedAccountInfo ' + updatedAccountInfo.accountInfo.data);
                const key = updatedAccountInfo.accountId.toString();
                events++;

                const known_pool = older_pools.has(key) || recent_pools.has(key);

                const poolState1 = LIQUIDITY_STATE_LAYOUT_V4.decode(updatedAccountInfo.accountInfo.data);
                logger.info('status ' + poolState1.status);
                logger.info('nonce ' + poolState1.nonce);
                logger.info('maxOrder ' + poolState1.maxOrder);
                logger.info('depth ' + poolState1.depth);
                logger.info('state ' + poolState1.state);
                logger.info('swapBaseInAmount ' + poolState1.swapBaseInAmount);

                if (known_pool) {
                    if (older_pools.has(key)) {

                        //known pool
                        //swapcount[key]++;
                        // const pool = older_pools.get(key); // Retrieve the pool object
                        // if (pool) { // Check if the pool object is not undefined
                        //     pool.swapcount++; // Increment swapcount
                        //     older_pools.set(key, pool); // Re-set the pool object back into the Map (may be optional depending on use-case)
                        // }

                    }

                    if (recent_pools.has(key)) {
                        const pool = recent_pools.get(key);
                        if (pool) { // Check if the pool object is not undefined
                            pool.swapcount++; // Increment swapcount
                            recent_pools.set(key, pool);
                            logger.info('swap for recent pool ' + key);
                        }
                    }
                }

                else {

                    //NEW POOL

                    const poolState = LIQUIDITY_STATE_LAYOUT_V4.decode(updatedAccountInfo.accountInfo.data);
                    //console.log('change. poolState ' + poolState);
                    const poolOpenTime = parseInt(poolState.poolOpenTime.toString());

                    //recent_pools.set(key, { address: key, launchTime: poolOpenTime, swapcount: 0 });

                    const currentDate = new Date();
                    const t = currentDate.getTime() / 1000;
                    const delta_seconds = (t - poolOpenTime);

                    const differenceInHours = Math.floor(delta_seconds / (60 * 60));
                    const differenceInMinutes = Math.floor((delta_seconds % (60 * 60)) / 60);

                    // const poolSize = new TokenAmount(quoteToken, poolState.swapQuoteInAmount, true);
                    // logger.info(`Processing pool: ${id.toString()} with ${poolSize.toFixed()} ${quoteToken.symbol} in liquidity`);

                    if (delta_seconds < 300) {
                        recent_pools.set(key, { address: key, launchTime: poolOpenTime, swapcount: 0 });

                        logger.info(`New pool ${key}`);
                        //logger.info(`H: ${differenceInHours} : ${differenceInMinutes}`);
                        logger.info(`age: ${delta_seconds.toFixed(0)}`);
                        //lpools.add(key);
                        //logger.info('#pools ' + lpools.size);
                        //TODO
                        //const _ = processRaydiumPool(updatedAccountInfo.accountId, poolState);
                    } else {
                        logger.info(`Older pool ${key}`);
                        older_pools.set(key, { address: key, launchTime: poolOpenTime, swapcount: 0 });
                    }
                }


            } catch (error) {
                logger.error(error);
            }
        },
        commitment,
        //filter
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
