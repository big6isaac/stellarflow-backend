import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import {
  TreasuryGovernanceTimelockAuditExporter,
  DecodedQueuedAction,
} from "../src/services/governanceTimelockAuditExporter";
import { xdr, Address, Keypair } from "@stellar/stellar-sdk";
import prisma from "../src/lib/prisma";

describe("TreasuryGovernanceTimelockAuditExporter (Issue #1235)", () => {
  let exporter: TreasuryGovernanceTimelockAuditExporter;
  let mockS3Send: jest.Mock<any>;

  beforeEach(() => {
    mockS3Send = jest.fn(async () => ({}));
  });

  afterEach(() => {
    if (exporter) {
      exporter.stop();
    }
    jest.clearAllMocks();
  });

  describe("XDR Parameter Payload Decoding", () => {
    beforeEach(() => {
      exporter = new TreasuryGovernanceTimelockAuditExporter({
        s3Client: { send: mockS3Send },
      });
    });

    it("should accurately decode various ScVal types (symbols, numbers, addresses, maps, vecs)", () => {
      // 1. Symbol
      const symVal = xdr.ScVal.scvSymbol("transfer_yield");
      expect(exporter.decodeScVal(symVal)).toBe("transfer_yield");

      // 2. U32 and U64
      const u32Val = xdr.ScVal.scvU32(100);
      expect(exporter.decodeScVal(u32Val)).toBe(100);

      const u64Val = xdr.ScVal.scvU64(new xdr.Uint64([10, 20]));
      expect(typeof exporter.decodeScVal(u64Val)).toBe("string");

      // 3. Boolean and Void
      expect(exporter.decodeScVal(xdr.ScVal.scvBool(true))).toBe(true);
      expect(exporter.decodeScVal(xdr.ScVal.scvVoid())).toBeNull();

      // 4. Address
      const kp = Keypair.random();
      const addrScVal = Address.fromString(kp.publicKey()).toScVal();
      expect(exporter.decodeScVal(addrScVal)).toBe(kp.publicKey());

      // 5. ScMap
      const mapVal = xdr.ScVal.scvMap([
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol("recipient"),
          val: Address.fromString(kp.publicKey()).toScVal(),
        }),
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol("amount"),
          val: xdr.ScVal.scvU32(5000),
        }),
      ]);

      const decodedMap = exporter.decodeScVal(mapVal) as Record<string, unknown>;
      expect(decodedMap["recipient"]).toBe(kp.publicKey());
      expect(decodedMap["amount"]).toBe(5000);

      // 6. ScVec
      const vecVal = xdr.ScVal.scvVec([
        xdr.ScVal.scvSymbol("item1"),
        xdr.ScVal.scvSymbol("item2"),
      ]);
      expect(exporter.decodeScVal(vecVal)).toEqual(["item1", "item2"]);
    });

    it("should decode InvokeContractArgs XDR payload and accurately extract target and function", () => {
      const contractAddress = Address.contract(Buffer.alloc(32, 1));
      const recipientKp = Keypair.random();
      const functionName = "transfer_treasury_yield";
      const args = [
        Address.fromString(recipientKp.publicKey()).toScVal(),
        xdr.ScVal.scvU32(75000),
      ];

      const invokeArgs = new xdr.InvokeContractArgs({
        contractAddress: contractAddress.toScAddress(),
        functionName,
        args,
      });

      const rawBase64 = invokeArgs.toXDR("base64");
      const decoded = exporter.decodeProposalPayload(rawBase64);

      expect(decoded.targetContractId).toBe(contractAddress.toString());
      expect(decoded.targetFunctionName).toBe("transfer_treasury_yield");
      expect(decoded.category).toBe("TREASURY_TRANSFER");
      expect(Array.isArray(decoded.decodedParameters)).toBe(true);
      expect((decoded.decodedParameters as unknown[])[0]).toBe(recipientKp.publicKey());
      expect((decoded.decodedParameters as unknown[])[1]).toBe(75000);
    });

    it("should classify contract upgrades, parameter changes, and access control proposals", () => {
      // Contract upgrade
      const upgradePayload = JSON.stringify({
        targetContract: "CAAAA...",
        functionName: "upgrade_contract",
        args: { new_wasm_hash: "0xabcdef123456" },
      });
      const decodedUpgrade = exporter.decodeProposalPayload(upgradePayload);
      expect(decodedUpgrade.category).toBe("CONTRACT_UPGRADE");

      // Parameter change
      const paramPayload = JSON.stringify({
        targetContract: "CBBBB...",
        functionName: "set_protocol_fee_bps",
        args: { fee_bps: 25 },
      });
      const decodedParam = exporter.decodeProposalPayload(paramPayload);
      expect(decodedParam.category).toBe("PARAMETER_UPDATE");

      // Access control
      const rolePayload = JSON.stringify({
        targetContract: "CCCCC...",
        functionName: "grant_admin_role",
        args: { account: "GB..." },
      });
      const decodedRole = exporter.decodeProposalPayload(rolePayload);
      expect(decodedRole.category).toBe("ACCESS_CONTROL");
    });
  });

  describe("Markdown Transparency Report Generation", () => {
    beforeEach(() => {
      exporter = new TreasuryGovernanceTimelockAuditExporter({
        bucketName: "test-transparency-bucket",
        s3Client: { send: mockS3Send },
      });
    });

    it("should generate a rich Markdown report including executive summary, summary table, and decoded parameters", () => {
      const mockActions: DecodedQueuedAction[] = [
        {
          proposalId: "prop_1042",
          timelockContractId: "CTIMELOCK1234567890",
          executionHash: "0x9a8f4c2e1b3d5f7a0c8e2b4d6f8a1c3e5a7b9c1d3e5f7a9b1c3d5e7f9a1b3c5e",
          targetContractId: "CTREASURY9876543210",
          targetFunctionName: "transfer_treasury_yield",
          category: "TREASURY_TRANSFER",
          decodedParameters: {
            recipient: "GBZ7S3NCLRF72C5S7QYYR44G3F2N3B3L3473D6N7O6476Q5GZ6J44P5B",
            amountUsd: "50000.00",
            asset: "USDC",
          },
          rawPayloadXdr: "AAAA...",
          queuedAt: "2026-10-16T12:00:00.000Z",
          eta: "2026-10-18T12:00:00.000Z",
          status: "QUEUED",
          timeRemainingSeconds: 86400,
        },
      ];

      const report = exporter.generateMarkdownReport(mockActions, 125.5, new Date("2026-10-17T00:00:00.000Z"));

      expect(report).toContain("# 🏛️ StellarFlow Treasury Governance Timelock Queue Audit");
      expect(report).toContain("125.50 ms");
      expect(report).toContain("< 5,000 ms");
      expect(report).toContain("| **prop_1042** |");
      expect(report).toContain("transfer_treasury_yield");
      expect(report).toContain("TREASURY_TRANSFER");
      expect(report).toContain("Action #1: Proposal `prop_1042`");
      expect(report).toContain("50000.00");
      expect(report).toContain("stellar contract invoke");
    });

    it("should handle empty queued actions list gracefully", () => {
      const report = exporter.generateMarkdownReport([], 10.2, new Date("2026-10-17T00:00:00.000Z"));
      expect(report).toContain("No Actions Currently Queued");
      expect(report).toContain("Total Queued Actions**: 0");
    });
  });

  describe("S3 Export & Execution Budget (< 5 seconds)", () => {
    it("should complete full audit export and upload to S3 in under 5 seconds", async () => {
      exporter = new TreasuryGovernanceTimelockAuditExporter({
        bucketName: "stellarflow-transparency-portal",
        s3Client: { send: mockS3Send },
        localExportDir: "exports/timelock-audits-test",
      });

      // Mock queryQueuedProposals to return 3 sample proposals
      jest.spyOn(exporter, "queryQueuedProposals").mockResolvedValue([
        {
          proposalId: "prop_1001",
          timelockContractId: "CTIMELOCK1",
          executionHash: "0x1111111111111111111111111111111111111111111111111111111111111111",
          targetContractId: "CTARGET1",
          targetFunctionName: "transfer_treasury_yield",
          category: "TREASURY_TRANSFER",
          decodedParameters: { recipient: "G1...", amount: "10000" },
          rawPayloadXdr: "AAAA",
          queuedAt: new Date().toISOString(),
          eta: new Date(Date.now() + 86400000).toISOString(),
          status: "QUEUED",
          timeRemainingSeconds: 86400,
        },
        {
          proposalId: "prop_1002",
          timelockContractId: "CTIMELOCK1",
          executionHash: "0x2222222222222222222222222222222222222222222222222222222222222222",
          targetContractId: "CTARGET2",
          targetFunctionName: "upgrade_contract",
          category: "CONTRACT_UPGRADE",
          decodedParameters: { new_wasm_hash: "0xabcd..." },
          rawPayloadXdr: "BBBB",
          queuedAt: new Date().toISOString(),
          eta: new Date(Date.now() + 43200000).toISOString(),
          status: "QUEUED",
          timeRemainingSeconds: 43200,
        },
      ]);

      const result = await exporter.exportAuditReport();

      // Acceptance Criteria: Exporter completes execution in < 5 seconds
      expect(result.executionDurationMs).toBeLessThan(5000);
      expect(result.meetsExecutionBudget).toBe(true);
      expect(result.queuedActionCount).toBe(2);
      expect(result.markdownContent).toBeDefined();

      // Verify S3 uploads (both daily file and latest pointer)
      expect(mockS3Send).toHaveBeenCalledTimes(2);

      const dailyCall = mockS3Send.mock.calls[0]![0] as any;
      expect(dailyCall.input.Bucket).toBe("stellarflow-transparency-portal");
      expect(dailyCall.input.Key).toContain("transparency-reports/daily/timelock_audit_");
      expect(dailyCall.input.ContentType).toBe("text/markdown; charset=utf-8");

      const latestCall = mockS3Send.mock.calls[1]![0] as any;
      expect(latestCall.input.Bucket).toBe("stellarflow-transparency-portal");
      expect(latestCall.input.Key).toBe("transparency-reports/daily/latest.md");
    });
  });

  describe("Lifecycle", () => {
    it("should schedule and cancel daily audit export task cleanly", () => {
      exporter = new TreasuryGovernanceTimelockAuditExporter({
        s3Client: { send: mockS3Send },
      });

      exporter.start();
      expect((exporter as any).scheduledTask).toBeDefined();

      exporter.stop();
      expect((exporter as any).scheduledTask).toBeNull();
    });
  });
});
