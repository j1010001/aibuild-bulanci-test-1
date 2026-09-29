// Built-in map catalog. Until the level editor (M3) adds custom maps through the map
// loader, a room's map is always chosen by id from this list, so no client-supplied map
// data ever reaches the server.

import { DEFAULT_MAP } from '../sim';
import type { MapDef } from '../sim';

export type MapCatalogEntry = { id: string; name: string; map: MapDef };

export const BUILT_IN_MAPS: readonly MapCatalogEntry[] = [
  { id: 'default', name: 'Arena', map: DEFAULT_MAP },
  { id: 'open', name: 'Open field', map: { version: 1, board: { width: 40, height: 40 }, obstacles: [] } },
];
