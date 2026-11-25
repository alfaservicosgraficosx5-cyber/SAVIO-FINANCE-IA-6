import type { ExtractionFileFormat } from '../../types-sub/extractions';

export const MAX_EXTRACTION_FILE_BYTES = 15 * 1024 * 1024; // 15 MB

const SUPPORTED_FORMAT_BY_EXT: Record<string, ExtractionFileFormat> = {
  ofx: 'OFX',
  csv: 'CSV',
  xlsx: 'XLSX',
  xls: 'XLS',
  pdf: 'PDF',
  xml: 'XML',
  json: 'JSON',
  jpg: 'IMAGE',
  jpeg: 'IMAGE',
  png: 'IMAGE',
  webp: 'IMAGE',
};

export function detectExtractionFormat(fileName: string, mimeType = ''): ExtractionFileFormat | null {
  const ext = (fileName.split('.').pop() || '').trim().toLowerCase();
  if (ext && SUPPORTED_FORMAT_BY_EXT[ext]) {
    return SUPPORTED_FORMAT_BY_EXT[ext];
  }
  const lowerMime = mimeType.toLowerCase();
  if (lowerMime.includes('ofx')) return 'OFX';
  if (lowerMime.includes('csv')) return 'CSV';
  if (lowerMime.includes('spreadsheetml') || lowerMime.includes('ms-excel')) return 'XLSX';
  if (lowerMime === 'application/pdf') return 'PDF';
  if (lowerMime.includes('xml')) return 'XML';
  if (lowerMime.includes('json')) return 'JSON';
  if (lowerMime.startsWith('image/') && !lowerMime.includes('svg')) return 'IMAGE';
  return null;
}

export interface FileValidationResult {
  ok: boolean;
  format?: ExtractionFileFormat;
  error?: string;
}

export function validateExtractionUploadFile(file: {
  name: string;
  size: number;
  type?: string;
}): FileValidationResult {
  if (!file.name || !file.name.trim()) {
    return { ok: false, error: 'Nome de arquivo inválido.' };
  }
  if (file.size <= 0) {
    return { ok: false, error: 'O arquivo selecionado está vazio.' };
  }
  if (file.size > MAX_EXTRACTION_FILE_BYTES) {
    return {
      ok: false,
      error: `Arquivo excede o limite de ${(MAX_EXTRACTION_FILE_BYTES / (1024 * 1024)).toFixed(0)} MB.`,
    };
  }
  const format = detectExtractionFormat(file.name, file.type || '');
  if (!format) {
    return {
      ok: false,
      error:
        'Formato não suportado. Utilize OFX, CSV, XLSX, XLS, PDF, XML, JSON ou imagem (JPG, PNG, WEBP).',
    };
  }
  return { ok: true, format };
}

