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
  getAssociatedTokenAddress
} from '@solana/spl-token';
import {
  Keypair,
  Connection,
  PublicKey,
  ComputeBudgetProgram,
  KeyedAccountInfo,
  TransactionMessage,
  VersionedTransaction,
  LAMPORTS_PER_SOL
} from '@solana/web3.js';
import { getTokenAccounts, RAYDIUM_LIQUIDITY_PROGRAM_ID_V4, OPENBOOK_PROGRAM_ID, createPoolKeys } from './liquidity';
import { logger } from './utils/logger';
import { getMinimalMarketV3, MinimalMarketLayoutV3 } from './market';
import { MintLayout } from './types';
import bs58 from 'bs58';
import * as fs from 'fs';
import * as path from 'path';
import {
  AUTO_SELL,
  AUTO_SELL_DELAY,
  CHECK_IF_MINT_IS_RENOUNCED,
  COMMITMENT_LEVEL,
  LOG_LEVEL,
  MAX_SELL_RETRIES,
  NETWORK,
  PRIVATE_KEY,
  QUOTE_AMOUNT,
  QUOTE_MINT,
  RPC_ENDPOINT,
  RPC_WEBSOCKET_ENDPOINT,
  SNIPE_LIST_REFRESH_INTERVAL,
  USE_SNIPE_LIST,
  MIN_POOL_SIZE,
  PAPER_TRADE,
  USDC_ADDRESS,
  WSOL_ADDRESS
} from './constants';

import { listenPools, listenOpenbook } from './raydium'

const solanaConnection = new Connection(RPC_ENDPOINT, {
  wsEndpoint: RPC_WEBSOCKET_ENDPOINT,
});

export interface MinimalTokenAccountData {
  mint: PublicKey;
  address: PublicKey;
  poolKeys?: LiquidityPoolKeys;
  market?: MinimalMarketLayoutV3;
}

const existingTokenAccounts: Map<string, MinimalTokenAccountData> = new Map<string, MinimalTokenAccountData>();

// variables
let wallet: Keypair;
export let quoteToken: Token;
let quoteTokenAssociatedAddress: PublicKey;
let quoteAmount: TokenAmount;
let quoteMinPoolSizeAmount: TokenAmount;

let snipeList: string[] = [];


async function getTokenBalance(walletPublicKey: PublicKey, mintAddress: string): Promise<number | null> {
  const walletPubKey = new PublicKey(walletPublicKey);
  const tokenMintPubKey = new PublicKey(mintAddress);

  const associatedTokenAddress = await getAssociatedTokenAddress(tokenMintPubKey, walletPubKey);

  try {
    // Query the balance
    const balanceResult = await solanaConnection.getTokenAccountBalance(associatedTokenAddress);
    return balanceResult.value.uiAmount;
  } catch (error) {
    console.error(`Could not fetch balance for account ${associatedTokenAddress.toString()}: ${error}`);
    return null;
  }
}

async function getTokenBalanceQuote(walletPublicKey: PublicKey, QUOTE_MINT: string): Promise<number | null> {
  let mintAddress = undefined;
  if (QUOTE_MINT === 'WSOL') {
    mintAddress = WSOL_ADDRESS;
  }
  if (QUOTE_MINT === 'USDC') {
    mintAddress = USDC_ADDRESS;
  }
  if (!mintAddress) return null;

  return getTokenBalance(walletPublicKey, mintAddress);

}

async function getWalletSOLBalance(connection: any) {
  try {
    const balance = await connection.getBalance(wallet.publicKey) / LAMPORTS_PER_SOL;
    return balance;

  } catch (error) {
    logger.error('Error getting wallet balance: ' + error);
  }
};


