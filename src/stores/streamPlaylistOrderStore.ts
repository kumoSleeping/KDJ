import { create } from "zustand";
import { STREAM_PLAYLIST_ORDERS, type StreamPlaylistOrder } from "../lib/streamPlaylistOrder";
import { readLocalStorage, writeLocalStorageNow } from "../lib/storageWrite";
import { STREAM_BROWSE_PLATFORMS, type StreamBrowsePlatform } from "./streamBrowseStore";

const STORAGE_KEY = "kd-stream-playlist-order-v1";

type Orders = Partial<Record<StreamBrowsePlatform, StreamPlaylistOrder>>;

function readOrders(): Orders {
  try {
    const value: unknown = JSON.parse(readLocalStorage(STORAGE_KEY) ?? "{}");
    if (!value || typeof value !== "object") return {};
    const orders: Orders = {};
    for (const platform of STREAM_BROWSE_PLATFORMS) {
      const order = (value as Record<string, unknown>)[platform];
      if (STREAM_PLAYLIST_ORDERS.some((item) => item.id === order)) {
        orders[platform] = order as StreamPlaylistOrder;
      }
    }
    return orders;
  } catch {
    return {};
  }
}

interface StreamPlaylistOrderState {
  /** Per platform; one that has none is ordered by `recent`. */
  orders: Orders;
  setOrder(platforms: readonly StreamBrowsePlatform[], order: StreamPlaylistOrder): void;
}

/** How each platform's playlists are ordered in the sidebar, chosen on its root's menu. */
export const useStreamPlaylistOrderStore = create<StreamPlaylistOrderState>((set) => ({
  orders: readOrders(),
  setOrder(platforms, order) {
    set((state) => {
      const orders = { ...state.orders };
      for (const platform of platforms) orders[platform] = order;
      writeLocalStorageNow(STORAGE_KEY, JSON.stringify(orders));
      return { orders };
    });
  },
}));
