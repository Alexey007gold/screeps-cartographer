import { config } from 'config';
import { CoordMap } from 'lib/Utils/CoordMap';
import { Codec } from 'screeps-utf15';
import { packCoordList, packRoomName, unpackCoordList, unpackRoomName } from 'utils/packPositions';
import { isCenterRoom, isHighway } from './selectors';

const timeCodec = new Codec({ array: false, depth: 30 });

export interface PortalSet {
  room1: string;
  room2: string;
  expires?: number;
  portalMap: CoordMap;
}

export const portalSets = new Map<string, Map<string, PortalSet>>();

let portalSetsChanged = false;
let nextExpiry = Infinity;
let portalSetsVersion = 0;

export function getPortalSetsVersion() {
  return portalSetsVersion;
}

export function linkPortalSet(portalSet: PortalSet) {
  linkOneWay(portalSet.room1, portalSet.room2, portalSet);
  linkOneWay(portalSet.room2, portalSet.room1, portalSet);
  if (portalSet.expires !== undefined) nextExpiry = Math.min(nextExpiry, portalSet.expires);
  portalSetsVersion++;
}

function linkOneWay(from: string, to: string, portalSet: PortalSet) {
  const map = portalSets.get(from) ?? new Map<string, PortalSet>();
  map.set(to, portalSet);
  portalSets.set(from, map);
}

export function unlinkPortalSet(room1: string, room2: string) {
  unlinkOneWay(room1, room2);
  unlinkOneWay(room2, room1);
  portalSetsVersion++;
}

function unlinkOneWay(from: string, to: string) {
  const map = portalSets.get(from);
  if (!map) return;
  map.delete(to);
  if (map.size === 0) portalSets.delete(from);
}

let hydrated = false;

// deserialize portal sets after a global reset
function ensureHydrated() {
  if (hydrated) return;
  hydrated = true;
  if (config.EXTERNAL_PORTAL_SOURCE) return;
  Memory[config.MEMORY_PORTAL_PATH] ??= [];
  for (const serializedPortalSet of Memory[config.MEMORY_PORTAL_PATH]) {
    linkPortalSet(deserializePortalSet(serializedPortalSet));
  }
}

export function markHydrated() {
  hydrated = true;
}

/**
 * Portal sets are linked both ways, so
 * .get(origin).get(destination) === .get(destination).get(origin)
 * (but the `room1` and `room2` don't necessarily correspond to the lookup order)
 */
export function scanPortals(room: string) {
  ensureHydrated();
  if (config.EXTERNAL_PORTAL_SOURCE) return;
  // only scan highways and center rooms to save CPU
  if (!isHighway(room) && !isCenterRoom(room)) return;

  const observedTargets = new Set<string>();
  for (const portalSet of collectIntrashardPortals(room)) {
    const known = portalSets.get(portalSet.room1)?.get(portalSet.room2);
    if (!known || !isSamePortalSet(known, portalSet)) {
      linkPortalSet(portalSet);
      portalSetsChanged = true;
    }
    observedTargets.add(portalSet.room2);
  }

  // cleanup old portal sets
  for (const to of [...(portalSets.get(room)?.keys() ?? [])]) {
    if (!observedTargets.has(to)) {
      // this connection has disappeared
      unlinkPortalSet(room, to);
      portalSetsChanged = true;
    }
  }
}

export function cachePortals() {
  ensureHydrated();
  if (config.EXTERNAL_PORTAL_SOURCE) return;
  if (Game.time > nextExpiry) {
    removeExpiredPortalSets();
  }
  if (!portalSetsChanged) return;
  portalSetsChanged = false;

  // serialize portal sets
  const allPortalSets = new Set<PortalSet>();
  Memory[config.MEMORY_PORTAL_PATH] = [];
  for (const portalSetMap of portalSets.values()) {
    for (const portalSet of portalSetMap.values()) {
      if (allPortalSets.has(portalSet)) continue;
      allPortalSets.add(portalSet);
      Memory[config.MEMORY_PORTAL_PATH].push(serializePortalSet(portalSet));
    }
  }
}

