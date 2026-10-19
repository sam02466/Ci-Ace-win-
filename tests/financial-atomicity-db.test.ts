import { afterAll, describe, expect, it } from "vitest";
import { Prisma, PrismaClient } from "@prisma/client";
import { processProviderMutation } from "../src/modules/provider-transactions/provider.service.js";
import { ensureWallet } from "../src/modules/wallet/wallet.service.js";

const databaseUrl = process.env.DATABASE_URL;
const enabled = Boolean(databaseUrl && process.env.RUN_DB_TESTS === "1");
const describeDb = enabled ? describe : describe.skip;

const prisma = enabled ? new PrismaClient() : null;

describeDb("financial atomicity database integration", () => {
  const marker = `atomicity-${Date.now()}-${Math.random()
    .toString(16)
    .slice(2)}`;

  let userId: string;

  afterAll(async () => {
    if (!prisma || !userId) {
      if (prisma) await prisma.$disconnect();
      return;
    }

    const wallets = await prisma.wallet.findMany({
      where: { userId },
      select: { id: true },
    });

    const walletIds = wallets.map((wallet) => wallet.id);

    if (walletIds.length) {
      await prisma.ledgerEntry.deleteMany({
        where: { walletId: { in: walletIds } },
      });

      await prisma.providerTransaction.deleteMany({
        where: { walletId: { in: walletIds } },
      });

      await prisma.financialTransaction.deleteMany({
        where: { walletId: { in: walletIds } },
      });

      await prisma.wallet.deleteMany({
        where: { id: { in: walletIds } },
      });
    }

    await prisma.user.delete({
      where: { id: userId },
    });

    await prisma.$disconnect();
  });

  it("rejects an insufficient-funds debit without creating financial side effects", async () => {
    const user = await prisma!.user.create({
      data: {
        email: `${marker}@example.test`,
        status: "ACTIVE",
      },
    });

    userId = user.id;

    const wallet = await prisma!.wallet.create({
      data: {
        userId,
        currency: "USD",
        balance: new Prisma.Decimal("1.00"),
      },
    });

    const providerTransactionId = `${marker}-insufficient-debit`;

    await expect(
      processProviderMutation({
        provider: "atomicity-test",
        providerTransactionId,
        providerRoundId: `${marker}-round`,
        userId,
        currency: "USD",
        amount: new Prisma.Decimal("1.01"),
        type: "DEBIT",
        requestPayload: {
          test: true,
          phase: "financial-atomicity",
        },
      }),
    ).rejects.toMatchObject({
      code: "INSUFFICIENT_FUNDS",
    });

    const walletAfter = await prisma!.wallet.findUniqueOrThrow({
      where: { id: wallet.id },
    });

    expect(Number(walletAfter.balance)).toBe(1.00);

    const providerTransactionCount =
      await prisma!.providerTransaction.count({
        where: {
          provider: "atomicity-test",
          providerTransactionId,
        },
      });

    expect(providerTransactionCount).toBe(0);

    const financialTransactionCount =
      await prisma!.financialTransaction.count({
        where: {
          walletId: wallet.id,
        },
      });

    expect(financialTransactionCount).toBe(0);

    const ledgerEntryCount = await prisma!.ledgerEntry.count({
      where: {
        walletId: wallet.id,
      },
    });

    expect(ledgerEntryCount).toBe(0);
  });

  it("rejects zero and negative amounts without creating financial side effects", async () => {
    const wallet = await prisma!.wallet.findFirstOrThrow({
      where: {
        userId,
        currency: "USD",
      },
    });

    const startingBalance = new Prisma.Decimal(wallet.balance);

    const invalidAmounts = [
      {
        label: "zero",
        amount: new Prisma.Decimal("0.00"),
      },
      {
        label: "negative",
        amount: new Prisma.Decimal("-1.00"),
      },
    ];

    for (const testCase of invalidAmounts) {
      const providerTransactionId =
        `${marker}-invalid-${testCase.label}`;

      await expect(
        processProviderMutation({
          provider: "atomicity-test",
          providerTransactionId,
          providerRoundId: `${marker}-invalid-round-${testCase.label}`,
          userId,
          currency: "USD",
          amount: testCase.amount,
          type: "DEBIT",
          requestPayload: {
            test: true,
            phase: "financial-atomicity",
            invalidAmount: testCase.label,
          },
        }),
      ).rejects.toThrow();

      const walletAfter = await prisma!.wallet.findUniqueOrThrow({
        where: { id: wallet.id },
      });

      expect(walletAfter.balance.equals(startingBalance)).toBe(true);

      const providerTransactionCount =
        await prisma!.providerTransaction.count({
          where: {
            provider: "atomicity-test",
            providerTransactionId,
          },
        });

      expect(providerTransactionCount).toBe(0);

      const financialTransactionCount =
        await prisma!.financialTransaction.count({
          where: {
            walletId: wallet.id,
          },
        });

      expect(financialTransactionCount).toBe(0);

      const ledgerEntryCount = await prisma!.ledgerEntry.count({
        where: {
          walletId: wallet.id,
        },
      });

      expect(ledgerEntryCount).toBe(0);
    }
  });

  it("processes a duplicate provider transaction idempotently without a second wallet mutation", async () => {
    const user = await prisma!.user.create({
      data: {
        email: `${marker}-duplicate@example.test`,
        status: "ACTIVE",
      },
    });

    const wallet = await prisma!.wallet.create({
      data: {
        userId: user.id,
        currency: "USD",
        balance: new Prisma.Decimal("10.00"),
      },
    });

    const provider = "atomicity-duplicate-test";
    const providerTransactionId = `${marker}-duplicate-debit`;

    const first = await processProviderMutation({
      provider,
      providerTransactionId,
      providerRoundId: `${marker}-duplicate-round`,
      userId: user.id,
      currency: "USD",
      amount: new Prisma.Decimal("2.00"),
      type: "DEBIT",
      requestPayload: {
        test: true,
        phase: "financial-atomicity",
        attempt: 1,
      },
    });

    expect(first.idempotent).toBe(false);

    const walletAfterFirst = await prisma!.wallet.findUniqueOrThrow({
      where: { id: wallet.id },
    });

    expect(walletAfterFirst.balance.equals(new Prisma.Decimal("8.00"))).toBe(
      true,
    );

    const second = await processProviderMutation({
      provider,
      providerTransactionId,
      providerRoundId: `${marker}-duplicate-round`,
      userId: user.id,
      currency: "USD",
      amount: new Prisma.Decimal("2.00"),
      type: "DEBIT",
      requestPayload: {
        test: true,
        phase: "financial-atomicity",
        attempt: 2,
      },
    });

    expect(second.idempotent).toBe(true);

    const walletAfterSecond = await prisma!.wallet.findUniqueOrThrow({
      where: { id: wallet.id },
    });

    expect(walletAfterSecond.balance.equals(new Prisma.Decimal("8.00"))).toBe(
      true,
    );

    const providerTransactionCount =
      await prisma!.providerTransaction.count({
        where: {
          provider,
          providerTransactionId,
        },
      });

    expect(providerTransactionCount).toBe(1);

    const financialTransactionCount =
      await prisma!.financialTransaction.count({
        where: {
          walletId: wallet.id,
          reference: `${provider}:${providerTransactionId}`,
        },
      });

    expect(financialTransactionCount).toBe(1);

    const ledgerEntryCount = await prisma!.ledgerEntry.count({
      where: {
        walletId: wallet.id,
        reference: `${provider}:${providerTransactionId}`,
      },
    });

    expect(ledgerEntryCount).toBe(1);

    await prisma!.ledgerEntry.deleteMany({
      where: { walletId: wallet.id },
    });

    await prisma!.providerTransaction.deleteMany({
      where: { walletId: wallet.id },
    });

    await prisma!.financialTransaction.deleteMany({
      where: { walletId: wallet.id },
    });

    await prisma!.wallet.delete({
      where: { id: wallet.id },
    });

    await prisma!.user.delete({
      where: { id: user.id },
    });
  });

  it("rejects failed rollbacks without creating financial side effects", async () => {
    const user = await prisma!.user.create({
      data: {
        email: `${marker}-rollback@example.test`,
        status: "ACTIVE",
      },
    });

    const wallet = await prisma!.wallet.create({
      data: {
        userId: user.id,
        currency: "USD",
        balance: new Prisma.Decimal("10.00"),
      },
    });

    const provider = "atomicity-rollback-test";

    const debitTransactionId = `${marker}-rollback-debit`;

    // Create a legitimate debit first.
    const debit = await processProviderMutation({
      provider,
      providerTransactionId: debitTransactionId,
      providerRoundId: `${marker}-rollback-round`,
      userId: user.id,
      currency: "USD",
      amount: new Prisma.Decimal("3.00"),
      type: "DEBIT",
      requestPayload: {
        test: true,
        phase: "financial-atomicity",
      },
    });

    expect(debit.idempotent).toBe(false);

    const walletAfterDebit = await prisma!.wallet.findUniqueOrThrow({
      where: { id: wallet.id },
    });

    expect(
      walletAfterDebit.balance.equals(new Prisma.Decimal("7.00")),
    ).toBe(true);

    // Snapshot the number of financial records after the legitimate debit.
    const providerTransactionsBefore =
      await prisma!.providerTransaction.count({
        where: {
          walletId: wallet.id,
        },
      });

    const financialTransactionsBefore =
      await prisma!.financialTransaction.count({
        where: {
          walletId: wallet.id,
        },
      });

    const ledgerEntriesBefore = await prisma!.ledgerEntry.count({
      where: {
        walletId: wallet.id,
      },
    });

    expect(providerTransactionsBefore).toBe(1);
    expect(financialTransactionsBefore).toBe(1);
    expect(ledgerEntriesBefore).toBe(1);

    // ------------------------------------------------------------
    // Failure 1: rollback references a nonexistent original
    // ------------------------------------------------------------

    const missingOriginalId =
      `${marker}-nonexistent-original`;

    const missingRollbackId =
      `${marker}-rollback-missing-original`;

    await expect(
      processProviderMutation({
        provider,
        providerTransactionId: missingRollbackId,
        providerRoundId: `${marker}-rollback-round`,
        userId: user.id,
        currency: "USD",
        amount: new Prisma.Decimal("3.00"),
        type: "ROLLBACK",
        originalProviderTransactionId: missingOriginalId,
        requestPayload: {
          test: true,
          phase: "financial-atomicity",
          failure: "missing-original",
        },
      }),
    ).rejects.toMatchObject({
      code: "ORIGINAL_TRANSACTION_NOT_FOUND",
    });

    const walletAfterMissingOriginal =
      await prisma!.wallet.findUniqueOrThrow({
        where: { id: wallet.id },
      });

    expect(
      walletAfterMissingOriginal.balance.equals(
        new Prisma.Decimal("7.00"),
      ),
    ).toBe(true);

    const missingRollbackProviderCount =
      await prisma!.providerTransaction.count({
        where: {
          provider,
          providerTransactionId: missingRollbackId,
        },
      });

    expect(missingRollbackProviderCount).toBe(0);

    const providerTransactionsAfterMissing =
      await prisma!.providerTransaction.count({
        where: {
          walletId: wallet.id,
        },
      });

    const financialTransactionsAfterMissing =
      await prisma!.financialTransaction.count({
        where: {
          walletId: wallet.id,
        },
      });

    const ledgerEntriesAfterMissing =
      await prisma!.ledgerEntry.count({
        where: {
          walletId: wallet.id,
        },
      });

    expect(providerTransactionsAfterMissing).toBe(
      providerTransactionsBefore,
    );

    expect(financialTransactionsAfterMissing).toBe(
      financialTransactionsBefore,
    );

    expect(ledgerEntriesAfterMissing).toBe(
      ledgerEntriesBefore,
    );

    // ------------------------------------------------------------
    // Failure 2: rollback amount exceeds original debit
    // ------------------------------------------------------------

    const oversizedRollbackId =
      `${marker}-rollback-oversized`;

    await expect(
      processProviderMutation({
        provider,
        providerTransactionId: oversizedRollbackId,
        providerRoundId: `${marker}-rollback-round`,
        userId: user.id,
        currency: "USD",
        amount: new Prisma.Decimal("3.01"),
        type: "ROLLBACK",
        originalProviderTransactionId: debitTransactionId,
        requestPayload: {
          test: true,
          phase: "financial-atomicity",
          failure: "rollback-too-large",
        },
      }),
    ).rejects.toMatchObject({
      code: "ROLLBACK_AMOUNT_TOO_LARGE",
    });

    const walletAfterOversizedRollback =
      await prisma!.wallet.findUniqueOrThrow({
        where: { id: wallet.id },
      });

    expect(
      walletAfterOversizedRollback.balance.equals(
        new Prisma.Decimal("7.00"),
      ),
    ).toBe(true);

    const oversizedRollbackProviderCount =
      await prisma!.providerTransaction.count({
        where: {
          provider,
          providerTransactionId: oversizedRollbackId,
        },
      });

    expect(oversizedRollbackProviderCount).toBe(0);

    const providerTransactionsAfterOversized =
      await prisma!.providerTransaction.count({
        where: {
          walletId: wallet.id,
        },
      });

    const financialTransactionsAfterOversized =
      await prisma!.financialTransaction.count({
        where: {
          walletId: wallet.id,
        },
      });

    const ledgerEntriesAfterOversized =
      await prisma!.ledgerEntry.count({
        where: {
          walletId: wallet.id,
        },
      });

    expect(providerTransactionsAfterOversized).toBe(
      providerTransactionsBefore,
    );

    expect(financialTransactionsAfterOversized).toBe(
      financialTransactionsBefore,
    );

    expect(ledgerEntriesAfterOversized).toBe(
      ledgerEntriesBefore,
    );

    // Cleanup this test's separate user.
    await prisma!.ledgerEntry.deleteMany({
      where: { walletId: wallet.id },
    });

    await prisma!.providerTransaction.deleteMany({
      where: { walletId: wallet.id },
    });

    await prisma!.financialTransaction.deleteMany({
      where: { walletId: wallet.id },
    });

    await prisma!.wallet.delete({
      where: { id: wallet.id },
    });

    await prisma!.user.delete({
      where: { id: user.id },
    });
  });

  it("rolls back the entire database transaction when a later operation fails", async () => {
    const user = await prisma!.user.create({
      data: {
        email: `${marker}-transaction-failure@example.test`,
        status: "ACTIVE",
      },
    });

    const wallet = await prisma!.wallet.create({
      data: {
        userId: user.id,
        currency: "USD",
        balance: new Prisma.Decimal("10.00"),
      },
    });

    await expect(
      prisma!.$transaction(async (tx) => {
        // Step 1: perform a legitimate wallet mutation.
        await tx.wallet.update({
          where: { id: wallet.id },
          data: {
            balance: new Prisma.Decimal("8.00"),
          },
        });

        // Step 2: deliberately create an invalid financial transaction.
        // The fake walletId violates the FinancialTransaction -> Wallet FK.
        await tx.financialTransaction.create({
          data: {
            walletId: "00000000-0000-0000-0000-000000000000",
            userId: user.id,
            type: "BET",
            amount: new Prisma.Decimal("2.00"),
            currency: "USD",
            status: "SUCCESS",
            reference: `${marker}-intentional-failure`,
          },
        });
      }),
    ).rejects.toThrow();

    // The wallet update must have been rolled back.
    const walletAfter = await prisma!.wallet.findUniqueOrThrow({
      where: { id: wallet.id },
    });

    expect(
      walletAfter.balance.equals(new Prisma.Decimal("10.00")),
    ).toBe(true);

    // No financial transaction should have survived.
    const financialTransactionCount =
      await prisma!.financialTransaction.count({
        where: {
          walletId: wallet.id,
        },
      });

    expect(financialTransactionCount).toBe(0);

    // No ledger entry should have survived.
    const ledgerEntryCount =
      await prisma!.ledgerEntry.count({
        where: {
          walletId: wallet.id,
        },
      });

    expect(ledgerEntryCount).toBe(0);

    // The intentionally failed transaction must not exist anywhere.
    const failedReferenceCount =
      await prisma!.financialTransaction.count({
        where: {
          reference: `${marker}-intentional-failure`,
        },
      });

    expect(failedReferenceCount).toBe(0);

    // Cleanup this test's separate user.
    await prisma!.wallet.delete({
      where: { id: wallet.id },
    });

    await prisma!.user.delete({
      where: { id: user.id },
    });
  });

  it("maintains consistent ledger invariants across multiple financial movements", async () => {
    const user = await prisma!.user.create({
      data: {
        email: `${marker}-ledger@example.test`,
        status: "ACTIVE",
      },
    });

    const wallet = await prisma!.wallet.create({
      data: {
        userId: user.id,
        currency: "USD",
        balance: new Prisma.Decimal("10.00"),
      },
    });

    const provider = "atomicity-ledger-test";

    // ------------------------------------------------------------
    // 1. DEBIT $2.50
    // $10.00 -> $7.50
    // ------------------------------------------------------------

    const debitOneId = `${marker}-ledger-debit-one`;

    await processProviderMutation({
      provider,
      providerTransactionId: debitOneId,
      providerRoundId: `${marker}-ledger-round-1`,
      userId: user.id,
      currency: "USD",
      amount: new Prisma.Decimal("2.50"),
      type: "DEBIT",
      requestPayload: {
        test: true,
        phase: "financial-atomicity",
        step: 1,
      },
    });

    // ------------------------------------------------------------
    // 2. CREDIT $5.00
    // $7.50 -> $12.50
    // ------------------------------------------------------------

    const creditId = `${marker}-ledger-credit`;

    await processProviderMutation({
      provider,
      providerTransactionId: creditId,
      providerRoundId: `${marker}-ledger-round-2`,
      userId: user.id,
      currency: "USD",
      amount: new Prisma.Decimal("5.00"),
      type: "CREDIT",
      requestPayload: {
        test: true,
        phase: "financial-atomicity",
        step: 2,
      },
    });

    // ------------------------------------------------------------
    // 3. DEBIT $3.25
    // $12.50 -> $9.25
    // ------------------------------------------------------------

    const debitTwoId = `${marker}-ledger-debit-two`;

    await processProviderMutation({
      provider,
      providerTransactionId: debitTwoId,
      providerRoundId: `${marker}-ledger-round-3`,
      userId: user.id,
      currency: "USD",
      amount: new Prisma.Decimal("3.25"),
      type: "DEBIT",
      requestPayload: {
        test: true,
        phase: "financial-atomicity",
        step: 3,
      },
    });

    // ------------------------------------------------------------
    // 4. ROLLBACK the second debit
    // $9.25 -> $12.50
    // ------------------------------------------------------------

const rollbackId = `${marker}-ledger-rollback`;

    await processProviderMutation({
      provider,
      providerTransactionId: rollbackId,
      providerRoundId: `${marker}-ledger-round-3`,
      userId: user.id,
      currency: "USD",
      amount: new Prisma.Decimal("3.25"),
      type: "ROLLBACK",
      originalProviderTransactionId: debitTwoId,
      requestPayload: {
        test: true,
        phase: "financial-atomicity",
        step: 4,
      },
    });

    // ------------------------------------------------------------
    // Verify final wallet balance
    // ------------------------------------------------------------

    const walletAfter = await prisma!.wallet.findUniqueOrThrow({
      where: { id: wallet.id },
    });

    expect(
      walletAfter.balance.equals(new Prisma.Decimal("12.50")),
    ).toBe(true);

    // ------------------------------------------------------------
    // Fetch ledger in chronological order
    // ------------------------------------------------------------

    const ledgerEntries = await prisma!.ledgerEntry.findMany({
      where: {
        walletId: wallet.id,
      },
      orderBy: [
        { createdAt: "asc" },
        { id: "asc" },
      ],
    });

    expect(ledgerEntries).toHaveLength(4);

    // ------------------------------------------------------------
    // Verify exact ledger sequence
    // ------------------------------------------------------------

 const expectedLedger = [
  { type: "BET", amount: "-2.5", before: "10", after: "7.5", reference: `${provider}:${debitOneId}` },
  { type: "WIN", amount: "5", before: "7.5", after: "12.5", reference: `${provider}:${creditId}` },
  { type: "BET", amount: "-3.25", before: "12.5", after: "9.25", reference: `${provider}:${debitTwoId}` },
  { type: "ROLLBACK", amount: "3.25", before: "9.25", after: "12.5", reference: `${provider}:${rollbackId}` },
];

for (let i = 0; i < expectedLedger.length; i++) {
  const actual = ledgerEntries[i];
  const expected = expectedLedger[i];

  expect(actual.type).toBe(expected.type);

expect(
  actual.amount.equals(new Prisma.Decimal(expected.amount)),
).toBe(true);

expect(
  actual.balanceBefore.equals(new Prisma.Decimal(expected.before)),
).toBe(true);

expect(
  actual.balanceAfter.equals(new Prisma.Decimal(expected.after)),
).toBe(true);
  
  expect(actual.currency).toBe("USD");
  expect(actual.reference).toBe(expected.reference);
}
    
    // ------------------------------------------------------------
    // Verify the ledger balance chain
    // ------------------------------------------------------------

    for (let i = 1; i < ledgerEntries.length; i++) {
      expect(
        ledgerEntries[i].balanceBefore.equals(
          ledgerEntries[i - 1].balanceAfter,
        ),
      ).toBe(true);
    }

    // ------------------------------------------------------------
    // Verify the final ledger balance equals wallet balance
    // ------------------------------------------------------------

    const finalLedgerEntry =
      ledgerEntries[ledgerEntries.length - 1];

    expect(
      finalLedgerEntry.balanceAfter.equals(walletAfter.balance),
    ).toBe(true);

    // ------------------------------------------------------------
    // Verify financial transactions
    // ------------------------------------------------------------

    const financialTransactions =
      await prisma!.financialTransaction.findMany({
        where: {
          walletId: wallet.id,
        },
        orderBy: [
          { createdAt: "asc" },
          { id: "asc" },
        ],
      });

    expect(financialTransactions).toHaveLength(4);

    const financialTypes = financialTransactions.map(
      (transaction) => transaction.type,
    );

    expect(financialTypes).toEqual([
      "BET",
      "WIN",
      "BET",
      "ROLLBACK",
    ]);

    // Every financial transaction must have the same
    // currency and a positive amount.
    for (const transaction of financialTransactions) {
      expect(transaction.currency).toBe("USD");
      expect(
        new Prisma.Decimal(transaction.amount).gt(
          new Prisma.Decimal("0"),
        ),
      ).toBe(true);
      expect(transaction.status).toBe("SUCCESS");
    }

    // ------------------------------------------------------------
    // Verify provider transactions
    // ------------------------------------------------------------

    const providerTransactions =
      await prisma!.providerTransaction.findMany({
        where: {
          walletId: wallet.id,
        },
        orderBy: [
          { createdAt: "asc" },
          { id: "asc" },
        ],
      });

    expect(providerTransactions).toHaveLength(4);

    expect(
      providerTransactions.map(
        (transaction) => transaction.providerTransactionId,
      ),
    ).toEqual([
      debitOneId,
      creditId,
      debitTwoId,
      rollbackId,
    ]);

    expect(
      providerTransactions.map(
        (transaction) => transaction.type,
      ),
    ).toEqual([
      "DEBIT",
      "CREDIT",
      "DEBIT",
      "ROLLBACK",
    ]);

    // The rollback must point back to the second debit.
    const rollbackTransaction =
      providerTransactions.find(
        (transaction) =>
          transaction.providerTransactionId === rollbackId,
      );

    expect(rollbackTransaction).toBeDefined();

    expect(
      rollbackTransaction!.originalProviderTransactionId,
    ).toBe(debitTwoId);

    // ------------------------------------------------------------
    // Verify every provider transaction has a financial
    // transaction linkage.
    // ------------------------------------------------------------

    for (const providerTransaction of providerTransactions) {
      expect(
        providerTransaction.financialTransactionId,
      ).toBeTruthy();
    }

    // ------------------------------------------------------------
    // Cleanup this test's separate user.
    // ------------------------------------------------------------

    await prisma!.ledgerEntry.deleteMany({
      where: { walletId: wallet.id },
    });

    await prisma!.providerTransaction.deleteMany({
      where: { walletId: wallet.id },
    });

    await prisma!.financialTransaction.deleteMany({
      where: { walletId: wallet.id },
    });

    await prisma!.wallet.delete({
      where: { id: wallet.id },
    });

    await prisma!.user.delete({
      where: { id: user.id },
    });
  });

it("preserves provider-to-financial-to-ledger linkage integrity", async () => {
  const marker = `atomicity-linkage-${Date.now()}-${Math.random()
    .toString(16)
    .slice(2)}`;

const user = await prisma.user.create({
  data: {
    email: `${marker}@example.com`,
    status: "ACTIVE",
  },
});

  const wallet = await ensureWallet(user.id, "USD");

  await prisma.wallet.update({
    where: { id: wallet.id },
    data: { balance: new Prisma.Decimal("10.00") },
  });

  const provider = "atomicity-linkage-test";
  const providerTransactionId = `${marker}-debit`;

  const result = await processProviderMutation({
    provider,
    providerTransactionId,
    providerRoundId: `${marker}-round`,
    userId: user.id,
    currency: "USD",
    amount: new Prisma.Decimal("2.50"),
    type: "DEBIT",
    requestPayload: {
      test: marker,
    },
  });

  expect(result.idempotent).toBe(false);

  const providerTransaction =
    await prisma.providerTransaction.findUniqueOrThrow({
      where: {
        provider_providerTransactionId: {
          provider,
          providerTransactionId,
        },
      },
    });

  const financialTransaction =
    await prisma.financialTransaction.findUniqueOrThrow({
      where: {
        id: providerTransaction.financialTransactionId!,
      },
    });

  const ledgerEntry = await prisma.ledgerEntry.findFirstOrThrow({
    where: {
      transactionId: financialTransaction.id,
    },
  });

  const updatedWallet = await prisma.wallet.findUniqueOrThrow({
    where: { id: wallet.id },
  });

  // Provider transaction identity
  expect(providerTransaction.provider).toBe(provider);
  expect(providerTransaction.providerTransactionId).toBe(
    providerTransactionId,
  );
  expect(providerTransaction.type).toBe("DEBIT");

  // Provider → financial transaction
  expect(providerTransaction.financialTransactionId).toBe(
    financialTransaction.id,
  );

  // Provider → wallet/user
  expect(providerTransaction.walletId).toBe(wallet.id);
  expect(providerTransaction.userId).toBe(user.id);
  expect(providerTransaction.currency).toBe("USD");

  // Financial transaction identity
  expect(financialTransaction.walletId).toBe(wallet.id);
  expect(financialTransaction.userId).toBe(user.id);
  expect(financialTransaction.currency).toBe("USD");
  expect(financialTransaction.type).toBe("BET");
  expect(
    financialTransaction.amount.equals(new Prisma.Decimal("2.50")),
  ).toBe(true);

  // Financial → ledger
  expect(ledgerEntry.transactionId).toBe(financialTransaction.id);
  expect(ledgerEntry.walletId).toBe(wallet.id);
  expect(ledgerEntry.currency).toBe("USD");
  expect(ledgerEntry.type).toBe("BET");

  expect(
    ledgerEntry.amount.equals(new Prisma.Decimal("-2.50")),
  ).toBe(true);

  expect(
    ledgerEntry.balanceBefore.equals(new Prisma.Decimal("10.00")),
  ).toBe(true);

  expect(
    ledgerEntry.balanceAfter.equals(new Prisma.Decimal("7.50")),
  ).toBe(true);

  // Final wallet state
  expect(
    updatedWallet.balance.equals(new Prisma.Decimal("7.50")),
  ).toBe(true);

  // Exactly one record at each layer
 await prisma.providerTransaction.deleteMany({
  where: { userId: user.id },
});

await prisma.ledgerEntry.deleteMany({
  where: { walletId: wallet.id },
});

await prisma.financialTransaction.deleteMany({
  where: { userId: user.id },
});

await prisma.wallet.delete({
  where: { id: wallet.id },
});

await prisma.user.delete({
  where: { id: user.id },
  });
});

it("handles concurrent duplicate provider transactions atomically", async () => {
  const marker = `concurrent-duplicate-${Date.now()}-${Math.random()
    .toString(16)
    .slice(2)}`;

  const user = await prisma.user.create({
    data: {
      email: `${marker}@example.com`,
      status: "ACTIVE",
    },
  });

  const wallet = await ensureWallet(user.id, "USD");

  await prisma.wallet.update({
    where: { id: wallet.id },
    data: {
      balance: new Prisma.Decimal("10.00"),
    },
  });

  const providerTransactionId = `${marker}-tx`;

  const mutation = {
    provider: "softaggregator",
    providerTransactionId,
    providerRoundId: `${marker}-round`,
    userId: user.id,
    currency: "USD",
    amount: new Prisma.Decimal("2.50"),
    type: "DEBIT" as const,
    requestPayload: {
      test: "concurrent-duplicate",
    },
  };

  const [resultA, resultB] = await Promise.all([
    processProviderMutation(mutation),
    processProviderMutation(mutation),
  ]);

  const results = [resultA, resultB];

  // Exactly one request must perform the mutation.
  expect(results.filter((r) => r.idempotent === false)).toHaveLength(1);

  // The other request must be recognized as a duplicate.
  expect(results.filter((r) => r.idempotent === true)).toHaveLength(1);

  const finalWallet = await prisma.wallet.findUniqueOrThrow({
    where: { id: wallet.id },
  });

  expect(finalWallet.balance.equals(new Prisma.Decimal("7.50"))).toBe(true);

  const providerTransactions = await prisma.providerTransaction.findMany({
    where: {
      provider: "softaggregator",
      providerTransactionId,
    },
  });

  const financialTransactions = await prisma.financialTransaction.findMany({
    where: {
      userId: user.id,
      reference: `softaggregator:${providerTransactionId}`,
    },
  });

  const ledgerEntries = await prisma.ledgerEntry.findMany({
    where: {
      walletId: wallet.id,
      reference: `softaggregator:${providerTransactionId}`,
    },
  });

  expect(providerTransactions).toHaveLength(1);
  expect(financialTransactions).toHaveLength(1);
  expect(ledgerEntries).toHaveLength(1);

  expect(providerTransactions[0].type).toBe("DEBIT");
  expect(providerTransactions[0].providerTransactionId).toBe(
    providerTransactionId,
  );

  expect(financialTransactions[0].type).toBe("BET");
  expect(financialTransactions[0].amount.equals(new Prisma.Decimal("2.50"))).toBe(
    true,
  );

  expect(ledgerEntries[0].type).toBe("BET");
  expect(ledgerEntries[0].amount.equals(new Prisma.Decimal("-2.50"))).toBe(
    true,
  );

  expect(ledgerEntries[0].balanceBefore.equals(new Prisma.Decimal("10.00"))).toBe(
    true,
  );

  expect(ledgerEntries[0].balanceAfter.equals(new Prisma.Decimal("7.50"))).toBe(
    true,
  );

  // Cleanup in foreign-key-safe order.
  await prisma.providerTransaction.deleteMany({
    where: { userId: user.id },
  });

  await prisma.ledgerEntry.deleteMany({
    where: { walletId: wallet.id },
  });

  await prisma.financialTransaction.deleteMany({
    where: { userId: user.id },
  });

  await prisma.wallet.delete({
    where: { id: wallet.id },
  });

  await prisma.user.delete({
    where: { id: user.id },
  });
});

});