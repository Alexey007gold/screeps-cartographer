type FindRouteModule = typeof import('lib/WorldMap/findRoute');
type PortalsModule = typeof import('lib/WorldMap/portals');
type PackPositionsModule = typeof import('utils/packPositions');

class TestRoomPosition {
  constructor(public x: number, public y: number, public roomName: string) {}
}

const WORLD_HALF = 60;

const SIDES: [string, number, number][] = [
  ['1', 0, -1],
  ['3', 1, 0],
  ['5', 0, 1],
  ['7', -1, 0]
];

describe('findRouteWithPortals', () => {
  let walls: Set<string>;
  let blocked: Set<string>;
  let closedEntries: Set<string>;
  let routeCallbackCalls: number;
  let findRoute: FindRouteModule;
  let portals: PortalsModule;
  let packPositions: PackPositionsModule;

  const neighbour = (room: string, dx: number, dy: number) => {
    const { wx, wy } = packPositions.roomNameToCoords(room);
    return packPositions.roomNameFromCoords(wx + dx, wy + dy);
  };

  const wall = (a: string, b: string) => {
    walls.add(`${a}|${b}`);
    walls.add(`${b}|${a}`);
  };

  const sealRooms = (rooms: string[], except: [string, string][] = []) => {
    const inside = new Set(rooms);
    for (const room of rooms) {
      for (const [, dx, dy] of SIDES) {
        const next = neighbour(room, dx, dy);
        if (inside.has(next) || except.some(([a, b]) => a === room && b === next)) continue;
        wall(room, next);
      }
    }
  };

  const describeExits = (room: string) => {
    const { wx, wy } = packPositions.roomNameToCoords(room);
    const exits: Record<string, string> = {};
    for (const [dir, dx, dy] of SIDES) {
      const nx = wx + dx;
      const ny = wy + dy;
      if (nx < -WORLD_HALF || nx >= WORLD_HALF || ny < -WORLD_HALF || ny >= WORLD_HALF) continue;
      const next = packPositions.roomNameFromCoords(nx, ny);
      if (!walls.has(`${room}|${next}`)) exits[dir] = next;
    }
    return exits;
  };

  const routeCallback = (room: string, fromRoom: string) => {
    routeCallbackCalls++;
    return blocked.has(room) || closedEntries.has(`${room}|${fromRoom}`) ? Infinity : 1;
  };

  const linkPortal = (from: string, to: string) => {
    const portal = {
      structureType: 'portal',
      pos: new TestRoomPosition(25, 25, from),
      destination: new TestRoomPosition(25, 25, to)
    };
    (globalThis as any).Game.rooms[from] = { name: from, find: () => [portal] };
    portals.scanPortals(from);
  };

  const route = (from: string, to: string, opts: { maxCost?: number; maxRange?: number }) => {
    routeCallbackCalls = 0;
    return findRoute.findRouteWithPortals(from, [to], { routeCallback, ...opts });
  };

  const routeRooms = (result: ReturnType<FindRouteModule['findRouteWithPortals']>) => {
    if (typeof result === 'number') throw new Error(`no route: ${result}`);
    return result.flat().map(step => step.room);
  };

  beforeEach(() => {
    jest.resetModules();
    walls = new Set();
    blocked = new Set();
    closedEntries = new Set();
    const g = globalThis as any;
    Object.assign(g, {
      ERR_NO_PATH: -2,
      ERR_NOT_IN_RANGE: -9,
      FIND_STRUCTURES: 107,
      STRUCTURE_PORTAL: 'portal',
      RoomPosition: TestRoomPosition,
      Memory: {},
      Game: {
        time: 1,
        rooms: {},
        cpu: { getUsed: () => 0 },
        map: { describeExits, findExit: () => 1 }
      }
    });
    packPositions = jest.requireActual<PackPositionsModule>('utils/packPositions');
    portals = jest.requireActual<PortalsModule>('lib/WorldMap/portals');
    findRoute = jest.requireActual<FindRouteModule>('lib/WorldMap/findRoute');
  });

  it('cannot prove a walled-in pocket unreachable with a cost limit alone', () => {
    sealRooms(['W36S1'], [['W36S1', 'W35S1']]);
    blocked.add('W35S1');

    expect(route('W33N2', 'W36S1', { maxCost: 30 })).toBe(ERR_NOT_IN_RANGE);
  }, 5000);

  it('proves a single-room pocket unreachable without searching the bounded area', () => {
    sealRooms(['W36S1'], [['W36S1', 'W35S1']]);
    blocked.add('W35S1');

    expect(route('W33N2', 'W36S1', { maxRange: 30 })).toBe(ERR_NO_PATH);
    expect(routeCallbackCalls).toBeLessThan(5);
  }, 5000);

  it('proves a multi-room pocket unreachable when its only exit is blocked', () => {
    sealRooms(['W54S28', 'W53S28', 'W54S29', 'W53S29'], [['W53S29', 'W52S29']]);
    blocked.add('W52S29');

    expect(route('W59S28', 'W54S28', { maxRange: 30 })).toBe(ERR_NO_PATH);
    expect(routeCallbackCalls).toBeLessThan(10);
  }, 5000);

  it('routes into a pocket that can be entered but not left', () => {
    sealRooms(['W36S1'], [['W36S1', 'W35S1']]);
    closedEntries.add('W35S1|W36S1');

    expect(routeRooms(route('W33N2', 'W36S1', { maxRange: 30 })).slice(-2)).toEqual(['W35S1', 'W36S1']);
  }, 5000);

  it('proves a target that cannot be entered from any side unreachable without searching the bounded area', () => {
    blocked.add('W30N5');

    expect(route('W33N2', 'W30N5', { maxRange: 30 })).toBe(ERR_NO_PATH);
    expect(routeCallbackCalls).toBeLessThan(10);
  }, 5000);

  it('routes into a pocket once its exit is passable', () => {
    sealRooms(['W54S28', 'W53S28', 'W54S29', 'W53S29'], [['W53S29', 'W52S29']]);

    const result = routeRooms(route('W59S28', 'W54S28', { maxRange: 30 }));

    expect(result).toContain('W52S29');
    expect(result.at(-1)).toBe('W54S28');
  }, 5000);

  it('starts the route from inside a pocket', () => {
    sealRooms(['W36S1', 'W36S2'], [['W36S2', 'W35S2']]);
    blocked.add('W35S2');

    expect(routeRooms(route('W36S2', 'W36S1', { maxRange: 30 }))).toEqual(['W36S2', 'W36S1']);
  }, 5000);

  it('reports no path when the target lies beyond the bounded area', () => {
    expect(route('W33N2', 'W33S40', { maxRange: 30 })).toBe(ERR_NO_PATH);
  }, 5000);

  it('finds a reachable room inside the bounded area', () => {
    const result = routeRooms(route('W33N2', 'W30N5', { maxRange: 30 }));

    expect(result[0]).toBe('W33N2');
    expect(result.at(-1)).toBe('W30N5');
  }, 5000);

  it('extends the bounded area around the far side of a portal', () => {
    linkPortal('W30N0', 'W30N50');

    const result = routeRooms(route('W31N2', 'W31N53', { maxRange: 30 }));

    expect(result).toEqual(expect.arrayContaining(['W30N0', 'W30N50', 'W31N53']));
  }, 5000);

  it('does not treat a pocket holding a portal as closed', () => {
    sealRooms(['W30N20']);
    linkPortal('W30N20', 'W30N0');

    const result = routeRooms(route('W31N2', 'W30N20', { maxRange: 30 }));

    expect(result).toEqual(expect.arrayContaining(['W30N0', 'W30N20']));
  }, 5000);
});
