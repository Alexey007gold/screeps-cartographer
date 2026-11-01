import { CoordMap } from 'lib/Utils/CoordMap';
import { linkPortalSet, markHydrated, unlinkPortalSet } from './portals';

export interface PortalTilePair {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export function feedPortalLink(room1: string, room2: string, expires: number | undefined, tiles: PortalTilePair[]) {
  markHydrated();
  const portalMap = new CoordMap();
  for (const tile of tiles) {
    portalMap.set({ x: tile.x1, y: tile.y1 }, { x: tile.x2, y: tile.y2 });
  }
  linkPortalSet({ room1, room2, expires, portalMap });
}

export function removePortalLink(room1: string, room2: string) {
  markHydrated();
  unlinkPortalSet(room1, room2);
}
