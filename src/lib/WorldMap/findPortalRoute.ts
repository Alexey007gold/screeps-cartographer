import { findRouteWithPortals } from './findRoute';

export function findPortalRoute(
  fromRoom: string,
  toRooms: string[],
  routeCallback?: (roomName: string, fromRoomName: string) => number,
  avoidPortals?: boolean,
  maxCost?: number,
  maxRange?: number
): string[][] | ERR_NO_PATH | ERR_NOT_IN_RANGE {
  const route = findRouteWithPortals(fromRoom, toRooms, { routeCallback, maxCost, maxRange }, avoidPortals);
  if (route === ERR_NO_PATH || route === ERR_NOT_IN_RANGE) return route;
  return route.map(segment => segment.map(step => step.room));
}
