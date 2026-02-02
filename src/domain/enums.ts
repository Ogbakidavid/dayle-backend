// Canonical enums matching lib/domain/enums.js

export enum VaultStatus {
  DRAFT = "DRAFT",
  AWAITING_FUNDING = "AWAITING_FUNDING",
  INVITED = "INVITED",
  FUNDED_UNASSIGNED = "FUNDED_UNASSIGNED",
  FUNDED_ASSIGNED = "FUNDED_ASSIGNED",
  ACTIVE = "ACTIVE",
  IN_REVIEW = "IN_REVIEW",
  COMPLETED = "COMPLETED",
  CANCELLED = "CANCELLED",
  PAUSED = "PAUSED",
}

export enum VaultType {
  DEVELOPMENT = "development",
  DESIGN = "design",
  CONTENT_AI = "content_ai",
  CONSULTING = "consulting",
}

export enum MilestoneStatus {
  PENDING = "PENDING",
  SUBMITTED = "SUBMITTED",
  AWAITING_APPROVAL = "AWAITING_APPROVAL",
  VERIFIED = "VERIFIED",
  REVISION_REQUESTED = "REVISION_REQUESTED",
  REJECTED = "REJECTED",
  DISPUTED = "DISPUTED",
}

export enum MilestoneDeliverableMode {
  LINK = "LINK",
  FILE = "FILE",
}

export enum VerificationResult {
  PASS = "PASS",
  FAIL = "FAIL",
  FLAGGED = "FLAGGED",
  HUMAN_REVIEW = "HUMAN_REVIEW",
}

export enum MilestoneReviewOutcome {
  APPROVE = "APPROVE",
  REQUEST_CHANGES = "REQUEST_CHANGES",
  REJECT = "REJECT",
}

export enum DisputeStatus {
  OPEN = "OPEN",
  UNDER_REVIEW = "UNDER_REVIEW",
  NEEDS_INFO = "NEEDS_INFO",
  RESOLVED = "RESOLVED",
  REJECTED = "REJECTED",
}

export enum TransactionStatus {
  PENDING = "PENDING",
  CONFIRMED = "CONFIRMED",
  FAILED = "FAILED",
}

export enum UserRole {
  NONE = "NONE",
  CLIENT = "CLIENT",
  FREELANCER = "FREELANCER",
  ADMIN = "ADMIN",
}

export enum KycStatus {
  NONE = "NONE",
  PENDING = "PENDING",
  VERIFIED = "VERIFIED",
  REJECTED = "REJECTED",
}

export enum InviteStatus {
  PENDING = "PENDING",
  ACCEPTED = "ACCEPTED",
  DECLINED = "DECLINED",
  EXPIRED = "EXPIRED",
}

export enum LedgerEntryType {
  DEPOSIT = "DEPOSIT",
  LOCK = "LOCK",
  RELEASE = "RELEASE",
  REFUND = "REFUND",
  WITHDRAW = "WITHDRAW",
  FEE = "FEE",
}

export enum DisputeType {
  VERIFICATION_ERROR = "VERIFICATION_ERROR",
  REQUIREMENT_MISMATCH = "REQUIREMENT_MISMATCH",
  SCOPE_CHANGE = "SCOPE_CHANGE",
  BAD_FAITH = "BAD_FAITH",
  FRAUD = "FRAUD",
  PROCESS_BREACH = "PROCESS_BREACH",
  SECURITY = "SECURITY",
}