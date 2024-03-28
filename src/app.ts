/**
 * Openbot Solana Bot 
 */

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
import { subscribeToRaydiumPools, subscribeToOpenbook } from './raydium'

import express, { Request, Response } from 'express';


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

const network = 'mainnet-beta';
const RPC_ENDPOINT = retrieveEnvVariable('RPC_ENDPOINT', logger);
const RPC_WEBSOCKET_ENDPOINT = retrieveEnvVariable('RPC_WEBSOCKET_ENDPOINT', logger);
const LOG_LEVEL = retrieveEnvVariable('LOG_LEVEL', logger);

var solanaConnection: any = null;

export type MinimalTokenAccountData = {
    mint: PublicKey;
    address: PublicKey;
    poolKeys?: LiquidityPoolKeys;
    market?: MinimalMarketLayoutV3;
};

let existingLiquidityPools: Set<string> = new Set<string>();
let existingOpenBookMarkets: Set<string> = new Set<string>();
let existingTokenAccounts: Map<string, MinimalTokenAccountData> = new Map<string, MinimalTokenAccountData>();

let wallet: Keypair;
let quoteToken: Token;
let quoteTokenAssociatedAddress: PublicKey;
let quoteAmount: TokenAmount;
let commitment: Commitment = retrieveEnvVariable('COMMITMENT_LEVEL', logger) as Commitment;

const CHECK_IF_MINT_IS_RENOUNCED = retrieveEnvVariable('CHECK_IF_MINT_IS_RENOUNCED', logger) === 'true';
const USE_SNIPE_LIST = retrieveEnvVariable('USE_SNIPE_LIST', logger) === 'true';
const SNIPE_LIST_REFRESH_INTERVAL = Number(retrieveEnvVariable('SNIPE_LIST_REFRESH_INTERVAL', logger));
const AUTO_SELL = retrieveEnvVariable('AUTO_SELL', logger) === 'true';
const MAX_SELL_RETRIES = Number(retrieveEnvVariable('MAX_SELL_RETRIES', logger));
const AUTO_SELL_DELAY = Number(retrieveEnvVariable('AUTO_SELL_DELAY', logger));

let snipeList: string[] = [];

type LogEntry = {
    message: string;
    //type: 'info' | 'error';
    timestamp: Date;
};

// In-memory logs storage
const logs: LogEntry[] = [];

async function init(): Promise<void> {
    logger.level = LOG_LEVEL;

    // get wallet
    const PRIVATE_KEY = retrieveEnvVariable('PRIVATE_KEY', logger);
    try {
        wallet = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
        logger.info(`Wallet Address: ${wallet.publicKey}`);
    } catch (error) {
        logger.error('error reading private key ' + error);
        process.exit();
    }

    // get quote mint and amount
    const QUOTE_MINT = retrieveEnvVariable('QUOTE_MINT', logger);
    const QUOTE_AMOUNT = retrieveEnvVariable('QUOTE_AMOUNT', logger);
    switch (QUOTE_MINT) {
        case 'WSOL': {
            quoteToken = Token.WSOL;
            quoteAmount = new TokenAmount(Token.WSOL, QUOTE_AMOUNT, false);
            break;
        }
        case 'USDC': {
            quoteToken = new Token(
                TOKEN_PROGRAM_ID,
                new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
                6,
                'USDC',
                'USDC',
            );
            quoteAmount = new TokenAmount(quoteToken, QUOTE_AMOUNT, false);
            break;
        }
        default: {
            throw new Error(`Unsupported quote mint "${QUOTE_MINT}". Supported values are USDC and WSOL`);
        }
    }

    logger.info(
        `Script will buy all new tokens using ${QUOTE_MINT}. Amount that will be used to buy each token is: ${quoteAmount.toFixed().toString()}`,
    );

    // check existing wallet for associated token account of quote mint
    try {
        const tokenAccounts = await getTokenAccounts(solanaConnection, wallet.publicKey, commitment);

        for (const ta of tokenAccounts) {
            existingTokenAccounts.set(ta.accountInfo.mint.toString(), <MinimalTokenAccountData>{
                mint: ta.accountInfo.mint,
                address: ta.pubkey,
            });
        }

        const tokenAccount = tokenAccounts.find((acc) => acc.accountInfo.mint.toString() === quoteToken.mint.toString())!;

        if (!tokenAccount) {
            throw new Error(`No ${quoteToken.symbol} token account found in wallet: ${wallet.publicKey}`);
        }
        quoteTokenAssociatedAddress = tokenAccount.pubkey;
    }
    catch (error) {
        logger.error('error reading tokens. No tokens exist');
        //process.exit();
    }
}

function logEntry(message: string) {
    const entry = { message, timestamp: new Date() };
    console.log(entry); // Optionally log to console as well
    logs.push(entry);
}

function saveTokenAccount(mint: PublicKey, accountData: MinimalMarketLayoutV3) {
    const ata = getAssociatedTokenAddressSync(mint, wallet.publicKey);
    const tokenAccount = <MinimalTokenAccountData>{
        address: ata,
        mint: mint,
        market: <MinimalMarketLayoutV3>{
            bids: accountData.bids,
            asks: accountData.asks,
            eventQueue: accountData.eventQueue,
        },
    };
    existingTokenAccounts.set(mint.toString(), tokenAccount);
    return tokenAccount;
}

export async function processRaydiumPool(id: PublicKey, poolState: LiquidityStateV4) {
    //


}

export async function processOpenBookMarket(updatedAccountInfo: KeyedAccountInfo) {
    let accountData: MarketStateV3 | undefined;
    try {
        accountData = MARKET_STATE_LAYOUT_V3.decode(updatedAccountInfo.accountInfo.data);

        // to be competitive, we collect market data before buying the token...
        if (existingTokenAccounts.has(accountData.baseMint.toString())) {
            return;
        }

        saveTokenAccount(accountData.baseMint, accountData);
    } catch (e) {
        logger.error({ mint: accountData?.baseMint }, `Failed to process market `);
        logger.error(e);
    }
}



async function getWalletBalance(connection: any) {
    try {
        const balance = await connection.getBalance(wallet.publicKey);
        logger.info(`Wallet balance: ${balance} lamports (${balance / 1e9} SOL)`);
    } catch (error) {
        logger.error('Error getting wallet balance: ' + error);
    }
};

const runListener = async () => {
    // connect to the network and listen to events
    logger.info('connect network');
    try {
        solanaConnection = new Connection(RPC_ENDPOINT, {
            wsEndpoint: RPC_WEBSOCKET_ENDPOINT,
        })
    } catch (error) {
        logger.error('cant connect')
        process.exit();
    }
    await init();
    await getWalletBalance(solanaConnection);

    const runTimestamp = Math.floor(new Date().getTime() / 1000);

    const raydiumSubscriptionId = await subscribeToRaydiumPools(solanaConnection, runTimestamp);
    logger.info(`Listening for raydium pool changes. (Subscription ID: ${raydiumSubscriptionId})`);

    // const openBookSubscriptionId = await subscribeToOpenbook(solanaConnection, runTimestamp);
    // logger.info(`Listening for openbook changes. (Subscription ID:  ${openBookSubscriptionId})`);

};


runListener();
