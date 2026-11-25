export interface PostinoPublishDto<T> {
  channel: string;
  payload: T;
}

/** Wire format of every message published on Redis. */
export interface PostinoMessage<T> {
  id: string; // unique id (crypto.randomUUID)
  data: T;
}

export interface PostinoPublishResult {
  success: boolean;
  error?: string;
}
