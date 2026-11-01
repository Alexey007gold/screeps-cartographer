import { memoize, memoizeByTick } from 'lib/Utils/memoize';
import { roomNameToCoords } from 'utils/packPositions';
import { MoveOpts } from '../';
import { config } from '../../config';
import { PortalSet, describeExitsWithPortals, getPortalSetsVersion, portalSets } from './portals';
import { isHighway, isSourceKeeperRoom } from './selectors';

/**
 * Uses findRoute to create a base route, then enhances
 * it by adding rooms (up to maxRooms) to improve pathfinding
 */
export function findRoute(
  room1: string,
  targetRooms: string[],
  opts?: MoveOpts
): { rooms: string[]; portalSet?: PortalSet }[] | undefined {
  const actualOpts = {
    ...config.DEFAULT_MOVE_OPTS,
    ...opts
  };
  // prepare routeCallback
  const memoizedRouteCallback = memoize(
    (roomName, fromRoomName) => roomName + fromRoomName,
    (roomName: string, fromRoomName: string): number | undefined => {
      const result = actualOpts.routeCallback?.(roomName, fromRoomName);
      if (result !== undefined) return result;
      if (isHighway(roomName)) return actualOpts.highwayRoomCost;
      if (isSourceKeeperRoom(roomName)) return actualOpts.sourceKeeperRoomCost;
      return actualOpts.defaultRoomCost;
    }
  );

  // Generate base route, taking portals into account
  const generatedRoutes = findRouteWithPortals(
    room1,
    targetRooms,
    {
      routeCallback: memoizedRouteCallback
    },
    actualOpts.avoidPortals
  );
  if (generatedRoutes === ERR_NO_PATH || generatedRoutes === ERR_NOT_IN_RANGE) return undefined;

  // enhance the route with extra rooms to improve pathfinding
  return generatedRoutes.map(route => {
    const rooms = enhanceRoute(route, memoizedRouteCallback, actualOpts);
    return {
      rooms,
      portalSet: route[route.length - 1]?.portalSet
    };
  });
}

/**
 * Adds extra rooms to a given route to improve pathfinding (e.g. routing through
 * an inside corner when the route turns)
 */
function enhanceRoute(
  route: { exit?: ExitConstant; room: string }[],
  memoizedRouteCallback: (room: string, fromRoom: string) => number | undefined,
  actualOpts: MoveOpts
) {
  let rooms = new Set(route.map(({ room }) => room));
  let blockedRooms = new Set<string>();
  const maxRooms = actualOpts.maxRooms!;
  for (let i = 0; i < route.length - 1; i++) {
    // check if we've met our limit
    if (rooms.size >= maxRooms) break;
    if (!route[i].exit) break;

    // check for areas PathFinder might be able to optimize

    // Route turns a corner: add the room inside the corner
    if (route[i].exit !== route[i + 1].exit) {
      const detour = Game.map.describeExits(route[i].room)[route[i + 1].exit!];

      if (
        detour &&
        Game.map.findExit(detour, route[i + 1].room) > 0 &&
        memoizedRouteCallback(detour, route[i].room) !== Infinity
      ) {
        // detour room is connected
        rooms.add(detour);
      }
    }

    // Route is straight, but exit tiles are all to one side of the border
    // Might be faster to detour through neighboring rooms
    if (
      (route[i].exit === route[i + 1].exit || !route[i + 1].exit) &&
      (!route[i + 2]?.exit || route[i].exit === route[i + 2].exit)
    ) {
      if (rooms.size >= actualOpts.maxRooms! - 1) continue; // detour will take two rooms, ignore
      // Straight line for the next three rooms (or until route ends)
      // Check if there are exit tiles on both halves of the border
      const regions = exitTileRegions(route[i].room, route[i].exit!);
      if (regions.every(r => r)) {
        continue;
      }
      // one half does not have an exit tile.
      let detour: ExitConstant | undefined = undefined;
      if (!regions[0] && (route[i].exit === FIND_EXIT_TOP || route[i].exit === FIND_EXIT_BOTTOM)) {
        detour = FIND_EXIT_LEFT;
      } else if (!regions[1] && (route[i].exit === FIND_EXIT_TOP || route[i].exit === FIND_EXIT_BOTTOM)) {
        detour = FIND_EXIT_RIGHT;
      } else if (!regions[0] && (route[i].exit === FIND_EXIT_LEFT || route[i].exit === FIND_EXIT_RIGHT)) {
        detour = FIND_EXIT_TOP;
      } else if (!regions[1] && (route[i].exit === FIND_EXIT_LEFT || route[i].exit === FIND_EXIT_RIGHT)) {
        detour = FIND_EXIT_BOTTOM;
      }
      if (!detour) throw new Error('Invalid exit tile state: ' + route[i].exit + JSON.stringify(regions));

      // check detour rooms for continuity
      const detour1 = Game.map.describeExits(route[i].room)[detour];
      const detour2 = Game.map.describeExits(route[i + 1].room)[detour];
      if (
        detour1 &&
        detour2 &&
        Game.map.findExit(detour1, detour2) > 0 &&
        memoizedRouteCallback(detour1, route[i].room) !== Infinity &&
        memoizedRouteCallback(detour2, route[i + 1].room) !== Infinity
      ) {
        // detour rooms are connected
        rooms.add(detour1);
        rooms.add(detour2);
      }
    }
  }
  // now floodfill adjoining rooms, up to maxRooms
  const frontier = [...rooms];
  while (rooms.size < maxRooms) {
    const room = frontier.shift();
    if (!room) break;
    const exits = Game.map.describeExits(room);
    if (!exits) continue;
    for (const adjacentRoom of Object.values(exits)) {
      if (rooms.has(adjacentRoom)) continue;
      if (memoizedRouteCallback(adjacentRoom, room) !== Infinity) {
        rooms.add(adjacentRoom);
        frontier.push(adjacentRoom);
      }
    }
  }
  return [...rooms];
}

