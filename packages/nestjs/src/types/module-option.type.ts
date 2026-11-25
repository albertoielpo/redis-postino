import type { ModuleMetadata } from '@nestjs/common';
import type { PostinoOptionsInput } from 'redis-postino';

export interface PostinoModuleAsyncOptions extends Pick<ModuleMetadata, 'imports' | 'providers'> {
  useFactory: (...args: any[]) => PostinoOptionsInput | Promise<PostinoOptionsInput>;
  inject?: any[];
}
