export type PathSearchFn = (
  origin: RoomPosition,
  goal:
    | RoomPosition
    | { pos: RoomPosition; range: number }
    | Array<RoomPosition | { pos: RoomPosition; range: number }>,
  opts?: PathFinderOpts
) => PathFinderPath;

// Exported mutable holder — replace .fn to monkey-patch all call sites including
// internal ones inside generatePath.
export const pathSearchRef: { fn: PathSearchFn } = {
  fn: (origin, goal, opts) => PathFinder.search(origin, goal, opts)
};

export const pathSearch: PathSearchFn = (origin, goal, opts) => pathSearchRef.fn(origin, goal, opts);
