import {
    BigNumberish,
    Liquidity,
    LiquidityStateV4,
} from '@raydium-io/raydium-sdk';
import {
    createAssociatedTokenAccountIdempotentInstruction,
    createCloseAccountInstruction,
} from '@solana/spl-token';
import {
    Connection,
    PublicKey,
    ComputeBudgetProgram,
    TransactionMessage,
    VersionedTransaction,
} from '@solana/web3.js';
import { createPoolKeys } from './liquidity';
import { logger } from './utils/logger';
import { getMinimalMarketV3 } from './market';
import {
    AUTO_SELL_DELAY,
    COMMITMENT_LEVEL,
    MAX_SELL_RETRIES,
    NETWORK,
} from './constants';

import { existingTokenAccounts, saveTokenAccount } from './bot'


const confirmTransactionWithTimeout = (connection: Connection, signature: any, blockheight: any, hash: any, TX_COMMITMENT_LEVEL: any, accountData: any) => {
    return new Promise((resolve, reject) => {
        // Start the timeout timer
        const timeoutId = setTimeout(() => {
            reject(new Error('Transaction confirmation timed out'));
        }, 5000); // 5 seconds timeout

        // Attempt to confirm the transaction
        connection.confirmTransaction(
            {
                signature,
                lastValidBlockHeight: blockheight,
                blockhash: hash,
            },
            TX_COMMITMENT_LEVEL,
        ).then(confirmation => {
            logger.info('received confirmation');
            clearTimeout(timeoutId); // Clear the timeout timer
            if (!confirmation.value.err) {
                // Transaction confirmed successfully
                logger.info('Confirmed buy tx', {
                    token: accountData.baseMint,
                    signature: signature,
                    url: `https://solscan.io/tx/${signature}?cluster=${NETWORK}`,
                });
                logger.info(confirmation)
                logger.info(confirmation.value)

                resolve(confirmation); // Resolve the promise successfully
            } else {
                // Transaction confirmation returned an error
                logger.error(confirmation.value.err);
                logger.info('Error confirming buy tx', { mint: accountData.baseMint, signature });
                reject(new Error('Error confirming buy tx')); // Reject the promise with error
            }
        }).catch(err => {
            logger.error('didnt receive confirmation');
            clearTimeout(timeoutId); // Clear the timeout timer
            reject(err); // Reject the promise with the error caught from confirmTransaction
        });
    });
};


export async function buy(accountId: PublicKey, accountData: LiquidityStateV4, connection: Connection, wallet: any, quoteTokenAssociatedAddress: any, quoteAmount: any): Promise<void> {
    logger.info('BUY Prepare. Amount: ' + quoteAmount + ' Token: ' + quoteTokenAssociatedAddress)
    try {
        let tokenAccount = existingTokenAccounts.get(accountData.baseMint.toString());

        //TODO 
        if (!tokenAccount) {
            // it's possible that we didn't have time to fetch open book data
            const market = await getMinimalMarketV3(connection, accountData.marketId, COMMITMENT_LEVEL);
            tokenAccount = saveTokenAccount(accountData.baseMint, market);
        }

        tokenAccount.poolKeys = createPoolKeys(accountId, accountData, tokenAccount.market!);
        const { innerTransaction } = Liquidity.makeSwapFixedInInstruction(
            {
                poolKeys: tokenAccount.poolKeys,
                userKeys: {
                    tokenAccountIn: quoteTokenAssociatedAddress,
                    tokenAccountOut: tokenAccount.address,
                    owner: wallet.publicKey,
                },
                amountIn: quoteAmount.raw,
                minAmountOut: 0,
            },
            tokenAccount.poolKeys.version,
        );

        // https://github.com/anza-xyz/agave/pull/483
        const TX_COMMITMENT_LEVEL = 'confirmed';

        const latestBlockhashResult = await connection.getLatestBlockhashAndContext({
            commitment: TX_COMMITMENT_LEVEL,
        });
        let hash = latestBlockhashResult.value.blockhash;
        let blockheight = latestBlockhashResult.value.lastValidBlockHeight;

        //TODO tweak and comment reasoning
        const lamps = 421197;
        const sunits = 101337

        logger.info(`Preparing buy. hash ${hash} blockheight ${blockheight}`)
        const messageV0 = new TransactionMessage({
            payerKey: wallet.publicKey,
            recentBlockhash: hash,
            instructions: [
                ComputeBudgetProgram.setComputeUnitPrice({ microLamports: lamps }),
                ComputeBudgetProgram.setComputeUnitLimit({ units: sunits }),
                createAssociatedTokenAccountIdempotentInstruction(
                    wallet.publicKey,
                    tokenAccount.address,
                    wallet.publicKey,
                    accountData.baseMint,
                ),
                ...innerTransaction.instructions,
            ],
        }).compileToV0Message();
        const transaction = new VersionedTransaction(messageV0);
        transaction.sign([wallet, ...innerTransaction.signers]);
        const MAX_RETRY = 1;
        const rawTransaction = transaction.serialize();

        const signature = await connection.sendRawTransaction(rawTransaction, {
            skipPreflight: true,
            preflightCommitment: TX_COMMITMENT_LEVEL,
            maxRetries: MAX_RETRY
        });
        logger.info('Sending buy tx', { mint: accountData.baseMint, signature });

        confirmTransactionWithTimeout(connection, signature, blockheight, hash, TX_COMMITMENT_LEVEL, accountData)
            .then(() => {
                logger.info('Transaction confirmed successfully');
            })
            .catch(err => {
                logger.error('Failed to confirm transaction:', err.message);
            });

    } catch (e) {
        // Blockhash not found

        logger.error('Failed to buy token', {
            mint: accountData.baseMint
        });
        if (e instanceof Error) {
            logger.error(e.stack);
        } else {
            logger.error('An error occurred:', e);
        }
    }
}

