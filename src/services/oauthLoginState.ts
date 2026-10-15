import { connectionGeneration } from './connectionGeneration';
export const shouldShowOAuthLoginStatus = (status: string) => status === 'success';

export const createOAuthLoginSuccessCache = <T extends string>() => {
  const providers = new Set<T>();
  let generation = connectionGeneration();
  const sync = () => {
    if (generation !== connectionGeneration()) { providers.clear(); generation = connectionGeneration(); }
  };

  return {
    mark(provider: T) {
      sync();
      providers.add(provider);
    },
    snapshot() {
      sync();
      return Array.from(providers);
    },
  };
};
