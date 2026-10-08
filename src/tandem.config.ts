/**
 * Tandem's only product-policy input. Applications supply their own values
 * rather than changing reusable CRM behaviour in-place.
 */
export type CommissionRateTier = {
  /** The tier applies from this many whole months of customer age. */
  fromMonth: number;
  /** 1 basis point = 0.01%. 2500 = 25%. */
  basisPoints: number;
};

export type PartnerDeactivationPolicy = {
  /** Payments that arrive after the partner is deactivated. */
  futurePayments: "continue" | "house" | "forfeit";
  /** Lines already held, eligible or approved when the partner is
   * deactivated. Paid lines are never touched. */
  heldLines: "keep" | "house" | "void";
};

export type TandemConfig = {
  qualification: {
    automatedSetupMaxQualificationMetric: number;
  };
  commission: {
    holdDays: number;
    /** Lifetime commission rates by customer age, for example 25% in year
     * one and 20% after: [{ fromMonth: 0, basisPoints: 2500 },
     * { fromMonth: 12, basisPoints: 2000 }]. The first tier must start at
     * month 0. Optional: without it, the caller passes a rate when
     * planning a payment's commission. */
    rateSchedule?: CommissionRateTier[];
  };
  /** What happens to a partner's commission when the host deactivates the
   * partner. Defaults to paying the partner as usual. */
  partners?: {
    /** The account house lines are owed to. Defaults to "house". */
    houseAccountId?: string;
    onDeactivation?: PartnerDeactivationPolicy;
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

export const defaultPartnerDeactivationPolicy: PartnerDeactivationPolicy = {
  futurePayments: "continue",
  heldLines: "keep",
};

export function validateRateSchedule(schedule: readonly CommissionRateTier[]): void {
  if (schedule.length === 0) throw new Error("rateSchedule needs at least one tier");
  let previous = -1;
  for (const [index, tier] of schedule.entries()) {
    if (!Number.isSafeInteger(tier.fromMonth) || tier.fromMonth < 0) throw new Error("rateSchedule fromMonth must be a non-negative integer");
    if (index === 0 && tier.fromMonth !== 0) throw new Error("rateSchedule must start at fromMonth 0");
    if (tier.fromMonth <= previous) throw new Error("rateSchedule tiers must be in increasing fromMonth order");
    if (!Number.isSafeInteger(tier.basisPoints) || tier.basisPoints < 0 || tier.basisPoints > 10_000) {
      throw new Error("rateSchedule basisPoints must be an integer from 0 to 10000");
    }
    previous = tier.fromMonth;
  }
}

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

  if (config.commission.rateSchedule !== undefined) validateRateSchedule(config.commission.rateSchedule);

  const partners = config.partners;
  if (partners?.houseAccountId !== undefined && !partners.houseAccountId.trim()) {
    throw new Error("houseAccountId must not be empty");
  }
  const policy = partners?.onDeactivation;
  if (policy) {
    if (!["continue", "house", "forfeit"].includes(policy.futurePayments)) throw new Error("futurePayments must be continue, house or forfeit");
    if (!["keep", "house", "void"].includes(policy.heldLines)) throw new Error("heldLines must be keep, house or void");
  }

  return config;
}
