import { describe, it, expect } from 'vitest';
import { formatSkillList, type Skill } from '../src/skills.js';

describe('skills', () => {
  describe('formatSkillList', () => {
    it('should show empty message when no skills', () => {
      const result = formatSkillList([]);
      expect(result).toContain('利用可能なスキルはありません');
    });

    it('should format single skill', () => {
      const skills: Skill[] = [
        { name: 'test-skill', description: 'テスト用スキル', path: '/path/to/skill' },
      ];
      const result = formatSkillList(skills);

      expect(result).toContain('利用可能なスキル');
      expect(result).toContain('test-skill');
      expect(result).toContain('テスト用スキル');
    });

    it('should format multiple skills', () => {
      const skills: Skill[] = [
        { name: 'skill-1', description: '説明1', path: '/path/1' },
        { name: 'skill-2', description: '説明2', path: '/path/2' },
      ];
      const result = formatSkillList(skills);

      expect(result).toContain('skill-1');
      expect(result).toContain('skill-2');
      expect(result).toContain('説明1');
      expect(result).toContain('説明2');
    });

    it('should include usage instructions', () => {
      const skills: Skill[] = [{ name: 'test', description: 'desc', path: '/path' }];
      const result = formatSkillList(skills);

      expect(result).toContain('/skill');
    });
  });
});
