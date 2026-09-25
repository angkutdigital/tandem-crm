/**
 * Tandem's only product-policy input. Applications supply their own values
 * rather than changing reusable CRM behaviour in-place.
 */
export type TandemConfig = {
  qualification: {
    automatedSetupMaxQualificationMetric: number;
  };
  commission: {
    holdDays: number;
  };
};

export const defaultTandemConfig: TandemConfig = {
  qualification: {
    automatedSetupMaxQualificationMetric: 15,
  },
  commission: {
    holdDays: 30,
  },
};

export function defineTandemConfig(config: TandemConfig): TandemConfig {
  if (!Number.isSafeInteger(config.qualification.automatedSetupMaxQualificationMetric)) {
    throw new Error("automatedSetupMaxQualificationMetric must be a safe integer");
  }

  if (config.qualification.automatedSetupMaxQualificationMetric < 0) {
    throw new Error("automatedSetupMaxQualificationMetric cannot be negative");
  }

  if (!Number.isSafeInteger(config.commission.holdDays) || config.commission.holdDays < 0) {
    throw new Error("holdDays must be a non-negative safe integer");
  }

  return config;
}
