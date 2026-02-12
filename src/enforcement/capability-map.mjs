export const CAPABILITIES = Object.freeze({
  EXECUTE_COMMAND: {
    allowed: true,
    maxRisk: 'MEDIUM',
  },

  FILE_ACCESS: {
    allowed: true,
    allowedPaths: Object.freeze(['./claw-workspace']),
  },

  BROWSER_ACTION: {
    allowed: true,
    allowNavigation: true,
    allowDownload: false,
    allowUpload: false,
  },
});

