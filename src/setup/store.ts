import { parseSetupConfig, type SetupConfig } from './schema.js';
import { writePrivateJsonFile } from './private-json-file.js';

export { parseSetupConfig, SetupValidationError, type SetupConfig } from './schema.js';

export interface SetupConfigWriter {
  save(config: SetupConfig): Promise<void>;
}

export class SetupStore {
  constructor(readonly configPath: string) {}

  async save(input: unknown): Promise<void> {
    await writePrivateJsonFile(this.configPath, parseSetupConfig(input));
  }
}