export function sanitizeExtractedText(input: string, maxLen = 280): string {
  return String(input || '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

export function digitsOnly(value: string): string {
  return String(value || '').replace(/\D/g, '');
}

export function validateCpfDigits(rawCpf: string): boolean {
  const cpf = digitsOnly(rawCpf);
  if (cpf.length !== 11) return false;
  if (/^(\d)\1{10}$/.test(cpf)) return false;

  let sum = 0;
  for (let i = 0; i < 9; i++) {
    sum += Number(cpf[i]) * (10 - i);
  }
  let remainder = (sum * 10) % 11;
  if (remainder === 10) remainder = 0;
  if (remainder !== Number(cpf[9])) return false;

  sum = 0;
  for (let i = 0; i < 10; i++) {
    sum += Number(cpf[i]) * (11 - i);
  }
  remainder = (sum * 10) % 11;
  if (remainder === 10) remainder = 0;
  return remainder === Number(cpf[10]);
}

export function validateCnpjDigits(rawCnpj: string): boolean {
  const cnpj = digitsOnly(rawCnpj);
  if (cnpj.length !== 14) return false;
  if (/^(\d)\1{13}$/.test(cnpj)) return false;

  const weights1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  const weights2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];

  let sum = 0;
  for (let i = 0; i < 12; i++) {
    sum += Number(cnpj[i]) * weights1[i];
  }
  let d1 = sum % 11;
  d1 = d1 < 2 ? 0 : 11 - d1;
  if (d1 !== Number(cnpj[12])) return false;

  sum = 0;
  for (let i = 0; i < 13; i++) {
    sum += Number(cnpj[i]) * weights2[i];
  }
  let d2 = sum % 11;
  d2 = d2 < 2 ? 0 : 11 - d2;
  return d2 === Number(cnpj[13]);
}

export function detectTaxDocumentNature(
  rawDoc: string
): { nature?: 'CPF' | 'CNPJ'; valid: boolean; masked?: string; normalizedDigits?: string } {
  const digits = digitsOnly(rawDoc);
  if (digits.length === 11) {
    const valid = validateCpfDigits(digits);
    return {
      nature: 'CPF',
      valid,
      masked: maskTaxDocument(digits),
      normalizedDigits: digits,
    };
  }
  if (digits.length === 14) {
    const valid = validateCnpjDigits(digits);
    return {
      nature: 'CNPJ',
      valid,
      masked: maskTaxDocument(digits),
      normalizedDigits: digits,
    };
  }
  return { valid: false };
}

export function maskTaxDocument(rawDoc?: string): string {
  const digits = digitsOnly(rawDoc || '');
  if (digits.length === 11) {
    return `***.${digits.slice(3, 6)}.${digits.slice(6, 9)}-**`;
  }
  if (digits.length === 14) {
    return `**.${digits.slice(2, 5)}.${digits.slice(5, 8)}/${digits.slice(8, 12)}-**`;
  }
  if (!rawDoc) return '';
  if (rawDoc.length <= 4) return '••••';
  return `••••${rawDoc.slice(-4)}`;
}

export function maskAccountNumber(rawAccount?: string): string {
  const cleaned = String(rawAccount || '').trim();
  if (!cleaned) return '';
  const visible = cleaned.slice(-4);
  return cleaned.length <= 4 ? `•••• ${visible}` : `•••• ${visible}`;
}

export function computeFastHash(input: string): string {
  // Deterministic 64-bit FNV-1a double hash (no Node crypto dependency in browser)
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= c + i;
    h2 = Math.imul(h2, 0x85ebca6b);
  }
  return `${(h1 >>> 0).toString(16).padStart(8, '0')}${(h2 >>> 0).toString(16).padStart(8, '0')}`;
}

export async function computeBufferFingerprint(buffer: ArrayBuffer, fileName = ''): Promise<string> {
  try {
    if (typeof crypto !== 'undefined' && crypto.subtle) {
      const digest = await crypto.subtle.digest('SHA-256', buffer);
      return Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')
        .slice(0, 32);
    }
  } catch {
    // fallback below
  }
  const bytes = new Uint8Array(buffer);
  let sample = `${fileName}|${bytes.length}|`;
  const step = Math.max(1, Math.floor(bytes.length / 512));
  for (let i = 0; i < bytes.length; i += step) {
    sample += bytes[i].toString(16);
  }
  return computeFastHash(sample);
}

export const MAX_PDF_PAGES = 50;

export function validatePdfPageCount(pageCount: number): { ok: boolean; error?: string } {
  if (!Number.isFinite(pageCount) || pageCount < 0) {
    return { ok: false, error: 'Contagem de páginas PDF inválida.' };
  }
  if (pageCount > MAX_PDF_PAGES) {
    return {
      ok: false,
      error: `PDF possui ${pageCount} páginas, excedendo o limite seguro de ${MAX_PDF_PAGES} páginas por lote.`,
    };
  }
  return { ok: true };
}

export interface BufferSignatureCheckResult {
  ok: boolean;
  detectedMime: string;
  error?: string;
}

