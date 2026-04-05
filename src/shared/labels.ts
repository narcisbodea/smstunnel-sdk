export interface SmsTunnelLabels {
  title: string;
  description: string;
  serverUrlLabel: string;
  serverUrlPlaceholder: string;
  saveButton: string;
  pairedStatus: string;
  deviceLabel: string;
  unpairButton: string;
  unpairConfirm: string;
  notPairedStatus: string;
  notPairedDescription: string;
  connectButton: string;
  scanQrPrompt: string;
  waitingForPairing: string;
  cancelButton: string;
  qrExpired: string;
  testSmsTitle: string;
  testPhonePlaceholder: string;
  testMessagePlaceholder: string;
  sendTestButton: string;
  smsSentSuccess: string;
  smsError: string;
  pairingCodeLabel: string;
  pairingCodeCopied: string;
}

export const EN_LABELS: SmsTunnelLabels = {
  title: 'SMS Configuration (SMSTunnel)',
  description: 'Connect an Android phone with the SMSTunnel app to send SMS directly from the application.',
  serverUrlLabel: 'SMSTunnel Server',
  serverUrlPlaceholder: 'https://smstunnel.io',
  saveButton: 'Save',
  pairedStatus: 'Connected',
  deviceLabel: 'Device',
  unpairButton: 'Disconnect',
  unpairConfirm: 'Are you sure you want to disconnect the SMS device?',
  notPairedStatus: 'Not connected',
  notPairedDescription: 'Scan the QR code with the SMSTunnel app on your Android phone.',
  connectButton: 'Connect phone',
  scanQrPrompt: 'Scan this QR code with the SMSTunnel app on your phone:',
  waitingForPairing: 'Waiting for connection...',
  cancelButton: 'Cancel',
  qrExpired: 'QR code has expired. Generate a new one.',
  testSmsTitle: 'Send test SMS',
  testPhonePlaceholder: 'Phone number (e.g., +1234567890)',
  testMessagePlaceholder: 'Message',
  sendTestButton: 'Send',
  smsSentSuccess: 'SMS sent successfully!',
  smsError: 'Error',
  pairingCodeLabel: 'Or enter this code in the app:',
  pairingCodeCopied: 'Code copied!',
};

export const RO_LABELS: SmsTunnelLabels = {
  title: 'Configurare SMS (SMSTunnel)',
  description: 'Conecteaza un telefon Android cu aplicatia SMSTunnel pentru a trimite SMS-uri direct din aplicatie.',
  serverUrlLabel: 'Server SMSTunnel',
  serverUrlPlaceholder: 'https://smstunnel.io',
  saveButton: 'Salveaza',
  pairedStatus: 'Conectat',
  deviceLabel: 'Dispozitiv',
  unpairButton: 'Deconecteaza',
  unpairConfirm: 'Sigur doresti sa deconectezi dispozitivul SMS?',
  notPairedStatus: 'Neconectat',
  notPairedDescription: 'Scaneaza codul QR cu aplicatia SMSTunnel de pe telefonul Android.',
  connectButton: 'Conecteaza telefon',
  scanQrPrompt: 'Scaneaza acest cod QR cu aplicatia SMSTunnel de pe telefon:',
  waitingForPairing: 'Se asteapta conectarea...',
  cancelButton: 'Anuleaza',
  qrExpired: 'Codul QR a expirat. Genereaza unul nou.',
  testSmsTitle: 'Trimite SMS de test',
  testPhonePlaceholder: 'Nr. telefon (ex: 0741234567)',
  testMessagePlaceholder: 'Mesaj',
  sendTestButton: 'Trimite',
  smsSentSuccess: 'SMS trimis cu succes!',
  smsError: 'Eroare',
  pairingCodeLabel: 'Sau introdu acest cod in aplicatie:',
  pairingCodeCopied: 'Cod copiat!',
};