function isSamePortalSet(known: PortalSet, scanned: PortalSet) {
  if (known.expires !== scanned.expires || known.portalMap.size !== scanned.portalMap.size) return false;
  const knownSide = known.room1 === scanned.room1 ? known.portalMap : known.portalMap.reversed;
  return [...scanned.portalMap.keys()].every(coord => knownSide.has(coord));
}

function removeExpiredPortalSets() {
  nextExpiry = Infinity;
  for (const portalSetMap of [...portalSets.values()]) {
    for (const portalSet of [...portalSetMap.values()]) {
      if (portalSet.expires === undefined) continue;
      if (portalSet.expires < Game.time) {
        unlinkPortalSet(portalSet.room1, portalSet.room2);
        portalSetsChanged = true;
      } else {
        nextExpiry = Math.min(nextExpiry, portalSet.expires);
      }
    }
  }
}

/**
 * A room may have many portals, but these will generally link to only
 * a few other rooms. This function will serialize the origin room,
 * target room, and source and destination coords for each portal pair.
 *
 * This assumes:
 * 1. A portal's destination square always has a reverse portal on the
 *    other side
 * 2. All portals to a given target room have the same expiration
 */
function collectIntrashardPortals(room: string): PortalSet[] {
  if (!Game.rooms[room]) return [];

  // collect portal links by room target
  const portalSets = new Map<string, PortalSet>();
  for (const portal of Game.rooms[room].find(FIND_STRUCTURES, {
    filter: { structureType: STRUCTURE_PORTAL }
  }) as StructurePortal[]) {
    if (!(portal.destination instanceof RoomPosition)) continue; // ignore intershard portals

    const mapping = portalSets.get(portal.destination.roomName) ?? {
      room1: room,
      room2: portal.destination.roomName,
      portalMap: new CoordMap()
    };
    portalSets.set(portal.destination.roomName, mapping);
    mapping.portalMap.set(portal.pos, portal.destination);
    if (portal.ticksToDecay) {
      mapping.expires = Game.time + portal.ticksToDecay;
    } else {
      delete mapping.expires;
    }
  }

  return [...portalSets.values()];
}

/**
 * Format:
 *
 * 1. Origin room (2 chars, packed)
 * 2. Target room (2 chars, packed)
 * 3. Expiration ()
 */
function serializePortalSet(portalSet: PortalSet) {
  let serialized = '';

  // serialize rooms
  serialized += packRoomName(portalSet.room1);
  serialized += packRoomName(portalSet.room2);
  serialized += timeCodec.encode(portalSet.expires ?? 0);
  serialized += packCoordList([...portalSet.portalMap.entries()].flat());
  return serialized;
}

function deserializePortalSet(serialized: string): PortalSet {
  const origin = unpackRoomName(serialized.slice(0, 3));
  const target = unpackRoomName(serialized.slice(3, 6));
  const expires = timeCodec.decode(serialized.slice(6, 8));
  const portalMap = new CoordMap();
  const unpackedCoords = unpackCoordList(serialized.slice(8));
  for (let i = 0; i < unpackedCoords.length; i += 2) {
    portalMap.set(unpackedCoords[i], unpackedCoords[i + 1]);
  }

  return {
    room1: origin,
    room2: target,
    expires: expires !== 0 ? expires : undefined,
    portalMap
  };
}

export function describeExitsWithPortals(room: string, includePortals = true): string[] {
  ensureHydrated();
  // initial set with normal room exits
  const exits = new Set(Object.values(Game.map.describeExits(room) ?? {}));

  // add portals to set
  const portalSetMap = includePortals ? portalSets.get(room) : undefined;
  if (!portalSetMap) return [...exits];
  for (const linkedRoom of portalSetMap.keys()) {
    exits.add(linkedRoom);
  }
  return [...exits];
}
