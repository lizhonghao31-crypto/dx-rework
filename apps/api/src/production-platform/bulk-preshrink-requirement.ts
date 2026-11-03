export type BulkPreshrinkRequirement = '需要预缩' | '无需预缩';

/** An existing preparation owns its frozen choice. A later draft/publication cannot replace it. */
export function resolveBulkPreshrinkRequirement(
 preparation: {preshrink: unknown} | null | undefined,
 publishedInstruction?: {preshrink?: unknown} | null,
): BulkPreshrinkRequirement | null {
 const choice = preparation ? preparation.preshrink : publishedInstruction?.preshrink;
 return choice === '需要预缩' || choice === '无需预缩' ? choice : null;
}
