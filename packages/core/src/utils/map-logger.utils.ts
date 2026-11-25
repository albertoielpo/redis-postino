import type { PostinoLogger, PostinoLoggerInput } from '../types/logger.type.js';

function getLogFunction(logger: PostinoLoggerInput) {
  if (typeof logger.info === 'function') {
    return (x: any) => {
      if (logger.info) {
        logger.info(x);
      }
    };
  }

  if (typeof logger.log === 'function') {
    return (x: any) => {
      if (logger.log) {
        logger.log(x);
      }
    };
  }

  return (x: any) => {
    // eslint-disable-next-line no-console
    console.log(x);
  };
}

function getVerboseFunction(logger: PostinoLoggerInput) {
  if (typeof logger.verbose === 'function') {
    return (x: any) => {
      if (logger.verbose) {
        logger.verbose(x);
      }
    };
  }

  if (typeof logger.trace === 'function') {
    return (x: any) => {
      if (logger.trace) {
        logger.trace(x);
      }
    };
  }

  return (x: any) => {
    // eslint-disable-next-line no-console
    console.log(x);
  };
}

export function mapLogger(logger: PostinoLoggerInput): PostinoLogger {
  return {
    log: getLogFunction(logger),
    debug: (x: any) => logger.debug(x),
    error: (x: any) => logger.error(x),
    verbose: getVerboseFunction(logger),
    warn: (x: any) => logger.warn(x),
  };
}
