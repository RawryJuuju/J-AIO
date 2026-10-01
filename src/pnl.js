const fs = require('fs');
const path = require('path');
const store = require('./store');

const PNL_DIR = path.join(__dirname, '../data/pnl');
if (!fs.existsSync(PNL_DIR)) fs.mkdirSync(PNL_DIR, { recursive: true });

function getPnlConfig() {
  const p = path.join(PNL_DIR, 'config.json');
  if (fs.existsSync(p)) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) {}
  }
  return {
    bgSlots: [
      { id: 'default', name: 'Default Dark', color: '#111827', textColor: '#ffffff' },
      { id: 'neon', name: 'Cyber Neon', color: '#0f172a', textColor: '#38bdf8' },
      { id: 'gold', name: 'Luxury Gold', color: '#1c1917', textColor: '#facc15' }
    ],
    activeSlot: 'default'
  };
}

function savePnlConfig(cfg) {
  const p = path.join(PNL_DIR, 'config.json');
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2));
  return cfg;
}

function generatePnlCardData(summaryData) {
  const cfg = getPnlConfig();
  const slot = cfg.bgSlots.find(s => s.id === cfg.activeSlot) || cfg.bgSlots[0];
  
  return {
    card: {
      theme: slot,
      soldEth: summaryData.soldEth || 0,
      holdValueEth: summaryData.holdValueEth || 0,
      gasEth: summaryData.gasEth || 0,
      netPnlEth: (summaryData.soldEth || 0) + (summaryData.holdValueEth || 0) - (summaryData.gasEth || 0),
      timestamp: new Date().toISOString()
    }
  };
}

module.exports = {
  getPnlConfig,
  savePnlConfig,
  generatePnlCardData
};
