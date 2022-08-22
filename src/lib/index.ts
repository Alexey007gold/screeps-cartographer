import { CachingStrategy, cleanAllCaches } from './CachingStrategies';

export type MoveTarget = { pos: RoomPosition; range: number };
export interface MoveOpts extends PathFinderOpts {
  /**
   * Caching strategy to use to save paths. Defaults to HeapCache.
   */
  cache?: CachingStrategy;
  /**
   * Number of ticks to save a cached path before repathing.
   */
  reusePath?: number;
  /**
   * If set, will visualize the path using provided styles.
   */
  visualizePathStyle?: PolyStyle;
  /**
   * Automatically populates cost matrix with creep positions.
   */
  avoidCreeps?: boolean;
  /**
   * Automatically populates cost matrix with structure positions.
   */
  avoidObstacleStructures?: boolean;
  /**
   * Cost for walking on road positions. The default is 1.
   */
  roadCost?: number;
  /**
   * Cost for walking on plain positions. The default is 2.
   */
  plainCost?: number;
  /**
   * Cost for walking on swamp positions. The default is 10.
   */
  swampCost?: number;
}

export * from './CachingStrategies';
export * from './Movement/moveTo';

export function preTick() {
  cleanAllCaches();
}
