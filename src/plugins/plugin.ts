import type { ItemInput } from "../kernel/types";

export interface Plugin {
  readonly id: string;
  pull(): Promise<ItemInput[]>;
  // Kinds the last pull listed in full. The cycle archives this source's items of those kinds
  // that the pull left out, because the source no longer lists them (handed in, unenrolled).
  complete?(): string[];
}
