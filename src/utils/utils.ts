import { Logger } from 'pino';
import dotenv from 'dotenv';
import { logger } from './logger';

dotenv.config();

export const retrieveEnvVariable = (variableName: string) => {
  const variable = process.env[variableName] || '';
  if (!variable) {
    logger.error(`${variableName} is not set`);
    process.exit(1);
  }
  return variable;
};