async function init(): Promise<void> {
  logger.level = LOG_LEVEL;

  // get wallet
  wallet = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
  logger.info(`Wallet Address: ${wallet.publicKey}`);

  // get wallet balance for QUOTE_MINT token
  const wsol_balance = await getTokenBalanceQuote(wallet.publicKey, 'WSOL');
  logger.info(`Wallet WSOL Balance: ${wsol_balance}`);

  const sol_balance = await getWalletSOLBalance(solanaConnection);
  logger.info(`Wallet balance: ${sol_balance}`);

  // get quote mint and amount
  switch (QUOTE_MINT) {
    case 'WSOL': {
      quoteToken = Token.WSOL;
      quoteAmount = new TokenAmount(Token.WSOL, QUOTE_AMOUNT, false);
      quoteMinPoolSizeAmount = new TokenAmount(quoteToken, MIN_POOL_SIZE, false);
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
      quoteMinPoolSizeAmount = new TokenAmount(quoteToken, MIN_POOL_SIZE, false);
      break;
    }
    default: {
      throw new Error(`Unsupported quote mint "${QUOTE_MINT}". Supported values are USDC and WSOL`);
    }
  }

  logger.info(`Snipe list: ${USE_SNIPE_LIST}`);
  logger.info(`Paper trade: ${PAPER_TRADE}`);
  logger.info(`Check mint renounced: ${CHECK_IF_MINT_IS_RENOUNCED}`);
  logger.info(
    `Min pool size: ${quoteMinPoolSizeAmount.isZero() ? 'false' : quoteMinPoolSizeAmount.toFixed()} ${quoteToken.symbol}`,
  );
  logger.info(`Buy amount: ${quoteAmount.toFixed()} ${quoteToken.symbol}`);
  logger.info(`Auto sell: ${AUTO_SELL}`);
  logger.info(`Sell delay: ${AUTO_SELL_DELAY === 0 ? 'false' : AUTO_SELL_DELAY}`);


  // check existing wallet for associated token account of quote mint
  const tokenAccounts = await getTokenAccounts(solanaConnection, wallet.publicKey, COMMITMENT_LEVEL);

  for (const ta of tokenAccounts) {
    existingTokenAccounts.set(ta.accountInfo.mint.toString(), <MinimalTokenAccountData>{
      mint: ta.accountInfo.mint,
      address: ta.pubkey,
    });
  }

  const tokenAccount = tokenAccounts.find((acc) => acc.accountInfo.mint.toString() === quoteToken.mint.toString())!;

  if (!tokenAccount) {
    logger.error('token accounts ' + tokenAccounts.length);
    for (const ta of tokenAccounts) {
      logger.error(ta);
    }
    throw new Error(`No ${quoteToken.symbol} token account found in wallet: ${wallet.publicKey}`);
  }

  quoteTokenAssociatedAddress = tokenAccount.pubkey;

  // load tokens to snipe
  loadSnipeList();
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

  if (!shouldBuy(poolState.baseMint.toString())) {
    return;
  }

  if (!quoteMinPoolSizeAmount.isZero()) {
    const poolSize = new TokenAmount(quoteToken, poolState.swapQuoteInAmount, true);
    logger.info(`Processing pool: ${id.toString()} with ${poolSize.toFixed(2)} ${quoteToken.symbol} in liquidity`);
    logger.info(`state ${poolState.state}`);
    logger.info(`status ${poolState.status}`);

    if (poolSize.lt(quoteMinPoolSizeAmount)) {
      logger.warn(`Skipping pool, smaller than ${quoteMinPoolSizeAmount.toFixed()} ${quoteToken.symbol}`, {
        mint: poolState.baseMint,
        pooled: `${poolSize.toFixed()} ${quoteToken.symbol}`,
        swapQuoteInAmount: poolSize.toFixed(),
      });
      return;
    }
  }

  if (CHECK_IF_MINT_IS_RENOUNCED) {
    const mintOption = await checkMintable(poolState.baseMint);

    if (mintOption !== true) {
      logger.warn('Skipping, owner can mint tokens!', {
        mint: poolState.baseMint
      });
      return;
    }
  }

  if (!PAPER_TRADE) {
    await buy(id, poolState);
  } else {
    logger.info('PAPER BUY ' + id);
  }
}

export async function checkMintable(vault: PublicKey): Promise<boolean | undefined> {
  try {
    let { data } = (await solanaConnection.getAccountInfo(vault)) || {};
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
    logger.debug(e);
    logger.error('Failed to process market', { mint: accountData?.baseMint });
  }
}

