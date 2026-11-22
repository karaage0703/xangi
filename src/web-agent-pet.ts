import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';
import { realFileWithinRoots } from './file-utils.js';

const PET_DIRECTORY = 'assets/xangi-pets';

export function agentPetDirectory(agentId: string) {
  return `${PET_DIRECTORY}/${encodeURIComponent(agentId).replaceAll('.', '%2E')}`;
}

type AgentPet =
  | { status: 'missing' | 'invalid' }
  | { status: 'ready'; name: string; image: string; revision: string };

export function findAgentPet(workspace: string, agentId: string): AgentPet {
  for (const path of [agentPetDirectory(agentId), PET_DIRECTORY]) {
    const directory = join(workspace, path);
    const manifest = join(directory, 'pet.json');
    if (!existsSync(manifest)) continue;
    try {
      const file = realFileWithinRoots(manifest, [workspace]);
      if (!file || statSync(file).size > 64 * 1024) return { status: 'invalid' };
      const { displayName, spritesheetPath } = JSON.parse(readFileSync(file, 'utf8'));
      if (
        typeof spritesheetPath !== 'string' ||
        !spritesheetPath.endsWith('.webp') ||
        posix.isAbsolute(spritesheetPath) ||
        spritesheetPath.includes('\\') ||
        spritesheetPath.split('/').includes('..')
      ) {
        return { status: 'invalid' };
      }
      const target = join(directory, spritesheetPath);
      const image = realFileWithinRoots(target, [directory]);
      if (!image || !realFileWithinRoots(image, [workspace])) return { status: 'invalid' };
      const { size, mtimeMs } = statSync(image);
      if (size < 12 || size > 16 * 1024 * 1024) return { status: 'invalid' };
      const descriptor = openSync(image, 'r');
      const header = Buffer.alloc(12);
      try {
        readSync(descriptor, header, 0, header.length, 0);
      } finally {
        closeSync(descriptor);
      }
      if (header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8) !== 'WEBP')
        return { status: 'invalid' };
      const name = typeof displayName === 'string' ? displayName.trim().slice(0, 80) : '';
      return { status: 'ready', name, image, revision: `${mtimeMs}-${size}` };
    } catch {
      return { status: 'invalid' };
    }
  }
  return { status: 'missing' };
}

export function agentPetCreationPrompt(agentId: string): string {
  const directory = agentPetDirectory(agentId);
  return [
    'このエージェントの会話に表示するオリジナルのペットを、現在のワークスペースに作ってください。',
    `保存先は \`${directory}/pet.json\` と \`${directory}/spritesheet.webp\` です。既存のペットや他のファイルは上書きしないでください。`,
    'hatch-pet など互換のペット作成スキルがあれば使ってください。画像生成を利用できない場合は、既存のローカルツールで描画して構いません。',
    'スプライトは透明背景の WebP、1536×1872 ピクセル、8 列×9 行、1 セル 192×208 ピクセルです。各行の左からコマを詰め、余ったセルは透明にしてください。',
    '上から待機、右へ走る、左へ走る、手を振る、ジャンプ、失敗、待ち、実行中、考え中の順で、同じキャラクターの複数コマを作ってください。',
    'pet.json は id、displayName、spritesheetPath（値は spritesheet.webp）を持つ JSON オブジェクトです。',
    '両ファイルとスプライト寸法を検証してから、ペットの名前と作成結果を報告してください。',
  ].join('\n');
}
