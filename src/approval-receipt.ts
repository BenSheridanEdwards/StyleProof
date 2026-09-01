import { createHash } from 'node:crypto';
import { types } from 'node:util';

export type ApprovalReceiptInput = {
  headSha: string;
  baseSha: string;
  baseManifestDigest: string;
  headManifestDigest: string;
  releaseConfidenceDigest: string;
  policyDigest: string;
  producer: { name: 'styleproof'; version: string };
  statusContext: string;
  trustState: 'STYLE_REVIEW_REQUIRED';
};

export class StyleProofApprovalReceiptError extends Error {
  constructor() {
    super('StyleProof approval receipt is invalid');
    this.name = 'StyleProofApprovalReceiptError';
  }
}

const RECEIPT_FIELDS = new Set([
  'headSha',
  'baseSha',
  'baseManifestDigest',
  'headManifestDigest',
  'releaseConfidenceDigest',
  'policyDigest',
  'producer',
  'statusContext',
  'trustState',
]);
const PRODUCER_FIELDS = new Set(['name', 'version']);
const GIT_SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;
const STATUS_CONTEXT = /^[A-Za-z0-9][A-Za-z0-9 ._:/-]{0,99}$/;

function closedRecord(value: unknown, fields: Set<string>): Record<string, unknown> {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || types.isProxy(value)) {
      throw new StyleProofApprovalReceiptError();
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new StyleProofApprovalReceiptError();
    const keys = Reflect.ownKeys(value);
    if (keys.length !== fields.size || keys.some((key) => typeof key !== 'string' || !fields.has(key))) {
      throw new StyleProofApprovalReceiptError();
    }
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || descriptor.enumerable !== true || !('value' in descriptor)) {
        throw new StyleProofApprovalReceiptError();
      }
    }
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof StyleProofApprovalReceiptError) throw error;
    throw new StyleProofApprovalReceiptError();
  }
}

function exactString(value: unknown, pattern: RegExp): string {
  if (typeof value !== 'string' || !pattern.test(value)) throw new StyleProofApprovalReceiptError();
  return value;
}

export function digestApprovalReceipt(value: unknown): string {
  const receipt = closedRecord(value, RECEIPT_FIELDS);
  const producer = closedRecord(receipt.producer, PRODUCER_FIELDS);
  if (producer.name !== 'styleproof') throw new StyleProofApprovalReceiptError();
  if (receipt.trustState !== 'STYLE_REVIEW_REQUIRED') throw new StyleProofApprovalReceiptError();

  const canonical = {
    kind: 'styleproof.approval-receipt',
    version: 1,
    headSha: exactString(receipt.headSha, GIT_SHA),
    baseSha: exactString(receipt.baseSha, GIT_SHA),
    baseManifestDigest: exactString(receipt.baseManifestDigest, SHA256),
    headManifestDigest: exactString(receipt.headManifestDigest, SHA256),
    releaseConfidenceDigest: exactString(receipt.releaseConfidenceDigest, SHA256),
    policyDigest: exactString(receipt.policyDigest, SHA256),
    producer: {
      name: 'styleproof',
      version: exactString(producer.version, VERSION),
    },
    statusContext: exactString(receipt.statusContext, STATUS_CONTEXT),
    trustState: 'STYLE_REVIEW_REQUIRED',
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}
