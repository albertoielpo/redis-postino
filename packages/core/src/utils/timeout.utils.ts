export async function runWithTimeout<T>(func: () => Promise<T>, timeoutInMs: number): Promise<T | 'TIMEOUT' | 'ERROR'> {
  let savedTimeout: NodeJS.Timeout | null = null;

  const timeout = new Promise<'TIMEOUT'>((res) => {
    savedTimeout = setTimeout(() => res('TIMEOUT'), timeoutInMs);
  });

  const callback = async (): Promise<T | 'ERROR'> =>
    func()
      .catch<'ERROR'>(() => 'ERROR')
      .finally(() => {
        if (savedTimeout) {
          clearTimeout(savedTimeout);
        }
      });

  return Promise.race([callback(), timeout]);
}
