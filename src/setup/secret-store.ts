import { readFile } from 'node:fs/promises';
import { writePrivateJsonFile } from './private-json-file.js';

interface SecretDocument {
  schemaVersion: 1;
  secrets: Record<string, string>;
}

const SECRET_NAME = /^[A-Z][A-Z0-9_]*$/;

export class SecretStore {
  constructor(readonly path: string) {}

  async get(name: string): Promise<string | undefined> {
    validateName(name);
    const document = await this.read();
    return document.secrets[name];
  }

  async all(): Promise<Record<string, string>> {
    const document = await this.read();
    return { ...document.secrets };
  }

  async set(name: string, value: string): Promise<void> {
    await this.setMany({ [name]: value });
  }

  async setMany(values: Record<string, string>): Promise<void> {
    for (const [name, value] of Object.entries(values)) {
      validateName(name);
      if (!value.trim()) throw new Error('secret value must not be empty');
    }
    if (Object.keys(values).length === 0) return;
    const current = await this.read();
    const document: SecretDocument = {
      schemaVersion: 1,
      secrets: { ...current.secrets, ...values },
    };
    await writePrivateJsonFile(this.path, document);
  }

  private async read(): Promise<SecretDocument> {
    let value: unknown;
    try {
      value = JSON.parse(await readFile(this.path, 'utf8')) as unknown;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { schemaVersion: 1, secrets: {} };
      }
      throw error;
    }
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      (value as Record<string, unknown>).schemaVersion !== 1 ||
      !isSecretMap((value as Record<string, unknown>).secrets)
    ) {
      throw new Error(`Invalid secret store: ${this.path}`);
    }
    return value as SecretDocument;
  }
}

function isSecretMap(value: unknown): value is Record<string, string> {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.entries(value as Record<string, unknown>).every(
      ([name, secret]) => SECRET_NAME.test(name) && typeof secret === 'string' && secret.length > 0
    )
  );
}

function validateName(name: string): void {
  if (!SECRET_NAME.test(name)) throw new Error(`Invalid secret name: ${name}`);
}
