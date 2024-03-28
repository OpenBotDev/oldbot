import { logger } from './utils';

import {
    LiquidityStateV4,
    LIQUIDITY_STATE_LAYOUT_V4,

} from '@raydium-io/raydium-sdk';
import {
    PublicKey,
} from '@solana/web3.js';

import { getTokenAccounts, RAYDIUM_LIQUIDITY_PROGRAM_ID_V4, OPENBOOK_PROGRAM_ID, createPoolKeys } from './liquidity';
import { getMinimalMarketV3, MinimalMarketLayoutV3 } from './market';
import { MintLayout } from './types';
import bs58 from 'bs58';
import {
    COMMITMENT_LEVEL,
} from './constants';

import { quoteToken } from './buy'

let events = 0;

type ProcessRaydiumPoolFunction = (id: PublicKey, poolState: LiquidityStateV4) => Promise<void>;
const existingLiquidityPools: Set<string> = new Set<string>();

export function listenPools(runTimestamp: number, solanaConnection: any, processRaydiumPool: ProcessRaydiumPoolFunction) {

    const reportTime = 10000;
    const waitTime = 30000;

    setInterval(() => {

        const currentDate = new Date();
        const t = currentDate.getTime() / 1000;
        const delta = (t - runTimestamp);

        logger.info('Seconds since start: ' + delta.toFixed(0));
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
            const poolOpenTime = parseInt(poolState.poolOpenTime.toString());
            const existing = existingLiquidityPools.has(key);

            const currentDate = new Date();
            const t = currentDate.getTime() / 1000;
            const delta_seconds = (t - poolOpenTime);

            const recent = poolOpenTime > runTimestamp;

            if (existing) {

            } else {
                //unknown pool 
                if (recent) {
                    logger.info('recent pool. age seconds: ' + delta_seconds.toFixed(0));
                    existingLiquidityPools.add(key);
                    const _ = processRaydiumPool(updatedAccountInfo.accountId, poolState);
                }
            }
            //logger.info('age of pool ' + delta_seconds);
            //figure out first detection
            // if (delta_seconds < 300) {
            //     logger.info('new pool detected ' + delta_seconds);
            //     logger.info(key);
            // }



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