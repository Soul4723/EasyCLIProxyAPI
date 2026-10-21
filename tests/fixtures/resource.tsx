import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useResource } from '../../src/services/useResource';

const calls: number[] = [];
const pending = new Map<number, { resolve: (value: number) => void; reject: (error: Error) => void }>();
Object.assign(window, {
  resourceFixture: {
    calls,
    resolve: (key: number, value: number) => pending.get(key)?.resolve(value),
    reject: (key: number) => pending.get(key)?.reject(new Error('offline')),
  },
});
function Query() {
  const [key, setKey] = useState(0);
  const snapshot = useResource(() => {
    calls.push(key);
    return new Promise<number>((resolve, reject) => pending.set(key, { resolve, reject }));
  }, [key]);
  return <>
    <button type="button" onClick={() => setKey(n => n + 1)}>Next query</button>
    <button type="button" onClick={() => void snapshot.source.refresh()}>Refresh query</button>
    <output data-testid="data">{snapshot.data ?? 'none'}</output>
    <output data-testid="error">{snapshot.error ?? 'none'}</output>
    <output data-testid="refreshing">{String(snapshot.refreshing)}</output>
    <output data-testid="loading">{String(snapshot.loading)}</output>
  </>;
}
function Harness() {
  const [mounted, setMounted] = useState(true);
  return <><button type="button" onClick={() => setMounted(false)}>Unmount</button>{mounted && <Query />}</>;
}
createRoot(document.getElementById('root')!).render(<StrictMode><Harness /></StrictMode>);
