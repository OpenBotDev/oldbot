import {
    getAssociatedTokenAddress
} from '@solana/spl-token';
import {
    PublicKey,
    LAMPORTS_PER_SOL,
    Connection
} from '@solana/web3.js';
import { logger } from './utils/logger';
import { getMinimalMarketV3, MinimalMarketLayoutV3 } from './market';
import { MintLayout } from './types';
import bs58 from 'bs58';
import * as fs from 'fs';
import * as path from 'path';
import {

    USDC_ADDRESS,
    WSOL_ADDRESS
} from './constants';


export async function getTokenBalance(walletPublicKey: PublicKey, mintAddress: string, connection: Connection): Promise<number | null> {
    const walletPubKey = new PublicKey(walletPublicKey);
    const tokenMintPubKey = new PublicKey(mintAddress);

    const associatedTokenAddress = await getAssociatedTokenAddress(tokenMintPubKey, walletPubKey);

    try {
        // Query the balance
        const balanceResult = await connection.getTokenAccountBalance(associatedTokenAddress);
        return balanceResult.value.uiAmount;
    } catch (error) {
        console.error(`Could not fetch balance for account ${associatedTokenAddress.toString()}: ${error}`);
        return null;
    }
}

export async function getTokenBalanceQuote(walletPublicKey: PublicKey, QUOTE_MINT: string, connection: Connection): Promise<number | null> {
    let mintAddress = undefined;
    if (QUOTE_MINT === 'WSOL') {
        mintAddress = WSOL_ADDRESS;
    }
    if (QUOTE_MINT === 'USDC') {
        mintAddress = USDC_ADDRESS;
    }
    if (!mintAddress) return null;

    return getTokenBalance(walletPublicKey, mintAddress, connection);

}

export async function checkMintable(vault: PublicKey, connection: Connection): Promise<boolean | undefined> {
    try {
        let { data } = (await connection.getAccountInfo(vault)) || {};
        if (!data) {
            return;
        }
        const deserialize = MintLayout.decode(data);
        return deserialize.mintAuthorityOption === 0;
    } catch (e) {
        logger.debug(e);
        logger.error('Failed to check if mint is renounced', { mint: vault });
    }
}


export async function getWalletSOLBalance(connection: any, wallet: any) {
    try {
        const balance = await connection.getBalance(wallet.publicKey) / LAMPORTS_PER_SOL;
        return balance;

    } catch (error) {
        logger.error('Error getting wallet balance: ' + error);
    }
};
