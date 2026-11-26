import type { PostinoOptionsInput } from '../../src/index.js';

/** Queue options required by `resolveOptions` (no default for `enable`). Both queues enabled. */
export const QUEUES = {
  deadLetterQueue: { enable: true },
  errorQueue: { enable: true },
} satisfies Pick<PostinoOptionsInput, 'deadLetterQueue' | 'errorQueue'>;

/** Builds valid options from a partial input (queues enabled unless overridden). */
export const withQueues = (input: Partial<PostinoOptionsInput> = {}): PostinoOptionsInput => ({ ...QUEUES, ...input });
