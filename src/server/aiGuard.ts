import { z } from 'zod';
import { APP_CATEGORIES, OPERATION_TYPES } from '../types.ts';

export const MAX_BASE64_LENGTH = 21_500_000; // ~15 MB binary limit after base64 expansion

export function sanitizeTextInput(raw: string, maxLen = 1500): string {
  return raw
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .trim()
    .slice(0, maxLen);
}

export const ChatRequestSchema = z.object({
  prompt: z.string().min(1).max(1500),
  summaryContext: z.object({
    period: z.string().max(32),
    scope: z.string().max(32),
    totalBalance: z.number(),
    totalIncome: z.number(),
    totalExpense: z.number(),
    netResult: z.number(),
    cpfIncome: z.number(),
    cpfExpense: z.number(),
    cnpjIncome: z.number(),
    cnpjExpense: z.number(),
    pendingBoletosCount: z.number(),
    pendingBoletosTotal: z.number(),
    overdueBoletosCount: z.number(),
    topExpenseCategories: z.array(z.object({ category: z.string(), total: z.number() })).max(30),
    upcomingBoletos: z
      .array(
        z.object({
          beneficiary: z.string(),
          dueDate: z.string(),
          amount: z.number(),
          entity: z.string(),
        })
      )
      .max(30),
    cardsSummary: z
      .array(
        z.object({
          cardName: z.string(),
          entity: z.string(),
          currentInvoice: z.number(),
          limit: z.number(),
        })
      )
      .max(20),
    totalDebt: z.number(),
  }),
});

export const ParseDocumentSchema = z
  .object({
    textContent: z.string().max(30000).optional(),
    fileName: z.string().max(255).optional(),
    knownAccounts: z
      .array(
        z.object({
          institutionName: z.string().max(120),
          accountName: z.string().max(120),
          entityId: z.enum(['CPF', 'CNPJ']),
        })
      )
      .max(40)
      .optional(),
    fileData: z
      .object({
        mimeType: z.string().regex(/^(application\/pdf|image\/(png|jpeg|jpg|webp))$/),
        base64: z.string().min(10).max(MAX_BASE64_LENGTH),
      })
      .optional(),
  })
  .refine((data) => Boolean(data.textContent || data.fileData), {
    message: 'Envie um arquivo PDF/imagem válido ou texto para leitura.',
  });

