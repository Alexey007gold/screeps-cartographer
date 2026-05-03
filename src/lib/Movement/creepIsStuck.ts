import { HeapCache } from '../CachingStrategies/Heap';
import { creepKey } from '../Keys/Creep';

const keys = {
  LAST_POSITION: '_csp',
  LAST_POSITION_TIME: '_cst',
  LAST_CHECK_TIME: '_csct'
};

/**
 * Tracks a creep's position and returns true if it has no fatigue
 * but has not moved in `stuckLimit` ticks
 */
export const creepIsStuck = (creep: Creep | PowerCreep, stuckLimit: number) => {
  // unspawned power creeps have undefined pos
  if (!creep.pos) return false;
  if ('fatigue' in creep && creep.fatigue > 0) return false;

  // get last position
  const lastPos = HeapCache.get(creepKey(creep, keys.LAST_POSITION));
  const lastTime = HeapCache.get(creepKey(creep, keys.LAST_POSITION_TIME));
  const lastCheckTime = HeapCache.get(creepKey(creep, keys.LAST_CHECK_TIME));

  // go ahead and update pos and checked time in the cache
  HeapCache.set(creepKey(creep, keys.LAST_POSITION), creep.pos);
  HeapCache.set(creepKey(creep, keys.LAST_CHECK_TIME), Game.time);

  // reset timer if position changed, first call, or there was a gap in movement attempts
  if (!lastPos || !lastTime || !lastCheckTime || !creep.pos.isEqualTo(lastPos) || lastCheckTime < Game.time - 1) {
    // start counting
    HeapCache.set(creepKey(creep, keys.LAST_POSITION_TIME), Game.time);
    return false;
  }

  // true if creep has been here (with no fatigue) for longer than stuckLimit
  return lastTime + stuckLimit < Game.time;
};