function exitTileRegions(room: string, exit: ExitConstant): [boolean, boolean] {
  const terrain = Game.map.getRoomTerrain(room);
  let region1 = false;
  for (let i = 0; i < 25; i++) {
    const { x, y } = exitTileByIndex(exit, i);
    if (terrain.get(x, y) !== TERRAIN_MASK_WALL) {
      region1 = true;
      break;
    }
  }
  let region2 = false;
  for (let i = 25; i < 49; i++) {
    const { x, y } = exitTileByIndex(exit, i);
    if (terrain.get(x, y) !== TERRAIN_MASK_WALL) {
      region2 = true;
      break;
    }
  }
  return [region1, region2];
}

function exitTileByIndex(exit: ExitConstant, index: number) {
  if (exit === FIND_EXIT_TOP) return { x: index, y: 0 };
  if (exit === FIND_EXIT_BOTTOM) return { x: index, y: 49 };
  if (exit === FIND_EXIT_LEFT) return { x: 0, y: index };
  return { x: 49, y: index }; // FIND_EXIT_RIGHT
}

class PriorityQueue<T> {
  private heap: { priority: number; order: number; item: T }[] = [];
  private nextOrder = 0;

  put(item: T, priority: number) {
    const heap = this.heap;
    const entry = { priority, order: this.nextOrder++, item };
    let i = heap.length;
    heap.push(entry);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.before(entry, heap[parent])) break;
      heap[i] = heap[parent];
      i = parent;
    }
    heap[i] = entry;
  }

  take() {
    const heap = this.heap;
    if (heap.length === 0) return undefined;
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length > 0) {
      let i = 0;
      while (true) {
        const left = 2 * i + 1;
        if (left >= heap.length) break;
        const right = left + 1;
        const child = right < heap.length && this.before(heap[right], heap[left]) ? right : left;
        if (!this.before(heap[child], last)) break;
        heap[i] = heap[child];
        i = child;
      }
      heap[i] = last;
    }
    return top.item;
  }

  private before(a: { priority: number; order: number }, b: { priority: number; order: number }) {
    return a.priority < b.priority || (a.priority === b.priority && a.order < b.order);
  }
}

const manhattanDistance = memoizeByTick(
  (fromRoom, toRoom) => fromRoom + toRoom,
  (fromRoom: string, toRoom: string) => {
    const { wx: fromX, wy: fromY } = roomNameToCoords(fromRoom);
    const { wx: toX, wy: toY } = roomNameToCoords(toRoom);

    // Manhattan distance
    return Math.abs(fromX - toX) + Math.abs(fromY - toY);
  }
);

interface PortalRouteField {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  distances: Uint16Array;
}

interface PortalGraph {
  version: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  rooms: { wx: number; wy: number; links: { wx: number; wy: number }[] }[];
}

let portalGraph: PortalGraph | undefined;

function getPortalGraph(): PortalGraph {
  const version = getPortalSetsVersion();
  if (portalGraph?.version === version) return portalGraph;
  const rooms = [...portalSets.entries()].map(([room, links]) => ({
    ...roomNameToCoords(room),
    links: [...links.keys()].map(linked => roomNameToCoords(linked))
  }));
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const { wx, wy } of rooms) {
    minX = Math.min(minX, wx);
    minY = Math.min(minY, wy);
    maxX = Math.max(maxX, wx);
    maxY = Math.max(maxY, wy);
  }
  portalGraph = { version, minX, minY, maxX, maxY, rooms };
  return portalGraph;
}

