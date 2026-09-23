/**
 * Pure, lightweight trigger matcher for 03-work.
 * Has ZERO external imports to ensure near-zero cold startup overhead.
 */
export function isExplicit03WorkTrigger(prompt: string): boolean {
	if (!prompt) return false;
	const trimmed = prompt.trim();
	const lower = trimmed.toLowerCase();

	// 1. Pi 展开后的 Skill XML 标记: <skill name="03-work" ...>
	if (lower.includes('<skill name="03-work"') || lower.startsWith('<skill name="03-work"')) {
		return true;
	}

	// 2. 规范技能调用
	if (lower.startsWith("/skill:03-work")) {
		return true;
	}

	// 3. 严格意图的自然语言指令
	const strictPatterns = [
		/^开始(?:干活|编码|实现|写代码)/,
		/^执行03-work/,
		/^自主(?:干活|工作|编码)/,
		/^(?:继续|恢复)(?:干活|工作|work)/i,
		/^resume\s+work/i,
	];

	if (strictPatterns.some((p) => p.test(trimmed))) {
		return true;
	}

	// 4. 自主循环驱动引擎内部生成的跨回合续跑提示词
	if (trimmed.startsWith("【03-work 自主循环驱动引擎")) {
		return true;
	}

	return false;
}
