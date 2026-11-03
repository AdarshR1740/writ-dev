import type { TaskType } from "../_shared/models.ts";

export interface Prepared {
  companyId: string;
  taskType: TaskType;
  system: string;
  user: string;
  expectedOutputTokens: number;
  run: () => Promise<unknown>;
}