export const ExtractedDocItemSchema = z.object({
  description: z.string().min(1),
  amount: z.number().nonnegative(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  category: z.enum(APP_CATEGORIES),
  entity: z.enum(['CPF', 'CNPJ']),
  direction: z.enum(['INCOME', 'EXPENSE']),
  operationType: z.enum(OPERATION_TYPES),
  counterparty: z.string().default(''),
  externalId: z.string().default(''),
  isInternalTransfer: z.boolean().default(false),
  originAccountHint: z.string().default(''),
  destinationAccountHint: z.string().default(''),
  confidence: z.number().min(0).max(1),
  confidenceNote: z.string().optional(),
});

export const ExtractedDocBatchSchema = z.object({
  transactions: z.array(ExtractedDocItemSchema).default([]),
});

export const ParseBoletoRequestSchema = z
  .object({
    linhaDigitavel: z.string().max(120).optional(),
    textContent: z.string().max(15000).optional(),
    fileData: z
      .object({
        mimeType: z.string().regex(/^(application\/pdf|image\/(png|jpeg|jpg|webp))$/),
        base64: z.string().min(10).max(MAX_BASE64_LENGTH),
      })
      .optional(),
  })
  .refine((data) => Boolean(data.linhaDigitavel?.trim() || data.textContent?.trim() || data.fileData), {
    message: 'Informe a linha digitável, texto ou arquivo do boleto.',
  });

export const ExtractedBoletoSchema = z.object({
  beneficiario: z.string().min(1),
  pagador: z.string().min(1),
  instituicao: z.string().min(1),
  linhaDigitavel: z.string().default(''),
  vencimento: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  valorOriginal: z.number().nonnegative(),
  descricao: z.string().min(1),
  entityId: z.enum(['CPF', 'CNPJ']).default('CPF'),
});

export const AuditCardInvoiceRequestSchema = z
  .object({
    fileName: z.string().max(255).optional(),
    textContent: z.string().max(60000).optional(),
    fileData: z
      .object({
        mimeType: z.string().regex(
          /^(application\/pdf|image\/(png|jpeg|jpg|webp)|text\/(csv|plain)|application\/vnd\.ms-excel)$/
        ),
        base64: z.string().min(8).max(MAX_BASE64_LENGTH),
      })
      .optional(),
  })
  .refine((data) => Boolean(data.textContent?.trim() || data.fileData), {
    message: 'Envie um arquivo PDF, imagem (PNG/JPG/WEBP) ou CSV válido para auditoria da fatura.',
  });

export function isOriginAllowedForAi(params: {
  origin?: string;
  referer?: string;
  host?: string;
  forwardedHost?: string;
  nodeEnv?: string;
}): boolean {
  const { origin, referer, host, forwardedHost, nodeEnv = process.env.NODE_ENV } = params;
  const isProd = nodeEnv === 'production';
  const candidate = origin || referer;
  if (!candidate) {
    // Reject anonymous script requests without Origin/Referer in production
    return !isProd;
  }
  try {
    const parsedOrigin = new URL(candidate);
    const originHost = parsedOrigin.host.toLowerCase();
    const appUrlHost = (() => {
      try {
        return process.env.APP_URL ? new URL(process.env.APP_URL).host.toLowerCase() : '';
      } catch {
        return '';
      }
    })();

    const expectedHosts = [host, forwardedHost, appUrlHost]
      .filter(Boolean)
      .flatMap((h) => String(h).split(','))
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean);

    if (expectedHosts.includes(originHost)) return true;
    if (!isProd && (originHost.startsWith('localhost:') || originHost.startsWith('127.0.0.1:'))) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

export class SlidingWindowRateLimiter {
  private hits = new Map<string, number[]>();
  private readonly maxRequests: number;
  private readonly windowMs: number;

  constructor(maxRequests: number, windowMs: number) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
  }

  check(clientId: string, now = Date.now()): { allowed: boolean; retryAfterSec: number; remaining: number } {
    const cutoff = now - this.windowMs;
    const prev = (this.hits.get(clientId) || []).filter((ts) => ts > cutoff);

    if (prev.length >= this.maxRequests) {
      const oldest = prev[0];
      const retryAfterSec = Math.max(1, Math.ceil((oldest + this.windowMs - now) / 1000));
      this.hits.set(clientId, prev);
      return { allowed: false, retryAfterSec, remaining: 0 };
    }

    prev.push(now);
    this.hits.set(clientId, prev);
    return {
      allowed: true,
      retryAfterSec: 0,
      remaining: Math.max(0, this.maxRequests - prev.length),
    };
  }
}

export class AiTimeoutError extends Error {
  constructor(message = 'Tempo limite excedido ao aguardar resposta da Inteligência Artificial.') {
    super(message);
    this.name = 'AiTimeoutError';
  }
}

export async function withTimeout<T>(promise: Promise<T>, timeoutMs = 25000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new AiTimeoutError()), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export type VerifiedInlineMime = 'application/pdf' | 'image/png' | 'image/jpeg' | 'image/webp';

export type VerifiedInlineDataResult =
  | { ok: true; mimeType: VerifiedInlineMime; base64: string; byteLength: number }
  | { ok: false; status: 400 | 422; error: string };

/**
 * Inspects decoded binary magic bytes so Gemini always receives the TRUE payload MIME type
 * (preventing 400 INVALID_ARGUMENT when e.g. a `.png` upload was compressed to JPEG on the client)
 * and rejects encrypted PDFs or corrupted/disguised files before calling upstream AI.
 */
export function resolveVerifiedInlineData(
  fileData: { mimeType: string; base64: string },
  _fileName = ''
): VerifiedInlineDataResult {
  const strippedBase64 = String(fileData.base64 || '')
    .replace(/^data:[^;]+;base64,/i, '')
    .replace(/\s+/g, '');

  if (strippedBase64.length < 8) {
    return {
      ok: false,
      status: 422,
      error: 'Arquivo vazio ou corrompido para leitura visual.',
    };
  }

  const buf = Buffer.from(strippedBase64, 'base64');
  if (buf.length < 4) {
    return {
      ok: false,
      status: 422,
      error: 'Conteúdo do arquivo inválido ou truncado.',
    };
  }

  // 1. PDF signature: "%PDF-" anywhere in the first 32 bytes (allows leading BOM/whitespace)
  const pdfHead = buf.subarray(0, Math.min(32, buf.length)).toString('ascii');
  if (pdfHead.includes('%PDF-')) {
    const rawScan = buf.toString('latin1');
    if (/\/Encrypt(?:\s+\d+\s+\d+\s+R|\s*<<)/.test(rawScan)) {
      return {
        ok: false,
        status: 422,
        error:
          'Este PDF está protegido por senha ou criptografado. Remova a senha do documento ou envie uma imagem/CSV.',
      };
    }
    return {
      ok: true,
      mimeType: 'application/pdf',
      base64: strippedBase64,
      byteLength: buf.length,
    };
  }

  // 2. PNG magic bytes: 89 50 4E 47
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return {
      ok: true,
      mimeType: 'image/png',
      base64: strippedBase64,
      byteLength: buf.length,
    };
  }

  // 3. JPEG magic bytes: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return {
      ok: true,
      mimeType: 'image/jpeg',
      base64: strippedBase64,
      byteLength: buf.length,
    };
  }

  // 4. WEBP magic bytes: RIFF....WEBP
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buf.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return {
      ok: true,
      mimeType: 'image/webp',
      base64: strippedBase64,
      byteLength: buf.length,
    };
  }

  return {
    ok: false,
    status: 422,
    error:
      'Formato binário não reconhecido para leitura visual. Envie um PDF legítimo ou imagem PNG, JPG ou WEBP.',
  };
}