/**
 * Inspects actual magic bytes / structural headers of an uploaded buffer to verify
 * real MIME consistency and reject disguised executables, scripts, or SVG payloads.
 */
export function inspectBufferRealMimeAndSecurity(
  buffer: ArrayBuffer,
  expectedFormat: ExtractionFileFormat
): BufferSignatureCheckResult {
  const bytes = new Uint8Array(buffer);
  if (bytes.length === 0) {
    return { ok: false, detectedMime: 'application/x-empty', error: 'Arquivo vazio.' };
  }

  // Reject Windows PE executable ("MZ") or ELF binary disguised as statement
  if ((bytes[0] === 0x4d && bytes[1] === 0x5a) || (bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46)) {
    return {
      ok: false,
      detectedMime: 'application/x-executable',
      error: 'Conteúdo binário executável não permitido para importação financeira.',
    };
  }

  const startsWithAscii = (sig: string, offset = 0): boolean => {
    if (bytes.length < offset + sig.length) return false;
    for (let i = 0; i < sig.length; i++) {
      if (bytes[offset + i] !== sig.charCodeAt(i)) return false;
    }
    return true;
  };

  if (expectedFormat === 'PDF') {
    // Allow optional leading whitespace/BOM before %PDF-
    let headerAscii = '';
    for (let i = 0; i < Math.min(32, bytes.length); i++) {
      headerAscii += String.fromCharCode(bytes[i]);
    }
    if (!headerAscii.includes('%PDF-')) {
      return {
        ok: false,
        detectedMime: 'application/octet-stream',
        error: 'Assinatura interna inválida: o arquivo não corresponde a um PDF legítimo (%PDF-).',
      };
    }
    return { ok: true, detectedMime: 'application/pdf' };
  }

  if (expectedFormat === 'IMAGE') {
    const isPng = bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
    const isJpg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    const isWebp = startsWithAscii('RIFF', 0) && startsWithAscii('WEBP', 8);
    if (!isPng && !isJpg && !isWebp) {
      return {
        ok: false,
        detectedMime: 'application/octet-stream',
        error: 'Assinatura de imagem inválida (permitidos apenas PNG, JPG/JPEG ou WEBP reais).',
      };
    }
    return {
      ok: true,
      detectedMime: isPng ? 'image/png' : isJpg ? 'image/jpeg' : 'image/webp',
    };
  }

  if (expectedFormat === 'XLSX' || expectedFormat === 'XLS') {
    const isZipXlsx = bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
    const isOleXls = bytes.length >= 4 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0;
    // Some banks (e.g. legacy BB/Santander .xls exports) output HTML tables or CSV renamed as .xls
    let headText = '';
    for (let i = 0; i < Math.min(256, bytes.length); i++) {
      headText += String.fromCharCode(bytes[i]);
    }
    const lowerHead = headText.toLowerCase();
    if (isZipXlsx) return { ok: true, detectedMime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
    if (isOleXls) return { ok: true, detectedMime: 'application/vnd.ms-excel' };
    if (expectedFormat === 'XLS' && (lowerHead.includes('<table') || lowerHead.includes(';'))) {
      return { ok: true, detectedMime: 'application/vnd.ms-excel' };
    }
    return {
      ok: false,
      detectedMime: 'application/octet-stream',
      error: 'Assinatura de planilha inválida para o arquivo XLSX/XLS enviado.',
    };
  }

  // Text-based formats: OFX, CSV, XML, JSON
  // Reject arbitrary binary files containing NUL bytes (except UTF-16 BOM text exports)
  const hasUtf16Bom =
    bytes.length >= 2 &&
    ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff));
  if (!hasUtf16Bom) {
    const scanLen = Math.min(1024, bytes.length);
    let nulCount = 0;
    for (let i = 0; i < scanLen; i++) {
      if (bytes[i] === 0) nulCount++;
    }
    if (nulCount > 2) {
      return {
        ok: false,
        detectedMime: 'application/octet-stream',
        error: `Conteúdo binário detectado em arquivo esperado como ${expectedFormat}.`,
      };
    }
  }

  let sample = '';
  for (let i = 0; i < Math.min(2048, bytes.length); i++) {
    sample += String.fromCharCode(bytes[i]);
  }
  const trimmed = sample.replace(/^\uFEFF/, '').trim();
  const lowerSample = trimmed.toLowerCase();

  if (lowerSample.includes('<svg') || lowerSample.includes('<script')) {
    return {
      ok: false,
      detectedMime: 'text/html',
      error: 'Conteúdo ativo (<script>/<svg>) bloqueado por segurança.',
    };
  }

  if (expectedFormat === 'JSON' && !trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return {
      ok: false,
      detectedMime: 'text/plain',
      error: 'Arquivo JSON inválido: estrutura deve iniciar com { ou [.',
    };
  }

  if (expectedFormat === 'XML' && !trimmed.includes('<')) {
    return {
      ok: false,
      detectedMime: 'text/plain',
      error: 'Arquivo XML inválido: estrutura XML não encontrada.',
    };
  }

  const mimeMap: Record<ExtractionFileFormat, string> = {
    OFX: 'application/x-ofx',
    CSV: 'text/csv',
    XML: 'application/xml',
    JSON: 'application/json',
    XLSX: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    XLS: 'application/vnd.ms-excel',
    PDF: 'application/pdf',
    IMAGE: 'image/jpeg',
  };

  return { ok: true, detectedMime: mimeMap[expectedFormat] };
}

