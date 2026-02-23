import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';

/**
 * Channel-specific model configuration
 */
export interface ChannelModelConfig {
  model?: string; // e.g. "sonnet", "opus", "haiku"
  effort?: string; // "low" | "medium" | "high" (Opus only)
}

type ChannelModelMap = Map<string, ChannelModelConfig>;

let channelModelsPath: string | null = null;
let channelModels: ChannelModelMap = new Map();

/**
 * Initialize channel models from file
 * @param dataDir DATA_DIR or .xangi directory
 */
export function initChannelModels(dataDir: string): void {
  channelModelsPath = join(dataDir, 'channel-models.json');
  loadChannelModelsFromFile();
}

function getChannelModelsPath(): string {
  if (!channelModelsPath) {
    throw new Error('Channel models not initialized. Call initChannelModels(dataDir) first.');
  }
  return channelModelsPath;
}

function loadChannelModelsFromFile(): void {
  const path = getChannelModelsPath();
  try {
    if (existsSync(path)) {
      const raw = readFileSync(path, 'utf-8');
      const parsed = JSON.parse(raw) as Record<string, ChannelModelConfig>;
      channelModels = new Map(Object.entries(parsed));
      console.log(`[xangi] Loaded ${channelModels.size} channel model config(s) from ${path}`);
    }
  } catch (err) {
    console.error('[xangi] Failed to load channel models:', err);
    channelModels = new Map();
  }
}

function saveChannelModelsToFile(): void {
  const path = getChannelModelsPath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    const obj = Object.fromEntries(channelModels);
    writeFileSync(path, JSON.stringify(obj, null, 2) + '\n', 'utf-8');
  } catch (err) {
    console.error('[xangi] Failed to save channel models:', err);
  }
}

/**
 * Get channel model config from memory Map (O(1))
 */
export function getChannelModelConfig(channelId: string): ChannelModelConfig | undefined {
  return channelModels.get(channelId);
}

/**
 * Set channel model config (Map update + file save)
 */
export function setChannelModelConfig(channelId: string, config: ChannelModelConfig): void {
  channelModels.set(channelId, config);
  saveChannelModelsToFile();
}

/**
 * Delete channel override (revert to default)
 */
export function deleteChannelModelConfig(channelId: string): boolean {
  const deleted = channelModels.delete(channelId);
  if (deleted) {
    saveChannelModelsToFile();
  }
  return deleted;
}

/**
 * Get all channel model configs
 */
export function getAllChannelModelConfigs(): Map<string, ChannelModelConfig> {
  return new Map(channelModels);
}

/**
 * Check if a model string refers to an Opus model
 */
export function isOpusModel(model: string | undefined): boolean {
  if (!model) return false;
  const lower = model.toLowerCase();
  return lower.includes('opus');
}
