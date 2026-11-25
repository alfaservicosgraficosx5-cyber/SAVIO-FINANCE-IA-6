import type { FinancialConnectorAdapter } from './connectorTypes';

export const GOOGLE_WORKSPACE_STATEMENTS_CONNECTOR: FinancialConnectorAdapter = {
  id: 'conn-google-workspace',
  name: 'Google Workspace (Gmail & Google Drive / Sheets)',
  kind: 'GOOGLE_WORKSPACE',
  defaultStatus: 'AGUARDANDO_AUTORIZACAO',
  acquisitionMethod: 'OAuth 2.0 oficial (somente leitura autorizada pelo usuário)',
  supportedFormats: ['PDF', 'CSV', 'XLSX', 'OFX', 'GOOGLE_SHEETS'],
  limitations: [
    'Requer autorização OAuth 2.0 explícita no navegador.',
    'Nenhuma senha ou token permanente é armazenado no servidor.',
  ],
  requiresExplicitAuthorization: true,
};
