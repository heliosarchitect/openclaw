export interface ContributionItem {
  subject: string;
  claim: string;
  evidence: string[];
  confidence: number;
  provenance: {
    source_agent: string;
    run_id: string;
    timestamps: string[];
    source_type?: "trusted_internal" | "external_untrusted";
  };
}

export interface ContributionDecision {
  accepted: boolean;
  reason: string;
}

export interface ValidateContributionInput {
  item: ContributionItem;
  allowExternalStateChanges?: boolean;
}

export function validateContribution(input: ValidateContributionInput): ContributionDecision {
  const { item, allowExternalStateChanges = false } = input;

  if (!item.subject.trim() || !item.claim.trim()) {
    return { accepted: false, reason: "missing_subject_or_claim" };
  }

  if (!Array.isArray(item.evidence) || item.evidence.length === 0) {
    return { accepted: false, reason: "missing_evidence" };
  }

  if (item.confidence < 0.7) {
    return { accepted: false, reason: "confidence_below_threshold" };
  }

  const sourceType = item.provenance.source_type ?? "trusted_internal";
  const stateChangeHint = /(delete|drop|reset|destroy|revoke|terminate)/i.test(item.claim);

  if (sourceType === "external_untrusted" && stateChangeHint && !allowExternalStateChanges) {
    return { accepted: false, reason: "external_state_change_requires_approval" };
  }

  return { accepted: true, reason: "accepted" };
}
