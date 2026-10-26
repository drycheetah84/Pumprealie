import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from './api';

export function usePoll<T>(path: string | null, intervalMs = 5000): { data: T | null; error: string | null; loading: boolean; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  useEffect(() => {
    if (!path) return;
    let alive = true;
    const run = async () => {
      try {
        const d = await api.get<T>(path);
        if (alive) {
          setData(d);
          setError(null);
        }
      } catch (e) {
        if (alive) setError(e instanceof ApiError ? `${e.message}${e.correlationId ? ` (ref ${e.correlationId.slice(0, 8)})` : ''}` : String(e));
      } finally {
        if (alive) setLoading(false);
      }
    };
    void run();
    const id = intervalMs > 0 ? setInterval(run, intervalMs) : null;
    return () => {
      alive = false;
      if (id) clearInterval(id);
    };
  }, [path, intervalMs, tick]);
  return { data, error, loading, reload };
}

export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | null> => {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, run, setError };
}

export function useInterval(fn: () => void, ms: number) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    const id = setInterval(() => ref.current(), ms);
    return () => clearInterval(id);
  }, [ms]);
}

export function useHashRoute(): [string, (r: string) => void] {
  const [route, setRoute] = useState(() => location.hash.slice(1) || '/overview');
  useEffect(() => {
    const f = () => setRoute(location.hash.slice(1) || '/overview');
    window.addEventListener('hashchange', f);
    return () => window.removeEventListener('hashchange', f);
  }, []);
  return [route, (r: string) => (location.hash = r)];
}