const portalRouteField = memoizeByTick(
  (toRooms: string[]) => getPortalSetsVersion() + ':' + toRooms.join(','),
  (toRooms: string[]): PortalRouteField => {
    const graph = getPortalGraph();
    const targets = toRooms.map(room => roomNameToCoords(room));
    let { minX, minY, maxX, maxY } = graph;
    for (const { wx, wy } of targets) {
      minX = Math.min(minX, wx);
      minY = Math.min(minY, wy);
      maxX = Math.max(maxX, wx);
      maxY = Math.max(maxY, wy);
    }
    const width = maxX - minX + 1;
    const height = maxY - minY + 1;
    const indexOf = (wx: number, wy: number) => (wy - minY) * width + (wx - minX);

    const portalAt = new Int32Array(width * height).fill(-1);
    graph.rooms.forEach(({ wx, wy }, i) => (portalAt[indexOf(wx, wy)] = i));

    const distances = new Uint16Array(width * height).fill(0xffff);
    const queue = new Int32Array(width * height);
    let head = 0;
    let tail = 0;
    const visit = (index: number, distance: number) => {
      if (distances[index] <= distance) return;
      distances[index] = distance;
      queue[tail++] = index;
    };
    for (const { wx, wy } of targets) visit(indexOf(wx, wy), 0);
    while (head < tail) {
      const index = queue[head++];
      const x = index % width;
      const y = (index - x) / width;
      const next = distances[index] + 1;
      if (x > 0) visit(index - 1, next);
      if (x < width - 1) visit(index + 1, next);
      if (y > 0) visit(index - width, next);
      if (y < height - 1) visit(index + width, next);
      const portal = portalAt[index];
      if (portal >= 0) for (const link of graph.rooms[portal].links) visit(indexOf(link.wx, link.wy), next);
    }
    return { minX, minY, maxX, maxY, distances };
  }
);

function portalRouteHeuristic(field: PortalRouteField, room: string) {
  const { minX, minY, maxX, maxY, distances } = field;
  const { wx, wy } = roomNameToCoords(room);
  const x = Math.min(Math.max(wx, minX), maxX);
  const y = Math.min(Math.max(wy, minY), maxY);
  return Math.abs(wx - x) + Math.abs(wy - y) + distances[(y - minY) * (maxX - minX + 1) + (x - minX)];
}

/**
 * Returns a sequence of rooms. Exits between rooms may be normal room exits or a portal set.
 */
export function findRouteWithPortals(
  fromRoom: string,
  toRooms: string[],
  opts?: Partial<RouteOptions> & { maxCost?: number },
  avoidPortals?: boolean
): { room: string; exit?: ExitConstant; portalSet?: PortalSet }[][] | ERR_NO_PATH | ERR_NOT_IN_RANGE {
  if (toRooms.includes(fromRoom)) return [];

  const routeCallback = opts?.routeCallback ?? (() => 1);
  const maxCost = opts?.maxCost ?? Infinity;
  let cutByMaxCost = false;
  const field = !avoidPortals && portalSets.size > 0 ? portalRouteField(toRooms) : undefined;
  const heuristic = (room: string) =>
    field
      ? portalRouteHeuristic(field, room)
      : Math.min(...toRooms.map(toRoom => manhattanDistance(room, toRoom)));

  // A* search, using describeExits to map the grid
  const frontier = new PriorityQueue<string>();
  frontier.put(fromRoom, 0);
  const cameFrom = new Map<string, string>();
  const costSoFar = new Map<string, number>();
  cameFrom.set(fromRoom, fromRoom);
  costSoFar.set(fromRoom, 0);

  let current = frontier.take();
  while (current) {
    if (toRooms.includes(current)) break;

    for (const next of describeExitsWithPortals(current, !avoidPortals)) {
      const cost = costSoFar.get(current)! + routeCallback(next, current);
      if (cost !== Infinity && (!costSoFar.has(next) || cost < costSoFar.get(next)!)) {
        const priority = cost + heuristic(next);
        if (priority > maxCost) {
          cutByMaxCost = true;
          continue;
        }
        costSoFar.set(next, cost);
        frontier.put(next, priority);
        cameFrom.set(next, current);
      }
    }

    current = frontier.take();
  }

  if (current && toRooms.includes(current)) {
    // reconstruct path
    const paths: { room: string; exit?: ExitConstant; portalSet?: PortalSet }[][] = [];
    let path: { room: string; exit?: ExitConstant; portalSet?: PortalSet }[] = [{ room: current }];
    while (current !== fromRoom) {
      const previous: string = cameFrom.get(current)!;
      const portalSet = portalSets.get(previous)?.get(current);
      if (portalSet && !avoidPortals) {
        // there's a portal between these two rooms - use it
        paths.unshift(path);
        path = [{ room: previous, portalSet }];
      } else {
        // no portal - must be a regular exit
        const exit = Game.map.findExit(previous, current);
        path.unshift({
          room: previous,
          exit: exit === ERR_NO_PATH ? undefined : (exit as ExitConstant)
        });
      }
      current = previous;
    }
    paths.unshift(path);
    return paths;
  }

  return cutByMaxCost ? ERR_NOT_IN_RANGE : ERR_NO_PATH;
}
