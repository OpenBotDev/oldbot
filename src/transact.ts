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
    Keypair,
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

async function submitMaxWait(connection: Connection, transaction: any, accountData: any, latestBlockhash: any) {
    // Sending the transaction
    const signature = await connection.sendRawTransaction(transaction.serialize(), {
        preflightCommitment: COMMITMENT_LEVEL,
    });
    logger.info('Sent buy tx', { mint: accountData.baseMint, signature });

    // Timeout promise that resolves after 5 seconds
    const timeout = new Promise((resolve) => {
        setTimeout(() => {
            resolve({ timeout: true });
        }, 5000); // 5 seconds
    });

    // Promise for transaction confirmation
    const confirmationPromise = connection.confirmTransaction({
        signature,
        lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
        blockhash: latestBlockhash.blockhash,
    }, COMMITMENT_LEVEL);

    // Race the confirmation promise against the timeout
    const result: any = await Promise.race([confirmationPromise, timeout]);

    // Handling the race result
    if (result.timeout) {
        // If the timeout promise resolves first, log an error
        logger.error('Transaction confirmation timed out');
    } else if (!result.value.err) {
        // If the confirmation is received without errors
        logger.info('Confirmed buy tx', {
            mint: accountData.baseMint,
            signature: signature,
            url: `https://solscan.io/tx/${signature}?cluster=${NETWORK}`,
        });
    } else {
        // If there is an error in transaction confirmation
        logger.debug(result.value.err);
        logger.info('Error confirming buy tx', { mint: accountData.baseMint, signature });
    }

    //SendTransactionError: failed to send transaction: Transaction simulation failed: Blockhash not found
}

export async function buy(accountId: PublicKey, accountData: LiquidityStateV4, connection: Connection, wallet: any, quoteTokenAssociatedAddress: any, quoteAmount: any): Promise<void> {
    try {
        let tokenAccount = existingTokenAccounts.get(accountData.baseMint.toString());

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

        const latestBlockhash = await connection.getLatestBlockhash({
            commitment: COMMITMENT_LEVEL,
        });
        const messageV0 = new TransactionMessage({
            payerKey: wallet.publicKey,
            recentBlockhash: latestBlockhash.blockhash,
            instructions: [
                ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 421197 }),
                ComputeBudgetProgram.setComputeUnitLimit({ units: 101337 }),
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
        submitMaxWait(connection, transaction, accountData, latestBlockhash);

    } catch (e) {
        logger.debug(e);
        logger.error('Failed to buy token', {
            mint: accountData.baseMint
        });

    }
}

export async function sell(accountId: PublicKey, mint: PublicKey, amount: BigNumberish, connection: Connection, wallet: any, quoteTokenAssociatedAddress: any): Promise<void> {
    let sold = false;
    let retries = 0;

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
            logger.debug(e);
            logger.error(`Failed to sell token, retry: ${retries}/${MAX_SELL_RETRIES}`, { mint });
        }
    } while (!sold && retries < MAX_SELL_RETRIES);
}
