/**
 * Any logger-like object accepted by the library (NestJS Logger, pino, console, ...).
 * `info` or `log` is used for informational messages, `verbose` or `trace` for verbose ones.
 */
export interface PostinoLoggerInput {
  info?(message: any): void;
  log?(message: any): void;
  error(message: any): void;
  warn(message: any): void;
  debug(message: any): void;
  verbose?(message: any): void;
  trace?(message: any): void;
}

/** Normalized logger used internally. */
export interface PostinoLogger {
  log(message: any): void;
  error(message: any): void;
  warn(message: any): void;
  debug(message: any): void;
  verbose(message: any): void;
}
