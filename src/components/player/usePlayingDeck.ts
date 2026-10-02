import { useEffect, useMemo, useState } from "react";
import { managerControlView, reconcileManagerControlView, sameManagerControlView } from "../../lib/managerControlView";
import { runtimePlayer, type UnifiedPlayerState } from "../../lib/unifiedPlayer";

/** Bind playback tools to their track, never to the library selection. */
export function usePlayingDeck(trackId: number) {
  const player = useMemo(() => runtimePlayer(), []);
  const [state, setState] = useState(() => managerControlView(player.state(), trackId));
  useEffect(() => {
    const sync = (next: UnifiedPlayerState) => setState(current => {
      const selected = reconcileManagerControlView(current, next, trackId);
      return sameManagerControlView(current, selected) ? current : selected;
    });
    sync(player.state());
    return player.subscribe(sync);
  }, [player, trackId]);
  return {
    player,
    control: state.owner === trackId ? state : managerControlView(player.state(), trackId),
  };
}
