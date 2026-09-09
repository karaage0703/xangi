import { describe, expect, it } from 'vitest';
import { formatModelExecution, latestModelExecution } from '../src/model-execution-display.js';
import { modelExecutionLabel, executionStatusLabel } from '../web-ui/src/modelExecution.js';
import type { ModelExecution } from '../src/sessions.js';

const execution: ModelExecution = {
  turnId: 'turn-1',
  backend: 'example',
  configuredModel: 'auto',
  observedModels: ['model-before', 'model-after'],
  effectiveModel: 'model-after',
  source: 'provider',
  startedAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:01Z',
  status: 'completed',
};

describe('model execution presentation', () => {
  it('shows all provider models including switches, independently from configured aliases', () => {
    expect(formatModelExecution(execution)).toMatch(/model-after（2026\/01\/01 \d{2}:\d{2}）/);
    expect(formatModelExecution(execution)).not.toMatch(/プロバイダー確認済み|完了|T00:00/);
    expect(modelExecutionLabel(execution)).toContain('model-after（確認済み）');
  });
  it('leads with final model after A → B → A and separately lists other observations', () => {
    const returned = { ...execution, effectiveModel: 'model-before' };
    expect(modelExecutionLabel(returned)).toBe(
      'example · model-before（確認済み） / 同turnで確認: model-after'
    );
    expect(formatModelExecution(returned)).toContain('example / model-before');
    expect(formatModelExecution(returned)).toContain('同turnで確認: model-after');
    expect(executionStatusLabel('running')).toBe('実行中');
  });
  it('uses recovered history and preserves legacy configured values as unconfirmed', () => {
    expect(latestModelExecution({ modelHistory: [execution] })).toEqual(execution);
    const configured = { backend: 'old-backend', model: 'old-request' };
    expect(modelExecutionLabel(undefined, configured)).toBe(
      'old-backend · old-request（当時の設定値・実行未確認）'
    );
    expect(formatModelExecution(undefined, configured)).toContain('当時の設定値・実行未確認');
  });
  it('does not claim configured values were observed', () => {
    const configured: ModelExecution = {
      ...execution,
      observedModels: [],
      effectiveModel: 'requested',
      source: 'configuration',
    };
    expect(formatModelExecution(configured)).toContain('設定値・実行未確認');
    expect(modelExecutionLabel(configured)).toContain('設定値・実行未確認');
  });
  it('keeps historical missing evidence unknown without reading current defaults', () => {
    expect(formatModelExecution()).toContain('不明');
    expect(modelExecutionLabel()).toContain('記録なし');
    expect(
      modelExecutionLabel({
        ...execution,
        observedModels: [],
        effectiveModel: undefined,
        configuredModel: undefined,
        source: 'unknown',
      })
    ).toContain('モデル不明');
  });
});

it('distinguishes Auto routing from absent model records', () => {
  const auto = { ...execution, modelSelection: 'Auto', effectiveModel: undefined, observedModels: [], source: 'unknown' as const };
  expect(formatModelExecution(auto)).toContain('Auto（自動選択・内部モデル不明）');
  expect(modelExecutionLabel(auto)).toContain('Auto（自動選択・内部モデル不明）');
});
