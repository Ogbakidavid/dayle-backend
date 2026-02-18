export enum DeliverableType {
  GITHUB = "github",
  FIGMA = "figma",
  PDF = "pdf",
}

export interface BaseRule {
  type: string;
  required: boolean;
  label: string;
}

export interface GitHubRule extends BaseRule {
  type: "github_repo";
  repoUrlPattern?: string;
  branchName?: string;
  prRequired?: boolean;
}

export interface FigmaRule extends BaseRule {
  type: "figma_link";
  fileKeyPattern?: string;
}

export interface PdfRule extends BaseRule {
  type: "pdf_file";
  minPages?: number;
}

export type MilestoneRule = GitHubRule | FigmaRule | PdfRule;

export interface RuleResult {
  ruleId: string;
  label: string;
  passed: boolean;
  message?: string;
}
