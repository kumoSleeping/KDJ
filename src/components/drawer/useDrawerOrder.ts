import { useRef } from "react";

/**
 * Keeps the order in which the drawer's apps were asked for. The last one is the one shown.
 * `raised` names an app that was asked for again while already open.
 */
export function useDrawerOrder(ids: readonly string[], raised: { id: string | null; token: number }): string[] {
  const order = useRef<string[]>([]);
  const seen = useRef(raised.token);
  let next = [...order.current.filter(id => ids.includes(id)), ...ids.filter(id => !order.current.includes(id))];
  if (seen.current !== raised.token) {
    seen.current = raised.token;
    if (raised.id && next.includes(raised.id)) next = [...next.filter(id => id !== raised.id), raised.id];
  }
  if (next.length !== order.current.length || next.some((id, index) => id !== order.current[index])) order.current = next;
  return order.current;
}
