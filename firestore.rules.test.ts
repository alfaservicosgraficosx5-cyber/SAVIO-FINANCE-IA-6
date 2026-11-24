import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const ROOT_DIR = __dirname;

function readRootFile(relPath: string): string {
  return fs.readFileSync(path.join(ROOT_DIR, relPath), 'utf-8');
}

describe('Auditoria Estática & Invariantes de Segurança — firestore.rules', () => {
  const rulesText = readRootFile('firestore.rules');
  const blueprint = JSON.parse(readRootFile('firebase-blueprint.json')) as {
    firestore: Record<string, unknown>;
    entities: Record<string, { required?: string[] }>;
  };
  const securitySpec = readRootFile('security_spec.md');

  it('inicia com negação padrão explícita e não contém regras permissivas abertas', () => {
    expect(rulesText).toContain("rules_version = '2';");
    expect(rulesText).toMatch(/match \/\{document=\*\*\}[\s\S]*allow read, write: if false;/);
    expect(rulesText).not.toMatch(/allow\s+(read|write|get|list|create|update|delete)\s*:\s*if\s+true\s*;/);
  });

  it('bloqueia listagem do diretório /users e exige email_verified == true para todas as escritas', () => {
    expect(rulesText).toContain('allow list: if false;');
    expect(rulesText).toContain('request.auth.token.email_verified == true');
    expect(rulesText).toContain('request.auth != null;');
    expect(rulesText).toContain('isSignedIn() && request.auth.uid == uid');
    expect(rulesText).toContain('resource.data.ownerUid == request.auth.uid');
  });

  it('protege imutabilidade de ownerUid/id/createdAt e mantém backups imutáveis após criação', () => {
    expect(rulesText).toContain('preservesImmutableOwnerAndCreated');
    expect(rulesText).toContain('request.resource.data.ownerUid == resource.data.ownerUid');
    expect(rulesText).toContain('request.resource.data.createdAt == resource.data.createdAt');
    expect(rulesText).toMatch(/match \/backups\/\{backupId\}[\s\S]*allow update: if false;/);
  });

  it('valida IDs de documento, enums críticos, limites de tamanho e rejeita chaves desconhecidas (hasOnly/hasAll)', () => {
    expect(rulesText).toContain('function isValidId(id)');
    expect(rulesText).toContain("!(id in ['.', '..'])");
    expect(rulesText).toContain('data.keys().hasAll(');
    expect(rulesText).toContain('data.keys().hasOnly(');
    expect(rulesText).toContain('isBoundedStr(data.payloadJson, 2, 850000)');
    expect(rulesText).toContain("val is string && (val == 'CPF' || val == 'CNPJ')");
    expect(rulesText).toContain('isEntityScopePair(data.entityId)');
  });

  it('cobre todas as 13 coleções especificadas em firebase-blueprint.json e documenta a matriz Dirty Dozen', () => {
    const collections = [
      'users/{uid}',
      'accounts/{accountId}',
      'transactions/{txId}',
      'creditCards/{cardId}',
      'boletos/{boletoId}',
      'debts/{debtId}',
      'assets/{assetId}',
      'documents/{docId}',
      'salaries/{salaryDocId}',
      'budgets/{budgetId}',
      'categoryRules/{ruleId}',
      'settings/{settingId}',
      'backups/{backupId}',
    ];

    expect(Object.keys(blueprint.firestore)).toHaveLength(13);
    for (const colMatch of collections) {
      expect(rulesText, `Coleção ausente nas regras: ${colMatch}`).toContain(colMatch);
    }

    expect(securitySpec).toContain('Dirty Dozen');
    expect(securitySpec).toContain('DENIED');

    // Schema synchronicity for ETAPA 1–10 and transfer/import reconciliation fields
    for (const field of [
      'isCardBillPayment',
      'incomeOrigin',
      'incomeSourceName',
      'installmentCurrent',
      'installmentTotal',
      'interestRate',
      'totalInstallments',
      'paidInstallments',
      'nextDueDate',
      'destinationAccountId',
      'crossEntityNature',
      'importBatchId',
      'notes',
    ]) {
      expect(rulesText, `Campo ausente em firestore.rules: ${field}`).toContain(field);
    }
  });

  it('garante que serializeTransactionDoc e serializeAccountDoc não emitem chaves fora da allowlist de firestore.rules', async () => {
    const { serializeTransactionDoc, serializeAccountDoc } = await import(
      './src/services/cloudSyncService'
    );

    const extractList = (fnName: string, method: 'hasAll' | 'hasOnly'): string[] => {
      const fnMatch = rulesText.match(
        new RegExp(`function ${fnName}\\([\\s\\S]*?${method}\\(\\[([\\s\\S]*?)\\]\\)`)
      );
      expect(fnMatch, `Não foi possível extrair ${method} de ${fnName}`).not.toBeNull();
      return Array.from(fnMatch![1].matchAll(/'([^']+)'/g)).map((m) => m[1]);
    };

    const txRequired = extractList('isValidTransaction', 'hasAll');
    const txAllowed = new Set(extractList('isValidTransaction', 'hasOnly'));

    const serializedTx = serializeTransactionDoc(
      'uid-test-1',
      {
        id: 'tx-1',
        entityId: 'CNPJ',
        accountId: 'acc-bb-pj',
        date: '2026-11-23',
        description: 'Transferência entre contas',
        originalDescription: 'PIX RECEBIDO',
        category: 'Transferência',
        account: 'Banco do Brasil · Conta PJ',
        amount: 250.5,
        amountCents: 25050 as never,
        direction: 'EXPENSE',
        status: 'CONFIRMED',
        origin: 'IMPORT',
        isInternalTransfer: true,
        isCardBillPayment: false,
        incomeOrigin: 'mei',
        incomeSourceName: 'MEI',
        incomeSourceId: 'src-1',
        installmentCurrent: 1,
        installmentTotal: 3,
        confidenceScore: 0.95,
        reviewRequired: false,
        operationType: 'PIX',
        counterparty: 'Fornecedor',
        externalId: 'doc-12345',
        salaryRecordId: 'sal-1',
        transferId: 'trf-1',
        destinationAccountId: 'acc-nubank-pf',
        crossEntityNature: 'RETIRADA_SOCIO',
        importBatchId: 'batch-bb-2026-11',
        notes: 'Retirada mensal para conta PF',
        idempotencyKey: 'idem-1',
        reversedTransactionId: 'tx-0',
        reversalTransactionId: 'tx-2',
        cancelledAt: '2026-11-23T10:00:00.000Z',
        cancellationReason: 'Teste',
        purchaseDate: '2026-11-20',
        postingDate: '2026-11-21',
        billingCycleYm: '2026-11',
        billingClosingDate: '2026-11-25',
        billingDueDate: '2026-12-02',
        cardEntryKind: 'PURCHASE',
        installmentGroupId: 'grp-1',
      },
      '2026-11-23T12:00:00.000Z'
    );

    for (const reqKey of txRequired) {
      expect(serializedTx, `Campo obrigatório ausente em serializeTransactionDoc: ${reqKey}`).toHaveProperty(reqKey);
    }
    for (const key of Object.keys(serializedTx)) {
      expect(txAllowed.has(key), `Campo não permitido em firestore.rules (Transaction): ${key}`).toBe(true);
    }

    const accRequired = extractList('isValidAccount', 'hasAll');
    const accAllowed = new Set(extractList('isValidAccount', 'hasOnly'));
    const serializedAcc = serializeAccountDoc(
      'uid-test-1',
      {
        id: 'acc-bb-pj',
        entityId: 'CNPJ',
        institutionName: 'Banco do Brasil',
        bankCode: '001',
        accountName: 'Conta PJ',
        accountType: 'business',
        openingBalance: 100,
        balance: 500,
        archived: false,
        linkedGoogleSheet: {
          spreadsheetId: 'sheet-123',
          sheetTabName: 'Extrato',
          autoSyncOnLoad: true,
        },
      },
      '2026-11-23T12:00:00.000Z'
    );

    for (const reqKey of accRequired) {
      expect(serializedAcc, `Campo obrigatório ausente em serializeAccountDoc: ${reqKey}`).toHaveProperty(reqKey);
    }
    for (const key of Object.keys(serializedAcc)) {
      expect(accAllowed.has(key), `Campo não permitido em firestore.rules (Account): ${key}`).toBe(true);
    }
  });
});
