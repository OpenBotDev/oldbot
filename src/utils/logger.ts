import * as winston from 'winston';
import * as fs from 'fs';
import * as path from 'path';
var express = require("express");
var app = express();
var http = require("http");
import { server } from '../server';

// Define custom TypeScript types for log metadata
interface LogMetadata {
  [key: string]: any;
}

// Authorization callback for WebSocket connections
var authCallback = function (req: any, callback: any) {
  // Implement your authentication logic here
  // For demonstration purposes, we'll allow all connections
  callback(true); // First argument is a boolean indicating success
};

function extractStackInfo(stack: string | undefined): string {
  if (stack) {
    // Split the stack trace string into lines, and find the first line after the one containing this function's name
    const stackLines = stack.split('\n');
    const relevantLine = stackLines.find(line => line.includes('__filename'));
    if (relevantLine) {
      // Extract the file path and line number using a regular expression
      const match = /at\s+(.*):(\d+):(\d+)/.exec(relevantLine);
      if (match) {
        return ` (file: ${match[1]}, line: ${match[2]})`;
      }
    }
  }
  return '';
}

const customWinstonFormat = winston.format.printf(({ level, message, timestamp, stack, ...metadata }) => {
  let msg = `${timestamp} [${level}]: ${message}`;
  // Append stack info if it's an error
  if (stack) {
    msg += ` ${extractStackInfo(stack)}`;
  }
  if (Object.keys(metadata).length !== 0) {
    msg += ` ${JSON.stringify(metadata)}`;
  }
  return msg;
});
// Creating a custom log format that excludes certain fields
const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }), // Shorter timestamp format
  winston.format((info: any) => {
    delete info.pid;
    delete info.hostname;
    // Adjust the deletion of 'level' based on the transport requirements
    return info;
  })(),
  customWinstonFormat
);

// Ensure the logs directory exists
const logsDir = './logs';
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir);
}

// Create the Winston logger with TypeScript types
export const logger: winston.Logger = winston.createLogger({
  level: 'trace',
  format: logFormat,
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        logFormat
      ),
    }),
    new winston.transports.File({ filename: path.join(logsDir, 'bot.log') }),

  ],
});

// Example usage
logger.info('This is an info level message', { additional: 'data' });

logger.info("Hello world!");
