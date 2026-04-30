import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const CLI_PATH = join(import.meta.dirname, '..', 'src', 'schedule-cli.ts');

function runCli(args: string, dataDir: string): { stdout: string; exitCode: number } {
  try {
    const stdout = execSync(`npx tsx ${CLI_PATH} ${args}`, {
      env: { ...process.env, DATA_DIR: dataDir },
      encoding: 'utf-8',
      timeout: 10000,
    });
    return { stdout, exitCode: 0 };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; status?: number };
    return {
      stdout: (err.stdout || '') + (err.stderr || ''),
      exitCode: err.status ?? 1,
    };
  }
}

describe('schedule-cli', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'schedule-cli-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should show help', () => {
    const { stdout, exitCode } = runCli('help', tmpDir);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('スケジューラCLI');
  });

  it('should add a schedule with natural language', () => {
    const { stdout, exitCode } = runCli(
      'add --channel test123 --platform discord "毎日 9:00 おはよう"',
      tmpDir
    );
    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.ok).toBe(true);
    expect(result.schedule.expression).toBe('0 9 * * *');
    expect(result.schedule.message).toBe('おはよう');
  });

  it('should add a schedule with --cron flag', () => {
    const { stdout, exitCode } = runCli(
      'add --channel test123 --platform discord --cron "30 8 * * 1-5" --message "出勤"',
      tmpDir
    );
    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.ok).toBe(true);
    expect(result.schedule.expression).toBe('30 8 * * 1-5');
  });

  it('should list schedules', () => {
    // まず追加
    runCli('add --channel ch1 --platform discord "毎日 9:00 テスト"', tmpDir);
    // リスト
    const { stdout, exitCode } = runCli('list --json', tmpDir);
    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.ok).toBe(true);
    expect(result.schedules.length).toBe(1);
  });

  it('should remove a schedule', () => {
    // 追加
    const { stdout: addOut } = runCli(
      'add --channel ch1 --platform discord "毎日 9:00 テスト"',
      tmpDir
    );
    const id = JSON.parse(addOut).schedule.id;

    // 削除
    const { stdout, exitCode } = runCli(`remove ${id}`, tmpDir);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('削除しました');
    expect(stdout).toContain('スケジュールはありません'); // 残り0件

    // 確認
    const { stdout: listOut } = runCli('list --json', tmpDir);
    expect(JSON.parse(listOut).schedules.length).toBe(0);
  });

  it('should persist to JSON file', () => {
    runCli('add --channel ch1 --platform discord "毎日 9:00 永続化テスト"', tmpDir);

    const filePath = join(tmpDir, 'schedules.json');
    const raw = readFileSync(filePath, 'utf-8');
    const data = JSON.parse(raw);
    expect(data.length).toBe(1);
    expect(data[0].message).toBe('永続化テスト');
  });

  it('should fail without --channel', () => {
    const { exitCode } = runCli('add "毎日 9:00 テスト"', tmpDir);
    expect(exitCode).toBe(1);
  });

  it('should fail with invalid input', () => {
    const { exitCode } = runCli('add --channel ch1 "解析できない入力"', tmpDir);
    expect(exitCode).toBe(1);
  });

  it('should remove a schedule by index number', () => {
    // 2つ追加
    runCli('add --channel ch1 --platform discord "毎日 9:00 テスト1"', tmpDir);
    runCli('add --channel ch1 --platform discord "毎日 10:00 テスト2"', tmpDir);

    // 番号1を削除
    const { stdout, exitCode } = runCli('remove 1', tmpDir);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('削除しました');
    expect(stdout).toContain('テスト2'); // テスト2だけ残る
    expect(stdout).not.toContain('テスト1'); // テスト1は消えた

    // 確認
    const { stdout: listOut } = runCli('list --json', tmpDir);
    const schedules = JSON.parse(listOut).schedules;
    expect(schedules.length).toBe(1);
    expect(schedules[0].message).toBe('テスト2');
  });

  it('should toggle a schedule by index number', () => {
    // 追加
    runCli('add --channel ch1 --platform discord "毎日 9:00 テスト"', tmpDir);

    // 番号1をトグル（無効化）
    const { stdout, exitCode } = runCli('toggle 1', tmpDir);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('無効化しました');
    expect(stdout).toContain('⏸️'); // 無効化状態のアイコン

    // 再度トグル（有効化）
    const { stdout: stdout2, exitCode: exitCode2 } = runCli('toggle 1', tmpDir);
    expect(exitCode2).toBe(0);
    expect(stdout2).toContain('有効化しました');
    expect(stdout2).toContain('✅'); // 有効化状態のアイコン
  });

  it('should fail when index is out of range', () => {
    // 1つだけ追加
    runCli('add --channel ch1 --platform discord "毎日 9:00 テスト"', tmpDir);

    // 範囲外の番号で削除を試みる
    const { stdout, exitCode } = runCli('remove 5', tmpDir);
    expect(exitCode).toBe(1);
    expect(stdout).toContain('範囲外');
  });

  it('should remove multiple schedules by index numbers', () => {
    // 3つ追加
    runCli('add --channel ch1 --platform discord "毎日 9:00 テスト1"', tmpDir);
    runCli('add --channel ch1 --platform discord "毎日 10:00 テスト2"', tmpDir);
    runCli('add --channel ch1 --platform discord "毎日 11:00 テスト3"', tmpDir);

    // 番号1と3を一度に削除（大きい番号から削除されるのでずれない）
    const { stdout, exitCode } = runCli('remove 1 3', tmpDir);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('2件削除しました');

    // テスト2だけ残る
    const { stdout: listOut } = runCli('list --json', tmpDir);
    const schedules = JSON.parse(listOut).schedules;
    expect(schedules.length).toBe(1);
    expect(schedules[0].message).toBe('テスト2');
  });
});
