import type { ItemInput } from "../kernel/types";

export interface Plugin {
  readonly id: string;
  pull(): Promise<ItemInput[]>;
}
