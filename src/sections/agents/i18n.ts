// Agents section strings ('sec.agents.*'); each part lives in strings/<part>.ts. zh-CN is the key source, en/ja mirror it, zh-TW is derived.
import { gridEn, gridJa, gridZhCN } from './strings/grid';
import { manageEn, manageJa, manageZhCN } from './strings/manage';
import { sessionsEn, sessionsJa, sessionsZhCN } from './strings/sessions';
import { setupEn, setupJa, setupZhCN } from './strings/setup';
import { shellEn, shellJa, shellZhCN } from './strings/shell';

export const agentsZhCN = {
  ...shellZhCN, ...gridZhCN, ...setupZhCN, ...manageZhCN, ...sessionsZhCN,
} as const;

export const agentsEn: Record<keyof typeof agentsZhCN, string> = {
  ...shellEn, ...gridEn, ...setupEn, ...manageEn, ...sessionsEn,
};

export const agentsJa: Record<keyof typeof agentsZhCN, string> = {
  ...shellJa, ...gridJa, ...setupJa, ...manageJa, ...sessionsJa,
};
