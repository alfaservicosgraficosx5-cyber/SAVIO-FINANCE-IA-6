import type { FinancialConnectorAdapter } from './connectorTypes';

/**
 * Future Open Finance Brasil / Official Bank API Connector Contract.
 * Zero fake bank logins, zero stored passwords, zero scraping.
 * Cannot execute automatic sync until user explicitly grants OAuth/Open Finance consent.
 */
export const OPEN_FINANCE_CONTRACT_CONNECTOR: FinancialConnectorAdapter = {
  id: 'conn-open-finance-br',
  name: 'Conector Open Finance Brasil (API Oficial Autorizada)',
  kind: 'OPEN_FINANCE_CONTRACT',
  defaultStatus: 'AGUARDANDO_AUTORIZACAO',
  acquisitionMethod: 'Contrato preparado para consentimento Open Finance OAuth/FAPI',
  supportedFormats: ['OPEN_FINANCE_JSON', 'OFX'],
  limitations: [
    'Aguarda homologação e consentimento oficial Open Finance Brasil por instituição.',
    'Por segurança, o sistema não solicita senhas bancárias nem realiza scraping de internet banking.',
  ],
  requiresExplicitAuthorization: true,
};

export function canExecuteOpenFinanceSync(params: {
  userAuthorized: boolean;
  consentTokenPresent?: boolean;
}): { allowed: boolean; reason?: string } {
  if (!params.userAuthorized) {
    return {
      allowed: false,
      reason: 'Sincronização Open Finance requer autorização explícita do usuário.',
    };
  }
  if (!params.consentTokenPresent) {
    return {
      allowed: false,
      reason: 'Consentimento OAuth/Open Finance não emitido para esta instituição.',
    };
  }
  return { allowed: true };
}
