import {
  LiquidityPoolKeys,
  LiquidityStateV4,
  MARKET_STATE_LAYOUT_V3,
  MarketStateV3,
  Token,
  TokenAmount,
} from '@raydium-io/raydium-sdk';
import {
  AccountLayout,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import {
  Keypair,
  Connection,
  PublicKey,
  KeyedAccountInfo,
} from '@solana/web3.js';
import { getTokenAccounts } from './liquidity';
import { logger } from './utils/logger';
import { MinimalMarketLayoutV3 } from './market';
import bs58 from 'bs58';
import * as fs from 'fs';
import * as path from 'path';
import {
  AUTO_SELL,
  AUTO_SELL_DELAY,
  CHECK_IF_MINT_IS_RENOUNCED,
  COMMITMENT_LEVEL,
  LOG_LEVEL,
  PRIVATE_KEY,
  QUOTE_AMOUNT,
  QUOTE_MINT,
  RPC_ENDPOINT,
  RPC_WEBSOCKET_ENDPOINT,
  SNIPE_LIST_REFRESH_INTERVAL,
  USE_SNIPE_LIST,
  MIN_POOL_SIZE,
  PAPER_TRADE,
} from './constants';

import { listenPools, listenOpenbook } from './raydium'
import { getTokenBalanceQuote, checkMintable, getWalletSOLBalance } from './checks'
import { buy, sell } from './transact'

const connection = new Connection(RPC_ENDPOINT, {
  wsEndpoint: RPC_WEBSOCKET_ENDPOINT,
});

export interface MinimalTokenAccountData {
  mint: PublicKey;
  address: PublicKey;
  poolKeys?: LiquidityPoolKeys;
  market?: MinimalMarketLayoutV3;
}

export const existingTokenAccounts: Map<string, MinimalTokenAccountData> = new Map<string, MinimalTokenAccountData>();

// variables
let wallet: Keypair;
export let quoteToken: Token;
let quoteTokenAssociatedAddress: PublicKey;
let quoteAmount: TokenAmount;
let quoteMinPoolSizeAmount: TokenAmount;

let snipeList: string[] = [];


async function init(): Promise<void> {
  logger.level = LOG_LEVEL;

  // get wallet
  wallet = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
  logger.info(`Wallet Address: ${wallet.publicKey}`);

  // get wallet balance for QUOTE_MINT token
  const wsol_balance = await getTokenBalanceQuote(wallet.publicKey, 'WSOL', connection);
  logger.info(`Wallet WSOL Balance: ${wsol_balance}`);

  const sol_balance = await getWalletSOLBalance(connection, wallet);
  logger.info(`Wallet SOL balance: ${sol_balance}`);

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
  const tokenAccounts = await getTokenAccounts(connection, wallet.publicKey, COMMITMENT_LEVEL);

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

export function saveTokenAccount(mint: PublicKey, accountData: MinimalMarketLayoutV3) {
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

  const poolOpenTime = parseInt(poolState.poolOpenTime.toString());
  const currentDate = new Date();
  const t = currentDate.getTime() / 1000;
  const delta_seconds = (t - poolOpenTime);

  const MAX_AGE = 120;
  if (delta_seconds > MAX_AGE) {
    logger.warn(`pool already launched ${MAX_AGE} ago`)
    return;
  }

  if (!shouldBuy(poolState.baseMint.toString())) {
    return;
  }

  if (!quoteMinPoolSizeAmount.isZero()) {
    const poolSize = new TokenAmount(quoteToken, poolState.swapQuoteInAmount, true);
    logger.info(`Processing pool: ${id.toString()} with ${poolSize.toFixed(2)} ${quoteToken.symbol} in liquidity`);
    // logger.info(`state ${poolState.state}`);
    // logger.info(`status ${poolState.status}`);

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
    const mintOption = await checkMintable(poolState.baseMint, connection);

    if (mintOption !== true) {
      logger.warn('Skipping, owner can mint tokens!', {
        mint: poolState.baseMint
      });
      return;
    }
  }
  logger.info(PAPER_TRADE);
  logger.info(typeof (PAPER_TRADE));
  if (PAPER_TRADE == 'true') {
    logger.info("PAPER_TRADE");
  } else {
    logger.info("TRADE");
    await buy(id, poolState, connection, wallet, quoteTokenAssociatedAddress, quoteAmount);
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

export const runListener = async (logger: any) => {

  logger.info('------------------- 🤖 ---------------------');
  logger.info("Openbot Solana")
  logger.info('------------------- 🤖 ---------------------');
  logger.info("Init")
  await init();
  logger.info("Start Listeners")

  const runTimestamp = Math.floor(new Date().getTime() / 1000);

  listenPools(runTimestamp, connection, processRaydiumPool);

  listenOpenbook(connection, processOpenBookMarket);


  if (AUTO_SELL) {
    // sell as soon as balance has changed
    const walletSubscriptionId = connection.onProgramAccountChange(
      TOKEN_PROGRAM_ID,
      async (updatedAccountInfo) => {
        const accountData = AccountLayout.decode(updatedAccountInfo.accountInfo!.data);

        if (updatedAccountInfo.accountId.equals(quoteTokenAssociatedAddress)) {
          return;
        }

        const _ = sell(updatedAccountInfo.accountId, accountData.mint, accountData.amount, connection, wallet, quoteTokenAssociatedAddress);
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

