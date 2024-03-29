import pino from "pino";

// const transport = pino.transport({
//   target: 'pino-pretty',
// });

// export const logger = pino(
//   {
//     level: 'info',
//     redact: ['poolKeys'],
//     serializers: {
//       error: pino.stdSerializers.err,
//     },
//     base: undefined,
//   },
//   transport,
// );


const transport = pino.transport({
  targets: [
    {
      level: 'trace',
      target: 'pino/file',
      options: {
        destination: 'bot.log',
        // customPrettifiers: {
        // },
        ignore: 'pid,hostname,level',
      },
    },
    {
      level: 'trace',
      target: 'pino-pretty',
      options: {
        ignore: 'pid,hostname',
      },
    },
  ],
});

export const logger = pino(transport);


// const customPrettifier = (log: any) => {
//   const { level, time, pid, hostname, ...rest } = JSON.parse(log);
//   return `${new Date(time).toISOString()} ${JSON.stringify(rest)}`;
// };