export function maskCardNumber(raw?: string): string {
  const digits = digitsOnly(raw || '');
  if (!digits) return '';
  if (digits.length <= 4) return `•••• ${digits}`;
  return `•••• •••• •••• ${digits.slice(-4)}`;
}

export function maskAgencyAndAccount(agency?: string, account?: string): string {
  const maskedAg = agency ? `Ag ${agency.replace(/\d(?=\d{2})/g, '•')}` : '';
  const maskedAcc = account ? `Cc ${maskAccountNumber(account)}` : '';
  return [maskedAg, maskedAcc].filter(Boolean).join(' · ');
}

/**
 * Redacts CPF, CNPJ, 16-digit card PANs, and sensitive credentials before writing logs/audit diagnostics.
 */
export function redactSensitiveBankData(input: string): string {
  if (!input) return '';
  return String(input)
    // Formatted or plain CNPJ (14 digits)
    .replace(/\b(\d{2})[.\s]?(\d{3})[.\s]?(\d{3})[\/\s]?(\d{4})[-\s]?(\d{2})\b/g, '**.***.***/$4-**')
    // Formatted CPF (11 digits with punctuation)
    .replace(/\b(\d{3})\.(\d{3})\.(\d{3})-(\d{2})\b/g, '***.$2.***-**')
    // 16-digit card PAN (grouped or continuous)
    .replace(/\b(\d{4})[\s-]?(\d{4})[\s-]?(\d{4})[\s-]?(\d{4})\b/g, '•••• •••• •••• $4')
    // Bearer / token / password key-value patterns
    .replace(/(password|senha|token|secret|cvv)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]');
}

/**
 * Strips any sensitive banking credentials or tokens before storing raw row snapshots.
 */
export function sanitizeRawRowSnapshot(
  raw: Record<string, unknown>
): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  const forbiddenKeys = /senha|password|pin|token|seed|mnemonic|private.?key|secret|cvv/i;

  for (const [k, v] of Object.entries(raw)) {
    if (forbiddenKeys.test(k)) continue;
    if (v === null || v === undefined) {
      out[k] = null;
    } else if (typeof v === 'number' || typeof v === 'boolean') {
      out[k] = v;
    } else {
      out[k] = redactSensitiveBankData(sanitizeExtractedText(String(v), 240));
    }
  }
  return out;
}
