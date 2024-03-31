import { logger } from './utils';

import {
    LiquidityStateV4,
    LIQUIDITY_STATE_LAYOUT_V4,
    MARKET_STATE_LAYOUT_V3
} from '@raydium-io/raydium-sdk';
import {
    PublicKey,
} from '@solana/web3.js';

import { RAYDIUM_LIQUIDITY_PROGRAM_ID_V4, OPENBOOK_PROGRAM_ID, createPoolKeys } from './liquidity';
import bs58 from 'bs58';
import {
    COMMITMENT_LEVEL,
} from './constants';

import { quoteToken } from './bot'

let events = 0;

type ProcessRaydiumPoolFunction = (id: PublicKey, poolState: LiquidityStateV4) => Promise<void>;
type ProcessOpenmarketFunction = (updatedAccountInfo: any) => Promise<void>;

const knownPools: Set<string> = new Set<string>();
const existingOpenBookMarkets: Set<string> = new Set<string>();


export function listenPools(runTimestamp: number, solanaConnection: any, processRaydiumPool: ProcessRaydiumPoolFunction) {

    const reportTime = 10000;
    const waitTime = 30000;

    setInterval(() => {

        const currentDate = new Date();
        const t = currentDate.getTime() / 1000;
        const delta = (t - runTimestamp);

        logger.info('Seconds since start: ' + delta.toFixed(0));
        logger.info('Known pools: ' + knownPools.size);
        logger.info('Total event count: ' + events);
        logger.info('Events per sec: ' + (events / delta).toFixed(0));

    }, reportTime); // seconds

    setTimeout(() => {
        if (events === 0) {
            logger.warn('No events received from Node within the expected timeframe.');
            process.exit()
            return;
        }
    }, waitTime); // seconds


    const raydiumSubscriptionId = solanaConnection.onProgramAccountChange(
        RAYDIUM_LIQUIDITY_PROGRAM_ID_V4,
        async (updatedAccountInfo: any) => {
            events++;

            const key = updatedAccountInfo.accountId.toString();
            const poolState = LIQUIDITY_STATE_LAYOUT_V4.decode(updatedAccountInfo.accountInfo.data);

            const existing = knownPools.has(key);

            if (existing) {

            } else {
                const poolOpenTime = parseInt(poolState.poolOpenTime.toString());
                const currentDate = new Date();
                const t = currentDate.getTime() / 1000;
                const delta_seconds = (t - poolOpenTime);
                const dif = poolOpenTime - runTimestamp;
                const recent = dif > 0;

                knownPools.add(key);

                //unknown pool 
                if (recent) {
                    logger.info('Detected recent pool. age seconds: ' + delta_seconds.toFixed(0));
                    const _ = processRaydiumPool(updatedAccountInfo.accountId, poolState);
                } else {
                    //logger.info('known pool')
                }
            }

        },
        COMMITMENT_LEVEL,
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

    logger.info(`Listening for raydium changes (Subscription ID  ${raydiumSubscriptionId})`);
}

export function listenOpenbook(solanaConnection: any, processOpenmarket: ProcessOpenmarketFunction) {
    const openBookSubscriptionId = solanaConnection.onProgramAccountChange(
        OPENBOOK_PROGRAM_ID,
        async (updatedAccountInfo: any) => {
            const key = updatedAccountInfo.accountId.toString();
            const existing = existingOpenBookMarkets.has(key);
            if (!existing) {
                existingOpenBookMarkets.add(key);
                //TODO
                //const _ = processOpenBookMarket(updatedAccountInfo);
                processOpenmarket(updatedAccountInfo);
            }
        },
        COMMITMENT_LEVEL,
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

    logger.info(`Listening for open book changes (Subscription ID ${openBookSubscriptionId})`);
}