import { isNewSourcingPrice } from "./sourcing-price-presentation.js";

export type SourcingPriceCascadeLine = Readonly<{
  position: number;
  unitPrice: string;
}>;

export type SourcingPriceCascadeResult = Readonly<{
  linePrices: readonly SourcingPriceCascadeLine[];
  independentPositions: ReadonlySet<number>;
}>;

/**
 * The first line is a convenience template only while a follower has not been
 * edited directly in the current form session. Incomplete/invalid first-line
 * edits never fan out to other rows.
 */
export function applySourcingPriceCascade(
  linePrices: readonly SourcingPriceCascadeLine[],
  position: number,
  nextValue: string,
  independentPositions: ReadonlySet<number>,
): SourcingPriceCascadeResult {
  const nextIndependent = new Set(independentPositions);
  const firstPosition = linePrices[0]?.position;

  if (firstPosition !== undefined && position !== firstPosition) {
    nextIndependent.add(position);
  }

  const shouldCascade = firstPosition !== undefined
    && position === firstPosition
    && isNewSourcingPrice(nextValue);

  return {
    linePrices: linePrices.map((line) => {
      const directlyEdited = line.position === position;
      const followsFirst = shouldCascade
        && line.position !== firstPosition
        && !nextIndependent.has(line.position);
      return directlyEdited || followsFirst
        ? { ...line, unitPrice: nextValue }
        : line;
    }),
    independentPositions: nextIndependent,
  };
}