export async function sell(accountId: PublicKey, mint: PublicKey, amount: BigNumberish, connection: Connection, wallet: any, quoteTokenAssociatedAddress: any): Promise<void> {
    let sold = false;
    let retries = 0;

    //TODO move this to bot
    // if delay call this function again with delay
    if (AUTO_SELL_DELAY > 0) {
        await new Promise((resolve) => setTimeout(resolve, AUTO_SELL_DELAY));
    }

    // try until confirmed or failed with max retries
    do {
        try {
            const tokenAccount = existingTokenAccounts.get(mint.toString());

            if (!tokenAccount) {
                logger.error('token account not found');
                return;
            }

            if (!tokenAccount.poolKeys) {
                logger.warn('No pool keys found', { mint });
                return;
            }

            if (amount === 0) {
                logger.info('Empty balance, can\'t sell', {
                    mint: tokenAccount.mint
                });
                return;
            }

            const { innerTransaction } = Liquidity.makeSwapFixedInInstruction(
                {
                    poolKeys: tokenAccount.poolKeys!,
                    userKeys: {
                        tokenAccountOut: quoteTokenAssociatedAddress,
                        tokenAccountIn: tokenAccount.address,
                        owner: wallet.publicKey,
                    },
                    amountIn: amount,
                    minAmountOut: 0,
                },
                tokenAccount.poolKeys!.version,
            );

            const latestBlockhash = await connection.getLatestBlockhash({
                commitment: COMMITMENT_LEVEL,
            });
            const messageV0 = new TransactionMessage({
                payerKey: wallet.publicKey,
                recentBlockhash: latestBlockhash.blockhash,
                instructions: [
                    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 421197 }),
                    ComputeBudgetProgram.setComputeUnitLimit({ units: 101337 }),
                    ...innerTransaction.instructions,
                    createCloseAccountInstruction(tokenAccount.address, wallet.publicKey, wallet.publicKey),
                ],
            }).compileToV0Message();
            const transaction = new VersionedTransaction(messageV0);
            transaction.sign([wallet, ...innerTransaction.signers]);
            const signature = await connection.sendRawTransaction(transaction.serialize(), {
                preflightCommitment: COMMITMENT_LEVEL,
            });
            logger.info('Sent sell tx', { mint, signature });
            const confirmation = await connection.confirmTransaction(
                {
                    signature,
                    lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
                    blockhash: latestBlockhash.blockhash,
                },
                COMMITMENT_LEVEL,
            );
            if (confirmation.value.err) {
                logger.debug(confirmation.value.err);
                logger.info('Error confirming buy tx', { mint, signature });
                continue;
            }

            logger.info('Confirmed sell tx', {
                dex: `https://dexscreener.com/solana/${mint}?maker=${wallet.publicKey}`,
                mint,
                signature,
                url: `https://solscan.io/tx/${signature}?cluster=${NETWORK}`,
            });
            sold = true;
        } catch (e: any) {
            // wait for a bit before retrying
            await new Promise((resolve) => setTimeout(resolve, 100));
            retries++;
            logger.error(`Failed to sell token, retry: ${retries}/${MAX_SELL_RETRIES}`, { mint });
            logger.error(e);
        }
    } while (!sold && retries < MAX_SELL_RETRIES);
}
