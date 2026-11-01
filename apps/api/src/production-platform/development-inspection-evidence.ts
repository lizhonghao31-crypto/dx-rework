import type { DevelopmentDocument } from "@dx-rework/contracts/digital-development";
import type { DevelopmentActualMeasurements } from "@dx-rework/contracts/digital-development-execution";
import { ApplicationError } from "../platform/errors.js";
import {validTechnicalMeasurement} from '@dx-rework/contracts/digital-development-technical';

/** Match the published positions and sizes, so before/after measurements cannot silently move columns. */
export function validateDevelopmentMeasurements(document: DevelopmentDocument, measurements: DevelopmentActualMeasurements | undefined,technical=false) {
  const expected = document.measurements.filter(row => row.name.trim());
  const fail = (): never => { throw new ApplicationError("DEVELOPMENT_CONFLICT", "请按本轮开发单的测量部位和尺码填写实际尺寸", 409); };
  if (!expected.length || !document.sizes.length || !measurements || measurements.length !== expected.length) return fail();
  for (let index=0;index<expected.length;index++) {
    const actual=measurements[index]!;
    if (actual.name !== expected[index]!.name || actual.values.length !== document.sizes.length
      || actual.values.some(value=>technical?!validTechnicalMeasurement(value,document.unit):!/^\d+(?:\.\d+)?$/.test(value)||!Number.isFinite(Number(value)))) fail();
  }
}