async function buy(accountId: PublicKey, accountData: LiquidityStateV4): Promise<void> {
  try {
    let tokenAccount = existingTokenAccounts.get(accountData.baseMint.toString());

    if (!tokenAccount) {
      // it's possible that we didn't have time to fetch open book data
      const market = await getMinimalMarketV3(solanaConnection, accountData.marketId, COMMITMENT_LEVEL);
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

    const latestBlockhash = await solanaConnection.getLatestBlockhash({
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
    const signature = await solanaConnection.sendRawTransaction(transaction.serialize(), {
      preflightCommitment: COMMITMENT_LEVEL,
    });
    logger.info('Sent buy tx', { mint: accountData.baseMint, signature });
    const confirmation = await solanaConnection.confirmTransaction(
      {
        signature,
        lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
        blockhash: latestBlockhash.blockhash,
      },
      COMMITMENT_LEVEL,
    );
    if (!confirmation.value.err) {
      logger.info('Confirmed buy tx', {
        mint: accountData.baseMint,
        signature: signature,
        url: `https://solscan.io/tx/${signature}?cluster=${NETWORK}`,
      });
    } else {
      logger.debug(confirmation.value.err);
      logger.info('Error confirming buy tx', { mint: accountData.baseMint, signature });
    }
  } catch (e) {
    logger.debug(e);
    logger.error('Failed to buy token', {
      mint: accountData.baseMint
    });

  }
}

async function sell(accountId: PublicKey, mint: PublicKey, amount: BigNumberish): Promise<void> {
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

      const latestBlockhash = await solanaConnection.getLatestBlockhash({
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
      const signature = await solanaConnection.sendRawTransaction(transaction.serialize(), {
        preflightCommitment: COMMITMENT_LEVEL,
      });
      logger.info('Sent sell tx', { mint, signature });
      const confirmation = await solanaConnection.confirmTransaction(
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

function loadSnipeList() {
  if (!USE_SNIPE_LIST) {
    return;
  }

  const count = snipeList.length;
  const data = fs.readFileSync(path.join(__dirname, 'snipe-list.txt'), 'utf-8');
  snipeList = data
    .split('\n')
    .map((a) => a.trim())
    .filter((a) => a);

  if (snipeList.length != count) {
    logger.info(`Loaded snipe list: ${snipeList.length}`);
  }
}

function shouldBuy(key: string): boolean {
  return USE_SNIPE_LIST ? snipeList.includes(key) : true;
}

const runListener = async () => {
  logger.info('------------------- 🤖 ---------------------');
  logger.info("Openbot Solana")
  logger.info('------------------- 🤖 ---------------------');
  logger.info("Init")
  await init();
  logger.info("Start Listeners")

  const runTimestamp = Math.floor(new Date().getTime() / 1000);

  listenPools(runTimestamp, solanaConnection, processRaydiumPool);

  listenOpenbook(solanaConnection, processOpenBookMarket);


  if (AUTO_SELL) {
    // sell as soon as balance has changed
    const walletSubscriptionId = solanaConnection.onProgramAccountChange(
      TOKEN_PROGRAM_ID,
      async (updatedAccountInfo) => {
        const accountData = AccountLayout.decode(updatedAccountInfo.accountInfo!.data);

        if (updatedAccountInfo.accountId.equals(quoteTokenAssociatedAddress)) {
          return;
        }

        const _ = sell(updatedAccountInfo.accountId, accountData.mint, accountData.amount);
      },
      COMMITMENT_LEVEL,
      [
        {
          dataSize: 165,
        },
        {
          memcmp: {
            offset: 32,
            bytes: wallet.publicKey.toBase58(),
          },
        },
      ],
    );

    logger.info(`Listening for wallet changes (Subscription ID ${walletSubscriptionId})`);
  }

  if (USE_SNIPE_LIST) {
    logger.info('Use snipe list');
    setInterval(loadSnipeList, SNIPE_LIST_REFRESH_INTERVAL);
  }
};

runListener();

