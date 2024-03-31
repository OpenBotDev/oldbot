import TelegramBot from 'node-telegram-bot-api';
import { TELEGRAM_ENABLED, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } from '../constants';

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false });

export const sendTelegramMessage = async (message: string): Promise<void> => {
  if (!TELEGRAM_ENABLED) {
    // Optionally logging
    console.log('Telegram notifications are disabled.');
    return;
  }

  try {
    await bot.sendMessage(TELEGRAM_CHAT_ID, message, { parse_mode: 'HTML' });
  } catch (error) {
    console.error('Failed to send Telegram message:', error);
  }
};
